import { createHash, randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readOperatingWorkspaceExport } from './export-operating-workspace.ts';
import { readDesktopProviderFile, assertDesktopProviderDirectory, inspectDesktopFile } from '../server/desktop-provider-files.ts';
import { desktopPaths, openDesktopInstallation } from '../server/desktop-paths.ts';
import { desktopRuntimeSettings } from '../server/desktop-runtime-settings.ts';
import { createDesktopRuntimeContext, type DesktopRuntimeContextOptions } from '../server/desktop-runtime-factory.ts';
import { hasUnfinishedDesktopImageInstall } from '../server/desktop-image-install.ts';
import { loadDesktopMigrationRuntime, sealDesktopMigrationRuntime } from '../server/desktop-migration-runtime.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { activeStorage, existingStorageDirectory, loadStorageLayout, StorageCleanupUncertainError, StorageManager, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { ServiceStartupCleanupError } from '../server/startup-cleanup.ts';
import { legacyWorkerEntrySha256, stableRuntimeHash, validateHistoricalWorkerAuthBindings, type HistoricalWorkerAuthBinding } from '../shared/runtime-releases.ts';
import { operationalLimit } from '../shared/operational-budget.ts';
import type { RuntimeDriver } from '../shared/types.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().nonnegative().safe();
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) !== parse(resolve(value)).root
  && !/[\x00-\x1f\x7f]/.test(value) && !value.split(/[\\/]/).some(part => part === '.' || part === '..'));
const optionsSchema = z.object({ sourceExport: path, sourceReceiptSha256: digest, appDataRoot: path, resourceRoot: path,
  targetOwner: z.uuid(), rollbackBackup: path, receiptPath: path, sourceDailyLimit: operationalLimit, targetDailyLimit: operationalLimit,
  plannedDailyLimit: operationalLimit, targetBudgetRevision: integer }).strict();
export type PrepareDesktopMigrationOptions = z.infer<typeof optionsSchema>;
const backupSchema = z.object({ directory: path, ownerKey: z.uuid(), backupId: z.uuid(), manifestSha256: digest, stateSha256: digest }).strict();
export const desktopMigrationPreparationReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal('agent-company-desktop-migration-preparation'), id: z.uuid(), createdAt: z.iso.datetime(),
  source: z.object({ directory: path, receiptSha256: digest, ownerKey: z.uuid(), backupId: z.uuid(), manifestSha256: digest }).strict(),
  target: z.object({ appDataRoot: path, resourceRoot: path, ownerKey: z.uuid(),
    previousActive: z.object({ id: z.uuid().nullable(), workspaceKey: z.uuid() }).strict(), settingsRevision: integer }).strict(),
  budget: z.object({ sourceDailyLimit: operationalLimit, targetDailyLimit: operationalLimit, plannedDailyLimit: operationalLimit,
    targetRevision: integer, targetIdentity: z.uuid(), targetLedgerSha256: digest, sourceLedgerSha256: digest }).strict(),
  rollback: backupSchema,
  prepared: z.object({ id: z.uuid(), workspaceKey: z.uuid(), directory: path, migrationReceiptSha256: digest, runtimeSha256: digest }).strict(),
  databaseClosed: z.literal(true), activated: z.literal(false), budgetImported: z.literal(false),
}).strict();
export type DesktopMigrationPreparationReceipt = z.infer<typeof desktopMigrationPreparationReceiptSchema>;
export type DesktopMigrationPreparationPhase = 'validation' | 'source-export' | 'paths' | 'installation-lock' | 'settings' | 'target-budget'
  | 'runtime' | 'idle' | 'database-open' | 'rollback-backup' | 'prepare-import' | 'runtime-seal' | 'preservation' | 'database-close' | 'unlock' | 'receipt';
