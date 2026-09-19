import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { desktopPaths, openDesktopInstallation } from '../server/desktop-paths.ts';
import { assertDesktopMigrationStartup, cutoverDocument, cutoverJournalPath, cutoverJournalSchema } from '../server/desktop-migration-cutover.ts';
import { desktopMigrationPreparationReceiptSchema } from './prepare-desktop-migration.ts';
import { readOperatingWorkspaceExport } from './export-operating-workspace.ts';
import { desktopGitHubConfigSchema, inspectOperatingGitHub } from '../server/desktop-github.ts';
import { readDesktopProviderFile, verifyPinnedDesktopPayloadFile } from '../server/desktop-provider-files.ts';
import { GitHubAppAuth, readGitHubConfig } from '../server/github-auth.ts';
import { GitHubTransport } from '../server/github-transport.ts';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';
import { existingStorageDirectory } from '../server/storage.ts';
import { stableRuntimeHash } from '../shared/runtime-releases.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/), absolute = z.string().refine(isAbsolute);
const optionsSchema = z.object({ sourceRoot: absolute, appDataRoot: absolute, resourceRoot: absolute,
  preparation: absolute, preparationSha256: digest, expectedSourceStateSha256: digest, receipt: absolute,
  approval: z.literal('approve-current-source-grants') }).strict();
export type CurrentGrantsOptions = z.infer<typeof optionsSchema>;
const fail = () => new Error('CURRENT_SOURCE_GITHUB_GRANTS_INVALID');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function exists(path: string) { return lstat(path).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }); }
async function writeNew(path: string, value: unknown) {
  await existingStorageDirectory(dirname(path)); const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}
async function stateSnapshot(path: string, expectedSha256: string): Promise<WorkspaceState> {
  await existingStorageDirectory(dirname(path)); const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024 ** 2) throw fail();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat(); if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size || info.nlink !== 1) throw fail();
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) { const part = await file.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) throw fail(); offset += part.bytesRead; }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || hash(bytes) !== expectedSha256) throw fail();
    return JSON.parse(bytes.toString('utf8')) as WorkspaceState;
  } finally { await file.close(); }
}
type Scope = WorkspaceState['connections'][number];
export interface CurrentGrantsProof {
  sourceState: WorkspaceState; sourceDb: string; targetDb: string; sourceOwner: string; targetOwner: string;
  cutoverId: string; generationId: string; proofSha256: string;
  config: z.infer<typeof desktopGitHubConfigSchema>;
}
interface Store { read(): Promise<WorkspaceState>; change<T>(mutate: (state: WorkspaceState) => T): Promise<T>; close(): Promise<void> }
export interface CurrentGrantsDependencies {
  lockSource?: (root: string) => Promise<() => Promise<void>>;
  lockTarget?: (paths: ReturnType<typeof desktopPaths>) => Promise<{ workspaceKey: string; release(): Promise<void> }>;
  proof?: (options: CurrentGrantsOptions, owner: string) => Promise<CurrentGrantsProof>;
  openStore?: (path: string) => Promise<Store>;
  verifyRepository?: (connection: Scope, proof: CurrentGrantsProof) => Promise<{ id: number; fullName: string; defaultBranch: string; access: 'read' | 'write' }>;
  afterStateCommit?: () => Promise<void>;
}

/** No account operations or DB access. Every existing installed source capsule,
 * preparation and journal binding is checked before either DB is opened. */
