import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { desktopMigrationPreparationReceiptSchema } from './prepare-desktop-migration.ts';
import { readOperatingWorkspaceExport } from './export-operating-workspace.ts';
import { parseDesktopPayloadManifest } from './desktop-payload.ts';
import { readDesktopProviderFile, verifyPinnedDesktopPayloadFile } from '../server/desktop-provider-files.ts';
import { desktopPaths, openDesktopInstallation } from '../server/desktop-paths.ts';
import { desktopRuntimeSettings } from '../server/desktop-runtime-settings.ts';
import { createDesktopRuntimeContext } from '../server/desktop-runtime-factory.ts';
import { loadDesktopMigrationRuntime } from '../server/desktop-migration-runtime.ts';
import { assertDesktopMigrationStartup, cutoverDocument, cutoverJournalPath, cutoverJournalSchema, desktopMigrationCutoverCapability,
  sourceFencePath, verifyCutoverFence, type CutoverJournal } from '../server/desktop-migration-cutover.ts';
import { activeStorage, atomicJson, existingStorageDirectory, loadStorageLayout, StorageCleanupUncertainError, StorageManager, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { ServiceStartupCleanupError } from '../server/startup-cleanup.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { stableRuntimeHash } from '../shared/runtime-releases.ts';
import type { RuntimeDriver } from '../shared/types.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/), path = z.string().refine(isAbsolute);
const optionsSchema = z.object({ preparation: path, preparationSha256: digest, sourceRoot: path,
  payloadManifest: path, payloadManifestSha256: digest, entrySha256: digest, controllerSha256: digest }).strict();
export type ActivateDesktopMigrationOptions = z.infer<typeof optionsSchema>;
const fail = () => new Error('DESKTOP_MIGRATION_ACTIVATION_INVALID');
async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
async function writeNew(path: string, value: unknown) {
  await existingStorageDirectory(dirname(path)); const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
async function stateSnapshot(path: string, sha256: string) {
  await existingStorageDirectory(dirname(path)); const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024 ** 2) throw fail();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat(); if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) throw fail();
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) throw fail(); offset += part.bytesRead; }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
      || createHash('sha256').update(bytes).digest('hex') !== sha256) throw fail();
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}
export async function verifyInstalledMigrationPayload(options: ActivateDesktopMigrationOptions, resourceRoot: string) {
  const file = await readDesktopProviderFile(options.payloadManifest, 2 * 1024 ** 2);
  if (file.pin.sha256 !== options.payloadManifestSha256) throw fail();
  const manifest = parseDesktopPayloadManifest(file.data);
  for (const [name, sha256] of [['desktop-entry.js', options.entrySha256], ['desktop-controller.js', options.controllerSha256]]) {
    if (!manifest.files.some(member => member.path === `resources/server/${name}` && member.sha256 === sha256)) throw fail();
  }
  if (!manifest.files.some(member => member.path === 'resources/server/desktop-migration-cutover.js')) throw fail();
  // Installed resources may live under a different native prefix than the build payload.
  for (const member of manifest.files.filter(member => member.path.startsWith('resources/'))) {
    await verifyPinnedDesktopPayloadFile(join(resourceRoot, member.path.slice('resources/'.length)), member);
  }
  const entry = (await readDesktopProviderFile(join(resourceRoot, 'server', 'desktop-entry.js'), 1024 ** 2)).data.toString('utf8');
  const guard = (await readDesktopProviderFile(join(resourceRoot, 'server', 'desktop-migration-cutover.js'), 1024 ** 2)).data.toString('utf8');
  if (!entry.includes('desktopMigrationCutoverCapability') || !guard.includes(desktopMigrationCutoverCapability)) throw fail();
}
export interface ActivateDesktopMigrationDependencies {
  openStore?: typeof WorkspaceStore.open;
  createRuntime?: (options: Parameters<typeof createDesktopRuntimeContext>[0]) => Promise<RuntimeDriver>;
  freeSpace?: StorageConfig['freeSpace'];
  afterPhase?: (phase: CutoverJournal['phase']) => Promise<void>;
}

