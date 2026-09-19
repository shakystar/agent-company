import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, statfs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { createDesktopDockerTarget } from '../server/desktop-docker-target.ts';
import { assertDesktopProviderDirectory, inspectDesktopFile, readDesktopProviderFile } from '../server/desktop-provider-files.ts';
import { OperationalModelBudget, validateOperationalBudgetMigration, type OperationalBudgetMigration } from '../server/operational-budget.ts';
import { readRuntimeRelease, type RuntimeRelease } from '../server/releases.ts';
import { ContainerRuntime, type RuntimeConfig } from '../server/runtime.ts';
import { activeStorage, existingStorageDirectory, loadStorageLayout, StorageManager, type ExternalBackupReference, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { ServiceStartupCleanupError } from '../server/startup-cleanup.ts';
import { stableRuntimeHash } from '../shared/runtime-releases.ts';
import type { RuntimeDriver } from '../shared/types.ts';

const MiB = 1024 ** 2, maximumMetadata = 2 * MiB, maximumBudget = 128 * MiB;
const digest = z.string().regex(/^[a-f0-9]{64}$/), size = z.number().int().nonnegative().safe();
const pathNames = ['source/workspace-id', 'source/storage-layout.json', 'source/runtime-release.identity.json', 'source/runtime-release.json'] as const;
const requiredNames = pathNames.filter(name => name !== 'source/storage-layout.json');
const memberSchema = z.object({ path: z.enum(pathNames), bytes: size.max(maximumMetadata), sha256: digest }).strict();
const localPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) !== parse(resolve(value)).root
  && !/[\x00-\x1f\x7f]/.test(value) && !value.split(/[\\/]/).some(part => part === '.' || part === '..'), '절대 경로를 지정해야 합니다.');
const distro = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);

export const operatingWorkspaceExportReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal('agent-company-operating-export'), id: z.uuid(), createdAt: z.iso.datetime(),
  source: z.object({ ownerKey: z.uuid(), workspaceKey: z.uuid(), activeId: z.uuid().nullable(), wslExecutable: localPath, distro }).strict(),
  backup: z.object({ directory: z.literal('backup'), id: z.uuid(), bytes: size, manifestSha256: digest, stateSha256: digest }).strict(),
  operationalBudget: z.object({ path: z.literal('operational-budget.json'), bytes: size.max(maximumBudget), sha256: digest,
    identity: z.uuid(), ledgerSha256: digest }).strict(),
  sourceFiles: z.array(memberSchema).min(3).max(4).refine(files => new Set(files.map(file => file.path)).size === files.length
    && requiredNames.every(name => files.some(file => file.path === name)), '출처 파일 목록이 불완전하거나 중복됩니다.'),
  databaseClosed: z.literal(true),
}).strict();
export type OperatingWorkspaceExportReceipt = z.infer<typeof operatingWorkspaceExportReceiptSchema>;

const optionsSchema = z.object({ sourceRoot: localPath, backupRoot: localPath, destination: localPath,
  sourceOwner: z.uuid(), wslExecutable: localPath.refine(path => basename(path).toLowerCase() === 'wsl.exe'), distro }).strict();
export type OperatingWorkspaceExportOptions = z.infer<typeof optionsSchema>;
export type OperatingExportPhase = 'validation' | 'paths' | 'controller-lock' | 'source-metadata' | 'source-budget' | 'capacity'
  | 'runtime' | 'idle' | 'database-open' | 'logical-backup' | 'source-recheck' | 'database-close' | 'unlock' | 'receipt';