async function readProof(options: CurrentGrantsOptions, targetOwner: string): Promise<CurrentGrantsProof> {
  const paths = desktopPaths(options.resourceRoot, options.appDataRoot);
  await assertDesktopMigrationStartup(paths.appDataRoot, targetOwner);
  const cutoverDoc = await cutoverDocument(cutoverJournalPath(paths.appDataRoot));
  const cutover = cutoverJournalSchema.parse(cutoverDoc.value);
  if (cutover.preparationSha256 !== options.preparationSha256 || resolve(cutover.preparationPath) !== resolve(options.preparation)
    || resolve(cutover.sourceRoot) !== resolve(options.sourceRoot)) throw fail();
  const prepDoc = await cutoverDocument(options.preparation); if (prepDoc.sha256 !== options.preparationSha256) throw fail();
  const prep = desktopMigrationPreparationReceiptSchema.parse(prepDoc.value);
  if (prep.target.ownerKey !== targetOwner || prep.prepared.id !== cutover.generationId
    || prep.source.ownerKey !== cutover.sourceOwner || resolve(prep.target.appDataRoot) !== paths.appDataRoot) throw fail();
  const source = await readOperatingWorkspaceExport(prep.source.directory, prep.source.receiptSha256);
  if (source.receipt.source.ownerKey !== cutover.sourceOwner || source.backup.manifestSha256 !== prep.source.manifestSha256
    || source.receipt.backup.stateSha256 !== options.expectedSourceStateSha256) throw fail();
  const sourceState = await stateSnapshot(join(source.backup.directory, 'state.json'), options.expectedSourceStateSha256);
  for (const file of source.receipt.sourceFiles) await verifyPinnedDesktopPayloadFile(join(options.sourceRoot, file.path.slice('source/'.length)), file);
  if (!source.receipt.sourceFiles.some(file => file.path === 'source/storage-layout.json') && await exists(join(options.sourceRoot, 'storage-layout.json'))) throw fail();
  const generation = join(paths.dataDir, 'generations', cutover.generationId);
  if ((await cutoverDocument(join(generation, 'migration-receipt.json'))).sha256 !== prep.prepared.migrationReceiptSha256
    || (await cutoverDocument(join(generation, 'migration-runtime.json'))).sha256 !== prep.prepared.runtimeSha256) throw fail();
  const configDoc = await cutoverDocument(join(paths.appDataRoot, 'desktop-github.json'));
  const config = desktopGitHubConfigSchema.parse(configDoc.value);
  if (config.ownerKey !== targetOwner) throw fail();
  const migration = (await cutoverDocument(join(paths.appDataRoot, 'desktop-github-migration.json'))).value;
  const original = await inspectOperatingGitHub(options.sourceRoot), target = await inspectOperatingGitHub(paths.dataDir);
  if (migration.cutoverId !== cutover.id || migration.ownerKey !== targetOwner || migration.sourceOwner !== cutover.sourceOwner
    || migration.sourceSha256 !== original.sha256 || migration.journalIdentity !== original.anchor.journalIdentity
    || target.anchor.journalIdentity !== original.anchor.journalIdentity || target.anchor.ownerKey !== targetOwner
    || original.anchor.ownerKey !== cutover.sourceOwner || config.appId !== original.anchor.appId
    || config.installationId !== original.anchor.installationId || target.files.length !== original.files.length) throw fail();
  for (const file of original.files) {
    const expected = Buffer.from(JSON.stringify({ ...JSON.parse(file.bytes.toString('utf8')), ownerKey: targetOwner }));
    const actual = target.files.find(item => item.path === file.path);
    if (!actual || !actual.bytes.equals(expected)) throw fail();
  }
  return { sourceState,
    sourceDb: join(options.sourceRoot, ...(source.receipt.source.activeId ? ['generations', source.receipt.source.activeId] : []), 'db'),
    targetDb: join(generation, 'db'), sourceOwner: cutover.sourceOwner, targetOwner, cutoverId: cutover.id, generationId: cutover.generationId,
    config, proofSha256: stableRuntimeHash({ cutover: cutoverDoc.sha256, preparation: prepDoc.sha256, sourceReceipt: prep.source.receiptSha256,
      state: options.expectedSourceStateSha256, config: configDoc.sha256, sourceJournal: original.sha256, targetJournal: target.sha256 }) };
}