const safeCode = (error: unknown) => {
  if (error instanceof DesktopMigrationPreparationError) return ['INVALID', 'FAILED', 'ABORTED', 'ENOENT', 'ELOCKED', 'EEXIST', 'ENOSPC', '400', '409', '413', '503', '507']
    .includes(error.causeCode) ? error.causeCode : 'FAILED';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && ['ENOENT', 'ELOCKED', 'EEXIST', 'ENOSPC'].includes(code)) return code;
  const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  return typeof status === 'number' && [400, 409, 413, 503, 507].includes(status) ? String(status) : 'FAILED';
};
export class DesktopMigrationPreparationError extends Error {
  constructor(readonly phase: DesktopMigrationPreparationPhase, readonly causeCode: string, readonly cleanupUncertain = false) {
    super('설치형 작업실 이관 준비의 잠금·출처·보존 검증을 완료하지 못했습니다. 전환과 운영 원장 합산은 하지 않았습니다.'); this.name = 'DesktopMigrationPreparationError';
  }
}
const failure = () => new DesktopMigrationPreparationError('validation', 'INVALID');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
const inside = (a: string, b: string) => { const path = relative(a, b); return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
async function writeNew(path: string, value: unknown) {
  await assertDesktopProviderDirectory(dirname(path)); const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
async function document(path: string) {
  const file = await readDesktopProviderFile(path, 2 * 1024 ** 2); return { value: json(file.data), sha256: file.pin.sha256 };
}
const identitySchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop'),
  channel: z.literal('beta'), workspaceKey: z.uuid() }).strict();
const stagedReceiptSchema = z.object({ version: z.literal(1), source: z.object({ directory: path, ownerKey: z.uuid(), backupId: z.uuid(), manifestSha256: digest }).strict(),
  targetOwnerKey: z.uuid(), workspaceKey: z.uuid(), generationId: z.uuid(), createdAt: z.iso.datetime(), stateSha256: digest, runtimeSha256: digest }).strict();

export async function readDesktopMigrationPreparation(receiptPath: string, expectedReceiptSha256: string): Promise<DesktopMigrationPreparationReceipt> {
  try {
    digest.parse(expectedReceiptSha256); const read = await document(receiptPath);
    if (read.sha256 !== expectedReceiptSha256) throw failure();
    const receipt = desktopMigrationPreparationReceiptSchema.parse(read.value);
    const paths = desktopPaths(receipt.target.resourceRoot, receipt.target.appDataRoot);
    if (resolve(receipt.prepared.directory) !== join(paths.dataDir, 'storage-tmp', receipt.prepared.id)
      || receipt.source.ownerKey === receipt.target.ownerKey || receipt.rollback.ownerKey !== receipt.target.ownerKey) throw failure();
    const migration = await document(join(receipt.prepared.directory, 'migration-receipt.json'));
    const runtime = await document(join(receipt.prepared.directory, 'migration-runtime.json'));
    if (migration.sha256 !== receipt.prepared.migrationReceiptSha256 || runtime.sha256 !== receipt.prepared.runtimeSha256) throw failure();
    const staged = stagedReceiptSchema.parse(migration.value), source = await readOperatingWorkspaceExport(receipt.source.directory, receipt.source.receiptSha256);
    if (source.receipt.source.ownerKey !== receipt.source.ownerKey || source.backup.backupId !== receipt.source.backupId
      || source.backup.manifestSha256 !== receipt.source.manifestSha256 || !isDeepStrictEqual(staged.source, source.backup)
      || staged.targetOwnerKey !== receipt.target.ownerKey || staged.workspaceKey !== receipt.prepared.workspaceKey || staged.generationId !== receipt.prepared.id
      || staged.runtimeSha256 !== receipt.prepared.runtimeSha256 || staged.stateSha256 !== source.receipt.backup.stateSha256
      || source.budget.ledgerSha256 !== receipt.budget.sourceLedgerSha256) throw failure();
    if ((json(Buffer.from(source.budget.ledgerRaw)) as { dailyLimit: number }).dailyLimit !== receipt.budget.sourceDailyLimit) throw failure();
    const rollbackManifest = await inspectDesktopFile(join(receipt.rollback.directory, 'manifest.json'), 64 * 1024 ** 2);
    const rollbackState = await inspectDesktopFile(join(receipt.rollback.directory, 'state.json'), 64 * 1024 ** 2);
    if (rollbackManifest.sha256 !== receipt.rollback.manifestSha256 || rollbackState.sha256 !== receipt.rollback.stateSha256) throw failure();
    await loadDesktopMigrationRuntime(receipt.prepared.directory, receipt.target.ownerKey, receipt.prepared.workspaceKey);
    if ((await document(receiptPath)).sha256 !== expectedReceiptSha256) throw failure();
    return receipt;
  } catch { throw failure(); }
}

export interface PrepareDesktopMigrationDependencies {
  openStore?: (directory: string) => Promise<WorkspaceStore>;
  createContext?: (options: DesktopRuntimeContextOptions) => Promise<{ runtime: RuntimeDriver }>;
  freeSpace?: StorageConfig['freeSpace'];
}

/** Offline preparation only: no AgentService, HTTP listener, model, account
 * inspection, budget import, or active generation change is part of this CLI. */