const safeCode = (error: unknown) => {
  if (error instanceof OperatingExportError) return ['INVALID', 'FAILED', 'ABORTED', 'ENOENT', 'ELOCKED', 'EEXIST', 'ENOSPC', '400', '409', '413', '503', '507']
    .includes(error.causeCode) ? error.causeCode : 'FAILED';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && ['ENOENT', 'ELOCKED', 'EEXIST', 'ENOSPC'].includes(code)) return code;
  const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  return typeof status === 'number' && [400, 409, 413, 503, 507].includes(status) ? String(status) : 'FAILED';
};
export class OperatingExportError extends Error {
  constructor(readonly phase: OperatingExportPhase, readonly causeCode: string, readonly cleanupUncertain = false) {
    super('운영 작업실 내보내기의 잠금·출처·보존 검증을 완료하지 못했습니다. 원본과 기존 백업은 삭제하지 않았습니다.'); this.name = 'OperatingExportError';
  }
}
const failure = () => new OperatingExportError('validation', 'INVALID');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.isFile() && b.nlink === 1n;
type Snapshot = { data: Buffer; pin: { bytes: number; sha256: string } };

/** Same-handle bounded snapshot; large budget documents are never sent to stdout. */
async function snapshot(path: string, maximum = maximumMetadata): Promise<Snapshot> {
  if (maximum <= maximumMetadata) return readDesktopProviderFile(path, maximum);
  await assertDesktopProviderDirectory(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)
    || relative(path, await realpath(path))) throw failure();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!same(before, await handle.stat({ bigint: true }))) throw failure();
    const data = Buffer.alloc(Number(before.size)); let position = 0;
    while (position < data.length) {
      const part = await handle.read(data, position, Math.min(64 * 1024, data.length - position), position);
      if (!part.bytesRead) throw failure(); position += part.bytesRead;
    }
    await assertDesktopProviderDirectory(dirname(path));
    if (!same(before, await handle.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true }))
      || relative(path, await realpath(path))) throw failure();
    return { data, pin: { bytes: data.length, sha256: hash(data) } };
  } finally { await handle.close(); }
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
}
async function writeNew(path: string, data: Uint8Array | string): Promise<void> {
  await assertDesktopProviderDirectory(dirname(path));
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
async function sourceSnapshots(root: string): Promise<Map<typeof pathNames[number], Snapshot>> {
  if (await exists(join(root, 'runtime-release.pending.json'))) throw failure();
  const files = new Map<typeof pathNames[number], Snapshot>();
  for (const name of pathNames) {
    const path = join(root, name.slice('source/'.length));
    if (name === 'source/storage-layout.json' && !await exists(path)) continue;
    const value = await snapshot(path); utf8(value.data); files.set(name, value);
  }
  return files;
}
function equalSnapshots(a: Map<string, Snapshot>, b: Map<string, Snapshot>): boolean {
  return a.size === b.size && [...a].every(([name, value]) => value.data.equals(b.get(name)?.data ?? Buffer.alloc(0)));
}
function releaseConfig(ownerKey: string, selectedDistro: string): RuntimeConfig {
  // No runtimeConfig()/index import: no .env, account file, API key, or automatic work.
  return { mode: 'docker', workspaceKey: ownerKey, wslDistro: selectedDistro, image: '', model: 'workspace-export',
    auth: 'none', authFile: '', persistentWorkspaces: true, timeoutMs: 60_000 };
}
async function validateSources(root: string, options: Pick<OperatingWorkspaceExportOptions, 'sourceOwner' | 'distro'>,
  files: Map<typeof pathNames[number], Snapshot>) {
  if (utf8(files.get('source/workspace-id')!.data).trim() !== options.sourceOwner) throw failure();
  const storage = { rootDir: root, backupDir: dirname(root), ownerKey: options.sourceOwner };
  const layout = await loadStorageLayout(storage), active = await activeStorage(storage);
  const release = await readRuntimeRelease(root, options.sourceOwner, releaseConfig(active.workspaceKey, options.distro));
  if (!release || !equalSnapshots(files, await sourceSnapshots(root))) throw failure();
  return { layout, active, release };
}

/** Strict small receipt + allowlisted source/ledger hashes. The caller must also
 * use StorageManager.inspectExternalBackup before importing all backup members. */
export async function readOperatingWorkspaceExport(directory: string, expectedReceiptSha256: string): Promise<{
  receipt: OperatingWorkspaceExportReceipt; backup: ExternalBackupReference; budget: OperationalBudgetMigration; release: RuntimeRelease;
}> {
  try {
    digest.parse(expectedReceiptSha256);
    const root = await existingStorageDirectory(directory), document = await snapshot(join(root, 'export-receipt.json'));
    if (document.pin.sha256 !== expectedReceiptSha256) throw failure();
    const receipt = operatingWorkspaceExportReceiptSchema.parse(JSON.parse(utf8(document.data)));
    const allowedRoot = new Set(['source', 'backup', 'operational-budget.json', 'export-receipt.json', 'docker-config']);
    if ((await readdir(root)).some(name => !allowedRoot.has(name))) throw failure();
    await existingStorageDirectory(join(root, 'source')); await existingStorageDirectory(join(root, 'backup'));
    const files = await sourceSnapshots(join(root, 'source'));
    if ((await readdir(join(root, 'source'))).length !== receipt.sourceFiles.length || files.size !== receipt.sourceFiles.length) throw failure();
    for (const member of receipt.sourceFiles) {
      const actual = files.get(member.path);
      if (!actual || actual.pin.sha256 !== member.sha256 || actual.pin.bytes !== member.bytes) throw failure();
    }
    const { active, layout, release } = await validateSources(join(root, 'source'),
      { sourceOwner: receipt.source.ownerKey, distro: receipt.source.distro }, files);
    if (active.workspaceKey !== receipt.source.workspaceKey || layout.activeId !== receipt.source.activeId) throw failure();
    const budgetDocument = await snapshot(join(root, receipt.operationalBudget.path), maximumBudget);
    if (budgetDocument.pin.bytes !== receipt.operationalBudget.bytes || budgetDocument.pin.sha256 !== receipt.operationalBudget.sha256) throw failure();
    const budget = validateOperationalBudgetMigration(JSON.parse(utf8(budgetDocument.data)));
    if (budget.ownerKey !== receipt.source.ownerKey || budget.identity !== receipt.operationalBudget.identity
      || budget.ledgerSha256 !== receipt.operationalBudget.ledgerSha256) throw failure();
    const backupDirectory = join(root, receipt.backup.directory);
    const manifest = await inspectDesktopFile(join(backupDirectory, 'manifest.json'), 64 * MiB);
    const state = await inspectDesktopFile(join(backupDirectory, 'state.json'), 64 * MiB);
    if (manifest.sha256 !== receipt.backup.manifestSha256 || state.sha256 !== receipt.backup.stateSha256) throw failure();
    if ((await snapshot(join(root, 'export-receipt.json'))).pin.sha256 !== expectedReceiptSha256) throw failure();
    return { receipt, backup: { directory: backupDirectory, ownerKey: receipt.source.ownerKey,
      backupId: receipt.backup.id, manifestSha256: receipt.backup.manifestSha256 }, budget, release };
  } catch { throw failure(); }
}

/** Test seams replace explicit transport/store, never source identity or validation. */
export interface OperatingWorkspaceExportDependencies {
  openStore?: (directory: string) => Promise<WorkspaceStore>;
  createRuntime?: (config: RuntimeConfig, options: OperatingWorkspaceExportOptions, signal: AbortSignal) => Promise<RuntimeDriver>;
  freeSpace?: StorageConfig['freeSpace'];
}
export async function exportOperatingWorkspace(raw: OperatingWorkspaceExportOptions,
  dependencies: OperatingWorkspaceExportDependencies = {}, signal?: AbortSignal): Promise<{ receipt: OperatingWorkspaceExportReceipt; receiptSha256: string; directory: string }> {
  let store: WorkspaceStore | undefined, unlock: (() => Promise<void>) | undefined, failed = false, cleanupUncertain = false;
  let receipt: OperatingWorkspaceExportReceipt | undefined;
  let phase: OperatingExportPhase = 'validation', errorPhase: OperatingExportPhase | undefined, causeCode = 'FAILED';
  const cancellation = new AbortController(), abort = () => cancellation.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const check = () => cancellation.signal.throwIfAborted();
  try {
    const options = optionsSchema.parse(raw);
    phase = 'paths';
    const sourceRoot = await existingStorageDirectory(options.sourceRoot), destination = resolve(options.destination);
    const backupRoot = await existingStorageDirectory(options.backupRoot);
    await existingStorageDirectory(dirname(destination));
    if ([sourceRoot, backupRoot].some(path => inside(path, destination) || inside(destination, path)) || await exists(destination)) throw failure();
    check();
    phase = 'controller-lock'; unlock = await lockfile.lock(sourceRoot, { lockfilePath: join(sourceRoot, 'controller.lock'), stale: 30_000, update: 10_000,
      retries: 0, onCompromised: () => cancellation.abort() });
    phase = 'source-metadata'; const files = await sourceSnapshots(sourceRoot), { layout, active, release } = await validateSources(sourceRoot, options, files);
    await existingStorageDirectory(active.dataDir); await existingStorageDirectory(join(active.dataDir, 'db'));
    // PGlite otherwise initializes a new database in an empty existing directory.
    const pgVersion = utf8((await snapshot(join(active.dataDir, 'db', 'PG_VERSION'), 32)).data);
    if (!/^\d+(?:\.\d+)?\n?$/.test(pgVersion)) throw failure();
    phase = 'source-budget'; const budget = await OperationalModelBudget.exportMigration({ directory: join(sourceRoot, 'operational-budget'), ownerKey: options.sourceOwner });
    const budgetRaw = Buffer.from(JSON.stringify(budget)); if (budgetRaw.length > maximumBudget) throw failure();
    phase = 'capacity'; const free = dependencies.freeSpace ?? (async (path: string) => { const disk = await statfs(path); return disk.bavail * disk.bsize; });
    if (await free(dirname(destination)) - budgetRaw.length - [...files.values()].reduce((sum, value) => sum + value.data.length, 0)
      < 20 * 1024 ** 3) throw failure();
    check(); await mkdir(destination, { mode: 0o700 }); await existingStorageDirectory(destination);
    const config: RuntimeConfig = { ...releaseConfig(active.workspaceKey, options.distro), wslDistro: undefined,
      image: release.activeImage, ...(release.version === 2 ? { releaseCatalog: release.catalog } : {}) };
    phase = 'runtime'; const runtime = dependencies.createRuntime ? await dependencies.createRuntime(config, options, cancellation.signal) : await (async () => {
      const target = await createDesktopDockerTarget({ wslExecutable: options.wslExecutable, distro: options.distro,
        dockerConfigDir: join(destination, 'docker-config') });
      return new ContainerRuntime(config, target.command);
    })();
    const scopes = new Set([options.sourceOwner, ...layout.generations.map(entry => entry.workspaceKey), ...layout.restores.map(entry => entry.workspaceKey)]);
    scopes.add(active.workspaceKey);
    const assertIdle = async () => {
      for (const key of scopes) {
        check(); const scoped = key === active.workspaceKey ? runtime : runtime.forkWorkspace?.(key);
        if (!scoped?.confirmDeploymentIdle) throw failure(); await scoped.confirmDeploymentIdle();
      }
    };
    phase = 'idle'; await assertIdle(); check();
    phase = 'database-open'; store = await (dependencies.openStore ?? WorkspaceStore.open)(join(active.dataDir, 'db'));
    const stateSemanticSha256 = stableRuntimeHash(await store.read());
    const manager = new StorageManager({ rootDir: sourceRoot, backupDir: backupRoot, ownerKey: options.sourceOwner,
      ...(dependencies.freeSpace ? { freeSpace: dependencies.freeSpace } : {}) }, () => ({ store: store!, runtime, dataDir: active.dataDir }));
    phase = 'logical-backup'; const exported = await manager.exportProtected({ directory: join(destination, 'backup'), signal: cancellation.signal });
    const exportedState = await snapshot(join(destination, 'backup', 'state.json'), 64 * MiB);
    if (exportedState.pin.sha256 !== exported.stateSha256 || stableRuntimeHash(JSON.parse(utf8(exportedState.data))) !== stateSemanticSha256
      || stableRuntimeHash(await store.read()) !== stateSemanticSha256) throw failure();
    await mkdir(join(destination, 'source'), { mode: 0o700 });
    for (const [name, value] of files) { check(); await writeNew(join(destination, name), value.data); }
    await writeNew(join(destination, 'operational-budget.json'), budgetRaw);
    await assertIdle(); check();
    phase = 'database-close'; await store.close(); store = undefined;
    phase = 'source-recheck';
    if (!equalSnapshots(files, await sourceSnapshots(sourceRoot))) throw failure();
    const finalBudget = await OperationalModelBudget.exportMigration({ directory: join(sourceRoot, 'operational-budget'), ownerKey: options.sourceOwner });
    if (JSON.stringify(finalBudget) !== budgetRaw.toString('utf8')) throw failure();
    check();
    receipt = operatingWorkspaceExportReceiptSchema.parse({ version: 1, kind: 'agent-company-operating-export', id: randomUUID(), createdAt: new Date().toISOString(),
      source: { ownerKey: options.sourceOwner, workspaceKey: active.workspaceKey, activeId: layout.activeId, wslExecutable: options.wslExecutable, distro: options.distro },
      backup: { directory: 'backup', id: exported.backup.id, bytes: exported.backup.bytes, manifestSha256: exported.manifestSha256, stateSha256: exported.stateSha256 },
      operationalBudget: { path: 'operational-budget.json', bytes: budgetRaw.length, sha256: hash(budgetRaw), identity: budget.identity, ledgerSha256: budget.ledgerSha256 },
      sourceFiles: [...files].map(([path, value]) => ({ path, ...value.pin })), databaseClosed: true });
  } catch (error) { failed = true; cleanupUncertain = error instanceof ServiceStartupCleanupError; errorPhase = phase; causeCode = safeCode(error); }
  finally {
    if (store) try { await store.close(); store = undefined; } catch (error) { failed = true; errorPhase ??= 'database-close'; causeCode = safeCode(error); }
    // An uncertain DB close is still a possible writer. Keep its lease until
    // process termination; a second controller must not open the same database.
    if (unlock && !store && !cleanupUncertain) try { await unlock(); } catch (error) { failed = true; errorPhase ??= 'unlock'; causeCode = safeCode(error); }
    signal?.removeEventListener('abort', abort);
  }
  if (failed || !receipt || cancellation.signal.aborted) throw new OperatingExportError(errorPhase ?? phase,
    cancellation.signal.aborted ? 'ABORTED' : causeCode, cleanupUncertain || Boolean(store));
  try {
    const directory = resolve(raw.destination), receiptRaw = JSON.stringify(receipt), receiptSha256 = hash(receiptRaw);
    await writeNew(join(directory, 'export-receipt.json'), receiptRaw);
    await readOperatingWorkspaceExport(directory, receiptSha256);
    return { receipt, receiptSha256, directory };
  } catch (error) { throw new OperatingExportError('receipt', safeCode(error)); }
}

export function operatingWorkspaceExportArguments(args: string[]): OperatingWorkspaceExportOptions {
  const names: Record<string, keyof OperatingWorkspaceExportOptions> = { '--source-root': 'sourceRoot', '--backup-root': 'backupRoot',
    '--destination': 'destination', '--source-owner': 'sourceOwner', '--wsl-executable': 'wslExecutable', '--distro': 'distro' };
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]], value = args[index + 1];
    if (!name || !value || value.startsWith('--') || Object.hasOwn(values, name)) throw failure(); values[name] = value;
  }
  try { return optionsSchema.parse(values); } catch { throw failure(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController(), cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await exportOperatingWorkspace(operatingWorkspaceExportArguments(process.argv.slice(2)), {}, abort.signal);
    process.stdout.write(`${JSON.stringify({ type: 'operating-workspace-exported', directory: result.directory,
      receiptSha256: result.receiptSha256, backupId: result.receipt.backup.id, stateSha256: result.receipt.backup.stateSha256 })}\n`);
  } catch (error) {
    const known = error instanceof OperatingExportError ? error : new OperatingExportError('validation', 'INVALID');
    process.stderr.write(`${JSON.stringify({ type: 'operating-workspace-export-failed', phase: known.phase, code: known.causeCode,
      cleanupUncertain: known.cleanupUncertain, message: known.message })}\n`); process.exitCode = 1;
  }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