/** Only the documented generic-import disconnect transform may differ. */
export function assertUnmodifiedImportedGitHub(source: WorkspaceState, target: WorkspaceState) {
  if (!target.operatorPaused) throw fail();
  const expected = structuredClone(source), removed = new Set<string>(); expected.operatorPaused = true;
  for (const connection of expected.connections) {
    if (!connection.github && connection.grants === undefined) continue;
    removed.add(connection.id); const actual = target.connections.find(item => item.id === connection.id); if (!actual) throw fail();
    if (connection.github) {
      if (actual.github?.status !== 'disconnected' || !z.uuid().safeParse(actual.github.generation).success
        || actual.github.generation === connection.github.generation) throw fail();
      connection.github = { ...connection.github, status: 'disconnected', generation: actual.github.generation };
    }
    connection.grants = []; connection.version = (connection.version ?? 0) + 1;
  }
  for (const agent of expected.agents) {
    const retained = agent.repositoryIds.filter(id => !removed.has(id));
    if (retained.length === agent.repositoryIds.length) continue;
    const actual = target.agents.find(item => item.id === agent.id); if (!actual || !z.iso.datetime().safeParse(actual.updatedAt).success) throw fail();
    agent.repositoryIds = retained; agent.version += 1; agent.updatedAt = actual.updatedAt;
  }
  if (stableRuntimeHash(expected) !== stableRuntimeHash(target)) throw fail();
}

async function verifyRepository(connection: Scope, proof: CurrentGrantsProof) {
  const config = proof.config;
  const auth = new GitHubAppAuth(readGitHubConfig({ AGENT_GITHUB_APP_ID: config.appId, AGENT_GITHUB_INSTALLATION_ID: config.installationId,
    AGENT_GITHUB_PRIVATE_KEY_FILE: config.privateKeyFile, AGENT_GITHUB_REPOSITORIES: config.repositories.join(',') },
    { forbiddenRoots: [dirname(proof.sourceDb), dirname(proof.targetDb)] }));
  const signal = AbortSignal.timeout(60_000), access = connection.access === 'write' && connection.grants?.some(g => g.access === 'write') ? 'write' as const : 'read' as const;
  // Token issuance validates the exact App, installation, repository ID and
  // contents/pull_requests/metadata permissions. No business write follows.
  const token = await auth.token(connection.repository, access, signal, connection.github!.repositoryId!);
  const transport = new GitHubTransport({ token: async () => token });
  return { ...await transport.inspect(connection.repository, signal), access };
}
const intentSchema = z.object({ version: z.literal(1), kind: z.literal('verified-current-source-github-grants'), approval: z.literal('approve-current-source-grants'),
  proofSha256: digest, sourceStateSha256: digest, sourceSemanticSha256: digest, targetBeforeSha256: digest, targetAfterSha256: digest,
  cutoverId: z.uuid(), sourceOwner: z.uuid(), targetOwner: z.uuid(), generationId: z.uuid(), verifiedAt: z.iso.datetime(),
  connections: z.array(z.object({ id: z.uuid(), repository: z.string(), repositoryId: z.number().int().positive(), defaultBranch: z.string(),
    generation: z.uuid(), access: z.enum(['read', 'write']) }).strict()) }).strict();

async function verifyCurrentRepositories(proof: CurrentGrantsProof, dependencies: CurrentGrantsDependencies) {
  const verified: z.infer<typeof intentSchema>['connections'] = [];
  for (const connection of proof.sourceState.connections.filter(c => c.github?.status === 'connected')) {
    if (!proof.config.repositories.includes(connection.repository.toLowerCase()) || !connection.github?.repositoryId || !connection.github.defaultBranch) throw fail();
    const result = await (dependencies.verifyRepository ?? verifyRepository)(connection, proof);
    const required = connection.access === 'write' && connection.grants?.some(g => g.access === 'write') ? 'write' : 'read';
    if (result.id !== connection.github.repositoryId || result.fullName.toLowerCase() !== connection.repository.toLowerCase()
      || result.defaultBranch !== connection.github.defaultBranch || result.access !== required) throw fail();
    verified.push({ id: connection.id, repository: connection.repository, repositoryId: result.id,
      defaultBranch: result.defaultBranch, generation: connection.github.generation, access: result.access });
  }
  return verified;
}