export async function prepareDesktopMigration(raw: PrepareDesktopMigrationOptions,
  dependencies: PrepareDesktopMigrationDependencies = {}, signal?: AbortSignal): Promise<{
    receipt: DesktopMigrationPreparationReceipt; receiptSha256: string;
  }> {
  let installation: Awaited<ReturnType<typeof openDesktopInstallation>> | undefined, store: WorkspaceStore | undefined;
  let receipt: DesktopMigrationPreparationReceipt | undefined, failed = false, cleanupUncertain = false;
  let phase: DesktopMigrationPreparationPhase = 'validation', errorPhase: DesktopMigrationPreparationPhase | undefined, causeCode = 'FAILED';
  const check = () => signal?.throwIfAborted();
  try {
    check(); const options = optionsSchema.parse(raw); phase = 'source-export';
    const source = await readOperatingWorkspaceExport(options.sourceExport, options.sourceReceiptSha256);
    if (source.release.version !== 2 || source.receipt.source.ownerKey === options.targetOwner) throw failure();
    const sourceLedger = json(Buffer.from(source.budget.ledgerRaw)) as { dailyLimit: number };
    if (sourceLedger.dailyLimit !== options.sourceDailyLimit) throw failure();
    phase = 'paths'; const paths = desktopPaths(options.resourceRoot, options.appDataRoot);
    for (const directory of [paths.resourceRoot, paths.appDataRoot, paths.dataDir, paths.backupDir]) await existingStorageDirectory(directory);
    for (const output of [options.rollbackBackup, options.receiptPath]) {
      await existingStorageDirectory(dirname(output));
      if ([paths.appDataRoot, paths.resourceRoot, options.sourceExport].some(directory => inside(resolve(directory), resolve(output)) || inside(resolve(output), resolve(directory)))
        || await exists(output)) throw failure();
    }
    if (inside(resolve(options.rollbackBackup), resolve(options.receiptPath)) || inside(resolve(options.receiptPath), resolve(options.rollbackBackup))) throw failure();
    // Require existing anchors before the standard installation opener can create anything.
    const identity = await document(join(paths.appDataRoot, 'desktop-installation.json'));
    if (identitySchema.parse(identity.value).workspaceKey !== options.targetOwner) throw failure();
    const key = await readDesktopProviderFile(join(paths.dataDir, 'workspace-id'), 100);
    if (new TextDecoder('utf-8', { fatal: true }).decode(key.data).trim() !== options.targetOwner) throw failure();
    check(); phase = 'installation-lock'; installation = await openDesktopInstallation(paths);
    if (installation.workspaceKey !== options.targetOwner || (await document(join(paths.appDataRoot, 'desktop-installation.json'))).sha256 !== identity.sha256) throw failure();
    if (await hasUnfinishedDesktopImageInstall(paths.appDataRoot)) throw failure();
    phase = 'settings'; const settingsStore = desktopRuntimeSettings(paths.appDataRoot, options.targetOwner), settings = await settingsStore.read();
    if (!settings.selection) throw failure();
    const config: StorageConfig = { rootDir: paths.dataDir, backupDir: paths.backupDir, ownerKey: options.targetOwner,
      ...(dependencies.freeSpace ? { freeSpace: dependencies.freeSpace } : {}) };
    const layout = await loadStorageLayout(config), previous = await activeStorage(config);
    if (layout.restores.length) throw failure();
    await existingStorageDirectory(previous.dataDir); await existingStorageDirectory(join(previous.dataDir, 'db'));
    const pgVersion = await readDesktopProviderFile(join(previous.dataDir, 'db', 'PG_VERSION'), 32);
    if (!/^\d+(?:\.\d+)?\n?$/.test(new TextDecoder('utf-8', { fatal: true }).decode(pgVersion.data))) throw failure();
    // Read-only snapshot does not initialize/migrate target policy or merge any usage.
    phase = 'target-budget'; const targetBudget = await OperationalModelBudget.exportMigration({ directory: join(paths.dataDir, 'operational-budget'), ownerKey: options.targetOwner });
    const targetLedger = json(Buffer.from(targetBudget.ledgerRaw)) as { dailyLimit: number; revision: number };
    if (targetLedger.dailyLimit !== options.targetDailyLimit || targetLedger.revision !== options.targetBudgetRevision) throw failure();
    phase = 'runtime'; const previousRuntime = await loadDesktopMigrationRuntime(previous.dataDir, options.targetOwner, previous.workspaceKey);
    const historicalReleaseCatalogs = [...previousRuntime.historicalReleaseCatalogs, source.release.catalog];
    const sourceBindings: HistoricalWorkerAuthBinding[] = source.release.catalog.manifests
      .filter(manifest => legacyWorkerEntrySha256.some(hash => hash === manifest.sourceHashes['entry.mjs']))
      .map(manifest => ({ pin: { image: manifest.image, manifestId: manifest.id }, contract: 'codex-secret-directory-v1', entrySha256: manifest.sourceHashes['entry.mjs'] }));
    const historicalAuthBindings = [...previousRuntime.historicalAuthBindings, ...sourceBindings];
    const context = await (dependencies.createContext ?? createDesktopRuntimeContext)({ paths, ownerKey: options.targetOwner,
      workspaceKey: previous.workspaceKey, selection: settings.selection, historicalReleaseCatalogs, historicalAuthBindings });
    const runtime = context.runtime;
    // The real factory already validates with the bundled active catalog. Test
    // transports still exercise exact source-binding validation independently.
    if (runtime.defaultReleasePin && 'config' in runtime) {
      const catalog = (runtime as Awaited<ReturnType<typeof createDesktopRuntimeContext>>['runtime']).config.releaseCatalog;
      if (!catalog) throw failure(); validateHistoricalWorkerAuthBindings(catalog, historicalReleaseCatalogs, historicalAuthBindings);
    }
    const assertIdle = async (extra?: string) => {
      for (const key of new Set([options.targetOwner, previous.workspaceKey, ...layout.generations.map(item => item.workspaceKey), ...(extra ? [extra] : [])])) {
        check(); const scoped = key === previous.workspaceKey ? runtime : runtime.forkWorkspace?.(key);
        if (!scoped?.confirmDeploymentIdle) throw failure(); await scoped.confirmDeploymentIdle();
      }
    };
    phase = 'idle'; await assertIdle(); check();
    phase = 'database-open'; store = await (dependencies.openStore ?? WorkspaceStore.open)(join(previous.dataDir, 'db'));
    const originalState = await store.read(), stateSemanticSha256 = stableRuntimeHash(originalState);
    const manager = new StorageManager(config, () => ({ store: store!, runtime, dataDir: previous.dataDir }));
    // Preserve current installed workspace before any layout/prepared volume mutation.
    phase = 'rollback-backup'; const rollback = await manager.exportProtected({ directory: options.rollbackBackup, signal });
    const rollbackReference = { directory: options.rollbackBackup, ownerKey: options.targetOwner, backupId: rollback.backup.id,
      manifestSha256: rollback.manifestSha256 };
    if (stableRuntimeHash((await manager.inspectExternalBackup(rollbackReference)).state) !== stateSemanticSha256) throw failure();
    phase = 'prepare-import'; check(); await manager.initialize(); await manager.inspectExternalBackup(source.backup); check();
    const prepared = await manager.prepareImport(source.backup), after = await loadStorageLayout(config);
    const selected = after.restores.find(item => item.id === prepared.id && item.ready);
    if (!selected || after.activeId !== layout.activeId || !isDeepStrictEqual(after.generations, layout.generations)
      || after.restores.length !== 1 || (await activeStorage(config)).workspaceKey !== previous.workspaceKey) throw failure();
    const staging = join(paths.dataDir, 'storage-tmp', prepared.id);
    phase = 'runtime-seal'; check(); await sealDesktopMigrationRuntime(staging, { ownerKey: options.targetOwner, workspaceKey: selected.workspaceKey,
      historicalReleaseCatalogs, historicalAuthBindings });
    await loadDesktopMigrationRuntime(staging, options.targetOwner, selected.workspaceKey);
    await assertIdle(selected.workspaceKey); check();
    phase = 'preservation'; if (stableRuntimeHash(await store.read()) !== stateSemanticSha256 || !isDeepStrictEqual(await settingsStore.read(), settings)) throw failure();
    if (JSON.stringify(await OperationalModelBudget.exportMigration({ directory: join(paths.dataDir, 'operational-budget'), ownerKey: options.targetOwner }))
      !== JSON.stringify(targetBudget)) throw failure();
    await readOperatingWorkspaceExport(options.sourceExport, options.sourceReceiptSha256);
    phase = 'database-close'; await store.close(); store = undefined; check();
    const migration = await document(join(staging, 'migration-receipt.json')), sealed = await document(join(staging, 'migration-runtime.json'));
    receipt = desktopMigrationPreparationReceiptSchema.parse({ version: 1, kind: 'agent-company-desktop-migration-preparation', id: randomUUID(), createdAt: new Date().toISOString(),
      source: { directory: resolve(options.sourceExport), receiptSha256: options.sourceReceiptSha256, ownerKey: source.receipt.source.ownerKey,
        backupId: source.backup.backupId, manifestSha256: source.backup.manifestSha256 },
      target: { appDataRoot: paths.appDataRoot, resourceRoot: paths.resourceRoot, ownerKey: options.targetOwner,
        previousActive: { id: layout.activeId, workspaceKey: previous.workspaceKey }, settingsRevision: settings.revision },
      budget: { sourceDailyLimit: options.sourceDailyLimit, targetDailyLimit: options.targetDailyLimit, plannedDailyLimit: options.plannedDailyLimit,
        targetRevision: options.targetBudgetRevision, targetIdentity: targetBudget.identity, targetLedgerSha256: targetBudget.ledgerSha256, sourceLedgerSha256: source.budget.ledgerSha256 },
      rollback: { directory: resolve(options.rollbackBackup), ownerKey: options.targetOwner, backupId: rollback.backup.id,
        manifestSha256: rollback.manifestSha256, stateSha256: rollback.stateSha256 },
      prepared: { id: prepared.id, workspaceKey: selected.workspaceKey, directory: staging, migrationReceiptSha256: migration.sha256, runtimeSha256: sealed.sha256 },
      databaseClosed: true, activated: false, budgetImported: false });
  } catch (error) { failed = true; cleanupUncertain = error instanceof StorageCleanupUncertainError || error instanceof ServiceStartupCleanupError;
    errorPhase = phase; causeCode = safeCode(error); }
  finally {
    if (store) try { await store.close(); store = undefined; } catch (error) { failed = true; errorPhase ??= 'database-close'; causeCode = safeCode(error); }
    if (installation && !store && !cleanupUncertain) try { await installation.release(); } catch (error) { failed = true; errorPhase ??= 'unlock'; causeCode = safeCode(error); }
  }
  if (failed || !receipt || signal?.aborted) throw new DesktopMigrationPreparationError(errorPhase ?? phase,
    signal?.aborted ? 'ABORTED' : causeCode, cleanupUncertain || Boolean(store));
  try {
    const receiptSha256 = hash(JSON.stringify(receipt)); await writeNew(raw.receiptPath, receipt);
    await readDesktopMigrationPreparation(raw.receiptPath, receiptSha256); return { receipt, receiptSha256 };
  } catch (error) { throw new DesktopMigrationPreparationError('receipt', safeCode(error)); }
}