/** Offline forward-only cutover. Every failure preserves the fence, journal, old DB and rollback export. */
export async function activateDesktopMigration(raw: ActivateDesktopMigrationOptions, dependencies: ActivateDesktopMigrationDependencies = {}) {
  const options = optionsSchema.parse(raw), preparationDocument = await cutoverDocument(options.preparation);
  if (preparationDocument.sha256 !== options.preparationSha256) throw fail();
  const preparation = desktopMigrationPreparationReceiptSchema.parse(preparationDocument.value);
  if (preparation.budget.plannedDailyLimit !== 200) throw fail();
  const paths = desktopPaths(preparation.target.resourceRoot, preparation.target.appDataRoot);
  await existingStorageDirectory(options.sourceRoot);
  if (resolve(options.sourceRoot) === paths.dataDir || preparation.source.ownerKey === preparation.target.ownerKey) throw fail();
  await verifyInstalledMigrationPayload(options, paths.resourceRoot);
  const sourceUnlock = await lockfile.lock(options.sourceRoot, { lockfilePath: join(options.sourceRoot, 'controller.lock'),
    stale: 30_000, update: 10_000, retries: 0 });
  let installation: Awaited<ReturnType<typeof openDesktopInstallation>> | undefined;
  const stores = new Set<WorkspaceStore>(); let cleanupUncertain = false;
  const openStore = async (directory: string) => {
    await existingStorageDirectory(directory);
    await readDesktopProviderFile(join(directory, 'PG_VERSION'), 32);
    const store = await (dependencies.openStore ?? WorkspaceStore.open)(directory); stores.add(store); return store;
  };
  const closeStore = async (store: WorkspaceStore) => { await store.close(); stores.delete(store); };
  try {
    installation = await openDesktopInstallation(paths);
    if (installation.workspaceKey !== preparation.target.ownerKey) throw fail();
    const journalPath = cutoverJournalPath(paths.appDataRoot);
    let journal: CutoverJournal;
    if (await exists(journalPath)) {
      journal = cutoverJournalSchema.parse((await cutoverDocument(journalPath)).value);
      if (journal.preparationSha256 !== options.preparationSha256 || journal.preparationPath !== options.preparation
        || resolve(journal.sourceRoot) !== resolve(options.sourceRoot) || journal.targetRoot !== paths.appDataRoot
        || journal.targetOwner !== preparation.target.ownerKey || journal.sourceOwner !== preparation.source.ownerKey
        || journal.generationId !== preparation.prepared.id || journal.workspaceKey !== preparation.prepared.workspaceKey
        || journal.payloadManifestSha256 !== options.payloadManifestSha256 || journal.entrySha256 !== options.entrySha256
        || journal.controllerSha256 !== options.controllerSha256) throw fail();
      if (journal.phase === 'committed') { await assertDesktopMigrationStartup(paths.appDataRoot, installation.workspaceKey); return journal; }
    } else {
      if (await exists(sourceFencePath(options.sourceRoot))) throw fail();
      journal = cutoverJournalSchema.parse({ version: 1, id: randomUUID(), phase: 'validated', sourceRoot: resolve(options.sourceRoot),
        sourceOwner: preparation.source.ownerKey, targetRoot: paths.appDataRoot, targetOwner: preparation.target.ownerKey,
        generationId: preparation.prepared.id, workspaceKey: preparation.prepared.workspaceKey,
        preparationPath: options.preparation, preparationSha256: options.preparationSha256,
        payloadManifestPath: options.payloadManifest, payloadManifestSha256: options.payloadManifestSha256,
        entrySha256: options.entrySha256, controllerSha256: options.controllerSha256,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    const advance = async (phase: CutoverJournal['phase']) => {
      journal = { ...journal, phase, updatedAt: new Date().toISOString() };
      await atomicJson(journalPath, journal); await dependencies.afterPhase?.(phase);
    };
    const source = await readOperatingWorkspaceExport(preparation.source.directory, preparation.source.receiptSha256);
    if (source.receipt.source.ownerKey !== journal.sourceOwner || source.backup.backupId !== preparation.source.backupId
      || source.backup.manifestSha256 !== preparation.source.manifestSha256 || source.budget.ledgerSha256 !== preparation.budget.sourceLedgerSha256) throw fail();
    // Revalidate original metadata and ledger under the source lease; no stale export can be activated.
    for (const member of source.receipt.sourceFiles) {
      await verifyPinnedDesktopPayloadFile(join(options.sourceRoot, member.path.slice('source/'.length)), member);
    }
    if (!source.receipt.sourceFiles.some(member => member.path === 'source/storage-layout.json')
      && await exists(join(options.sourceRoot, 'storage-layout.json'))) throw fail();
    if (await exists(join(options.sourceRoot, 'runtime-release.pending.json'))) throw fail();
    const sourceBudget = await OperationalModelBudget.exportMigration({ directory: join(options.sourceRoot, 'operational-budget'), ownerKey: journal.sourceOwner });
    if (JSON.stringify(sourceBudget) !== JSON.stringify(source.budget)) throw fail();
    const config: StorageConfig = { rootDir: paths.dataDir, backupDir: paths.backupDir, ownerKey: journal.targetOwner,
      ...(dependencies.freeSpace ? { freeSpace: dependencies.freeSpace } : {}) };
    const settings = await desktopRuntimeSettings(paths.appDataRoot, journal.targetOwner).read();
    if (!settings.selection || settings.revision !== preparation.target.settingsRevision) throw fail();
    const layout = await loadStorageLayout(config), alreadyActive = layout.activeId === journal.generationId;
    if (!alreadyActive && layout.activeId !== preparation.target.previousActive.id) throw fail();
    const generation = join(paths.dataDir, 'generations', journal.generationId);
    const staged = join(paths.dataDir, 'storage-tmp', journal.generationId);
    const candidate = alreadyActive || !await exists(staged) ? generation : staged;
    if (resolve(preparation.prepared.directory) !== staged) throw fail();
    const migrationReceipt = await cutoverDocument(join(candidate, 'migration-receipt.json'));
    if (migrationReceipt.sha256 !== preparation.prepared.migrationReceiptSha256
      || migrationReceipt.value.targetOwnerKey !== journal.targetOwner || migrationReceipt.value.workspaceKey !== journal.workspaceKey
      || migrationReceipt.value.generationId !== journal.generationId || migrationReceipt.value.source.manifestSha256 !== preparation.source.manifestSha256) throw fail();
    if ((await cutoverDocument(join(candidate, 'migration-runtime.json'))).sha256 !== preparation.prepared.runtimeSha256) throw fail();
    const historical = await loadDesktopMigrationRuntime(candidate, journal.targetOwner, journal.workspaceKey);
    const runtimeOptions = { paths, ownerKey: journal.targetOwner, workspaceKey: journal.workspaceKey, selection: settings.selection, ...historical };
    const runtime = dependencies.createRuntime ? await dependencies.createRuntime(runtimeOptions) : (await createDesktopRuntimeContext(runtimeOptions)).runtime;
    const assertIdle = async () => {
      const sourceLayout = await loadStorageLayout({ rootDir: options.sourceRoot, backupDir: preparation.source.directory, ownerKey: journal.sourceOwner });
      for (const key of new Set([journal.sourceOwner, source.receipt.source.workspaceKey, journal.targetOwner, journal.workspaceKey,
        preparation.target.previousActive.workspaceKey, ...layout.generations.map(item => item.workspaceKey),
        ...sourceLayout.generations.map(item => item.workspaceKey), ...sourceLayout.restores.map(item => item.workspaceKey)])) {
        const scoped = runtime.forkWorkspace?.(key); if (!scoped?.confirmDeploymentIdle) throw fail(); await scoped.confirmDeploymentIdle();
      }
    };
    await assertIdle();
    const sourceData = source.receipt.source.activeId ? join(options.sourceRoot, 'generations', source.receipt.source.activeId) : options.sourceRoot;
    const sourceStore = await openStore(join(sourceData, 'db'));
    const backupState = await stateSnapshot(join(source.backup.directory, 'state.json'), source.receipt.backup.stateSha256);
    if (stableRuntimeHash(await sourceStore.read()) !== stableRuntimeHash(backupState)) throw fail();
    await closeStore(sourceStore);
    const previousData = preparation.target.previousActive.id ? join(paths.dataDir, 'generations', preparation.target.previousActive.id) : paths.dataDir;
    const previousStore = await openStore(join(previousData, 'db'));
    const rollbackState = await stateSnapshot(join(preparation.rollback.directory, 'state.json'), preparation.rollback.stateSha256);
    if (stableRuntimeHash(await previousStore.read()) !== stableRuntimeHash(rollbackState)) throw fail();
    const manager = new StorageManager(config, () => ({ store: previousStore, runtime, dataDir: previousData }));
    await manager.inspectExternalBackup({ directory: preparation.rollback.directory, ownerKey: journal.targetOwner,
      backupId: preparation.rollback.backupId, manifestSha256: preparation.rollback.manifestSha256 });
    if (!alreadyActive) await manager.initialize();
    // The first inspection is only admission. Recheck while both controllers
    // are leased, immediately before publishing intent or retiring the source.
    await verifyInstalledMigrationPayload(options, paths.resourceRoot);
    if (!await exists(journalPath)) await writeNew(journalPath, journal);
    if (journal.phase === 'validated') {
      const fence = { version: 1, cutoverId: journal.id, sourceOwner: journal.sourceOwner, targetRoot: journal.targetRoot,
        targetOwner: journal.targetOwner, preparationSha256: journal.preparationSha256 };
      if (!await exists(sourceFencePath(options.sourceRoot))) await writeNew(sourceFencePath(options.sourceRoot), fence);
      await verifyCutoverFence(journal); await advance('source-fenced');
    } else await verifyCutoverFence(journal);
    // Check the original bytes before open() can migrate a legacy target ledger.
    if (journal.phase === 'source-fenced') {
      const ledger = (await cutoverDocument(join(paths.dataDir, 'operational-budget', 'ledger.json'))).value;
      if (!ledger.usageImports?.length && !await exists(join(paths.dataDir, 'operational-budget', 'ledger.import.pending.json'))) {
        const target = await OperationalModelBudget.exportMigration({ directory: join(paths.dataDir, 'operational-budget'), ownerKey: journal.targetOwner });
        if (target.identity !== preparation.budget.targetIdentity || target.ledgerSha256 !== preparation.budget.targetLedgerSha256) throw fail();
      }
    }
    const budget = await OperationalModelBudget.open({ directory: join(paths.dataDir, 'operational-budget'), ownerKey: journal.targetOwner });
    // The import operation itself is idempotent after a crash before the journal transition.
    await budget.importMigration(source.budget, { sourceOwnerKey: journal.sourceOwner, sourceLedgerSha256: preparation.budget.sourceLedgerSha256,
      expectedRevision: preparation.budget.targetRevision, approvedDailyLimit: 200, expectedSourceDailyLimit: preparation.budget.sourceDailyLimit });
    if ((await budget.status()).dailyLimit !== 200) throw fail();
    if (journal.phase === 'source-fenced') await advance('budget-imported');
    if (!alreadyActive) {
      if (journal.phase !== 'budget-imported') throw fail();
      await assertIdle();
      const next = await manager.activate(journal.generationId, { journalSha256: (await cutoverDocument(journalPath)).sha256 });
      stores.add(next.store); if (!(await next.store.read()).operatorPaused) throw fail(); await closeStore(next.store);
    } else if (journal.phase === 'validated' || journal.phase === 'source-fenced') throw fail();
    await closeStore(previousStore);
    const selected = await activeStorage(config);
    if (selected.workspaceKey !== journal.workspaceKey || selected.dataDir !== generation) throw fail();
    if (journal.phase !== 'generation-activated') await advance('generation-activated');
    await assertIdle(); await advance('committed');
    await assertDesktopMigrationStartup(paths.appDataRoot, journal.targetOwner);
    return journal;
  } catch (error) {
    if (error instanceof StorageCleanupUncertainError || error instanceof ServiceStartupCleanupError
      || error && typeof error === 'object' && 'code' in error && error.code === 'SERVICE_STARTUP_CLEANUP_PENDING') cleanupUncertain = true;
    throw error;
  } finally {
    for (const store of stores) try { await closeStore(store); } catch { cleanupUncertain = true; }
    if (!cleanupUncertain && !stores.size) { try { await installation?.release(); } finally { await sourceUnlock(); } }
  }
}

export function activateDesktopMigrationArguments(args: string[]): ActivateDesktopMigrationOptions {
  const names: Record<string, keyof ActivateDesktopMigrationOptions> = { '--preparation': 'preparation', '--preparation-sha256': 'preparationSha256',
    '--source-root': 'sourceRoot', '--payload-manifest': 'payloadManifest', '--payload-manifest-sha256': 'payloadManifestSha256',
    '--entry-sha256': 'entrySha256', '--controller-sha256': 'controllerSha256' };
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1]; if (!key || !value || value.startsWith('--') || key in result) throw fail(); result[key] = value;
  }
  return optionsSchema.parse(result);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const journal = await activateDesktopMigration(activateDesktopMigrationArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ type: 'desktop-migration-activated', id: journal.id, workspaceKey: journal.workspaceKey, phase: journal.phase, dailyLimit: 200, paused: true })}\n`);
  } catch { process.stderr.write(`${JSON.stringify({ type: 'desktop-migration-activation-failed', code: 'VERIFY_CUTOVER_JOURNAL', preserved: true })}\n`); process.exitCode = 1; }
}