export async function migrateCurrentGitHubGrants(raw: CurrentGrantsOptions, dependencies: CurrentGrantsDependencies = {}) {
  const options = optionsSchema.parse(raw), paths = desktopPaths(options.resourceRoot, options.appDataRoot);
  const unlock = await (dependencies.lockSource ?? (root => lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30000, update: 10000, retries: 0 })))(options.sourceRoot);
  let installation: Awaited<ReturnType<typeof openDesktopInstallation>> | undefined;
  const stores = new Set<Store>(); let uncertain = false;
  const openStore = async (path: string) => {
    await existingStorageDirectory(path); await readDesktopProviderFile(join(path, 'PG_VERSION'), 32);
    try { const store = await (dependencies.openStore ?? WorkspaceStore.open)(path); stores.add(store); return store; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'SERVICE_STARTUP_CLEANUP_PENDING') uncertain = true; throw error; }
  };
  const closeStore = async (store: Store) => { try { await store.close(); stores.delete(store); } catch (error) { uncertain = true; throw error; } };
  try {
    installation = await (dependencies.lockTarget ?? openDesktopInstallation)(paths);
    const proof = await (dependencies.proof ?? readProof)(options, installation.workspaceKey);
    if (proof.targetOwner !== installation.workspaceKey) throw fail();
    const sourceStore = await openStore(proof.sourceDb), targetStore = await openStore(proof.targetDb);
    const sourceHash = stableRuntimeHash(proof.sourceState);
    if (stableRuntimeHash(await sourceStore.read()) !== sourceHash) throw fail();
    const before = await targetStore.read(); if (!before.operatorPaused) throw fail();
    let intent: z.infer<typeof intentSchema>; let existingIntent = false;
    if (await exists(options.receipt)) {
      existingIntent = true;
      intent = intentSchema.parse((await cutoverDocument(options.receipt)).value);
      if (intent.proofSha256 !== proof.proofSha256 || intent.sourceStateSha256 !== options.expectedSourceStateSha256
        || intent.sourceSemanticSha256 !== sourceHash || intent.cutoverId !== proof.cutoverId || intent.targetOwner !== proof.targetOwner
        || intent.sourceOwner !== proof.sourceOwner || intent.generationId !== proof.generationId) throw fail();
      const actual = stableRuntimeHash(before);
      if (actual !== intent.targetBeforeSha256 && actual !== intent.targetAfterSha256) throw fail();
    } else {
      assertUnmodifiedImportedGitHub(proof.sourceState, before);
      const verified = await verifyCurrentRepositories(proof, dependencies);
      // Source and target are still exactly the state inspected before all network checks.
      if (stableRuntimeHash(await sourceStore.read()) !== sourceHash || stableRuntimeHash(await targetStore.read()) !== stableRuntimeHash(before)) throw fail();
      const refreshed = await (dependencies.proof ?? readProof)(options, installation.workspaceKey);
      if (refreshed.proofSha256 !== proof.proofSha256) throw fail();
      const verifiedAt = new Date().toISOString(), after = restoredState(proof.sourceState, before, verifiedAt);
      intent = intentSchema.parse({ version: 1, kind: 'verified-current-source-github-grants', approval: options.approval,
        proofSha256: proof.proofSha256, sourceStateSha256: options.expectedSourceStateSha256, sourceSemanticSha256: sourceHash,
        targetBeforeSha256: stableRuntimeHash(before), targetAfterSha256: stableRuntimeHash(after), cutoverId: proof.cutoverId,
        sourceOwner: proof.sourceOwner, targetOwner: proof.targetOwner, generationId: proof.generationId, verifiedAt, connections: verified });
      await writeNew(options.receipt, intent);
    }
    if (stableRuntimeHash(before) === intent.targetBeforeSha256) {
      // The immutable intent makes a crash after state commit distinguishable.
      assertUnmodifiedImportedGitHub(proof.sourceState, before);
      const after = restoredState(proof.sourceState, before, intent.verifiedAt);
      if (stableRuntimeHash(after) !== intent.targetAfterSha256) throw fail();
      if (Date.now() - Date.parse(intent.verifiedAt) > 10 * 60_000) throw fail();
      if (existingIntent) {
        // An earlier intent is evidence, never a cache of external authority.
        // A failed state transaction may be retried after permissions changed.
        const verified = await verifyCurrentRepositories(proof, dependencies);
        if (stableRuntimeHash(verified) !== stableRuntimeHash(intent.connections)
          || stableRuntimeHash(await sourceStore.read()) !== sourceHash
          || stableRuntimeHash(await targetStore.read()) !== intent.targetBeforeSha256) throw fail();
        const refreshed = await (dependencies.proof ?? readProof)(options, installation.workspaceKey);
        if (refreshed.proofSha256 !== proof.proofSha256) throw fail();
        await writeNew(`${options.receipt}.revalidation-${randomUUID()}.json`, {
          version: 1, intentSha256: (await cutoverDocument(options.receipt)).sha256,
          proofSha256: proof.proofSha256, verifiedAt: new Date().toISOString(), connections: verified,
        });
      }
      await targetStore.change(state => {
        if (stableRuntimeHash(state) !== intent.targetBeforeSha256) throw fail();
        state.connections = after.connections; state.agents = after.agents;
        if (stableRuntimeHash(state) !== intent.targetAfterSha256) throw fail();
      });
      await dependencies.afterStateCommit?.();
    }
    if (stableRuntimeHash(await targetStore.read()) !== intent.targetAfterSha256 || stableRuntimeHash(await sourceStore.read()) !== sourceHash) throw fail();
    await closeStore(targetStore); await closeStore(sourceStore);
    const completion = { version: 1, intentSha256: (await cutoverDocument(options.receipt)).sha256, targetStateSha256: intent.targetAfterSha256,
      sourceUnchanged: true, paused: true, businessWrites: 0 };
    const completedPath = `${options.receipt}.committed.json`;
    if (await exists(completedPath)) {
      if (stableRuntimeHash((await cutoverDocument(completedPath)).value) !== stableRuntimeHash(completion)) throw fail();
    } else await writeNew(completedPath, completion);
    return { ...completion, connections: intent.connections.length, receipt: options.receipt };
  } finally {
    for (const store of stores) try { await closeStore(store); } catch { uncertain = true; }
    if (!uncertain && !stores.size) { try { await installation?.release(); } finally { await unlock(); } }
  }
}
function restoredState(source: WorkspaceState, target: WorkspaceState, at: string) {
  const result = structuredClone(target), restored = new Set<string>();
  for (const original of source.connections) {
    if (original.github?.status !== 'connected') continue;
    const current = result.connections.find(c => c.id === original.id); if (!current) throw fail();
    current.github = { ...original.github, verifiedAt: at }; current.grants = structuredClone(original.grants ?? []);
    current.version = (current.version ?? 0) + 1; restored.add(original.id);
  }
  for (const original of source.agents) {
    const current = result.agents.find(a => a.id === original.id); if (!current) throw fail();
    const restoredIds = original.repositoryIds.filter(id => restored.has(id)); if (!restoredIds.length) continue;
    current.repositoryIds = original.repositoryIds.filter(id => current.repositoryIds.includes(id) || restored.has(id));
    current.version += 1; current.updatedAt = at;
  }
  return result;
}

export function currentGrantsArguments(args: string[]): CurrentGrantsOptions {
  const values: Record<string, string> = {}, names: Record<string, string> = { '--source-root': 'sourceRoot', '--app-data-root': 'appDataRoot',
    '--resources-root': 'resourceRoot', '--preparation': 'preparation', '--preparation-sha256': 'preparationSha256',
    '--expected-source-state-sha256': 'expectedSourceStateSha256', '--receipt': 'receipt' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--approve-current-source-grants') { if (values.approval) throw fail(); values.approval = 'approve-current-source-grants'; continue; }
    const name = names[args[i]], value = args[++i]; if (!name || !value || value.startsWith('--') || values[name]) throw fail(); values[name] = value;
  }
  return optionsSchema.parse(values);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await migrateCurrentGitHubGrants(currentGrantsArguments(process.argv.slice(2)))) + '\n'); }
  catch { process.stderr.write('CURRENT_SOURCE_GITHUB_GRANTS_INVALID\n'); process.exitCode = 1; }
}