export function prepareDesktopMigrationArguments(args: string[]): PrepareDesktopMigrationOptions {
  const names: Record<string, keyof PrepareDesktopMigrationOptions> = { '--source-export': 'sourceExport', '--source-receipt-sha256': 'sourceReceiptSha256',
    '--app-data-root': 'appDataRoot', '--resources-root': 'resourceRoot', '--target-owner': 'targetOwner', '--rollback-backup': 'rollbackBackup', '--receipt': 'receiptPath',
    '--source-daily-limit': 'sourceDailyLimit', '--target-daily-limit': 'targetDailyLimit', '--planned-daily-limit': 'plannedDailyLimit', '--target-budget-revision': 'targetBudgetRevision' };
  const values: Record<string, string | number> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]], value = args[index + 1];
    if (!name || !value || value.startsWith('--') || Object.hasOwn(values, name)) throw failure();
    if (name.endsWith('Limit') || name === 'targetBudgetRevision') { if (!/^\d+$/.test(value)) throw failure(); values[name] = Number(value); }
    else values[name] = value;
  }
  try { return optionsSchema.parse(values); } catch { throw failure(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const options = prepareDesktopMigrationArguments(process.argv.slice(2)), result = await prepareDesktopMigration(options, {}, controller.signal);
    process.stdout.write(`${JSON.stringify({ type: 'desktop-migration-prepared', receiptPath: options.receiptPath, receiptSha256: result.receiptSha256,
      restoreId: result.receipt.prepared.id, workspaceKey: result.receipt.prepared.workspaceKey, activated: false, budgetImported: false })}\n`);
  } catch (error) {
    const known = error instanceof DesktopMigrationPreparationError ? error : new DesktopMigrationPreparationError('validation', 'INVALID');
    process.stderr.write(`${JSON.stringify({ type: 'desktop-migration-prepare-failed', phase: known.phase, code: known.causeCode,
      cleanupUncertain: known.cleanupUncertain, message: known.message })}\n`); process.exitCode = 1;
  }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
