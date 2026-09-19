import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import lockfile from 'proper-lockfile';
import { exportOperatingWorkspace } from '../scripts/export-operating-workspace.ts';
import { prepareDesktopMigration, prepareDesktopMigrationArguments, readDesktopMigrationPreparation, DesktopMigrationPreparationError,
  type PrepareDesktopMigrationOptions } from '../scripts/prepare-desktop-migration.ts';
import { desktopPaths, openDesktopInstallation } from '../server/desktop-paths.ts';
import { desktopRuntimeSettings } from '../server/desktop-runtime-settings.ts';
import { type DesktopRuntimeContextOptions } from '../server/desktop-runtime-factory.ts';
import { loadDesktopMigrationRuntime } from '../server/desktop-migration-runtime.ts';
import { activeStorage, loadStorageLayout } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { ServiceStartupCleanupError } from '../server/startup-cleanup.ts';
import { createWorkerReleaseManifest, legacyWorkerEntrySha256, validateHistoricalWorkerAuthBindings, validateWorkerReleaseCatalogSet, workerSourceFiles } from '../shared/runtime-releases.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import { activateDesktopMigration } from '../scripts/activate-desktop-migration.ts';
import { assertDesktopMigrationStartup, assertOperatingMigrationStartup, cutoverJournalPath, desktopMigrationCutoverCapability } from '../server/desktop-migration-cutover.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const currentManifest = createWorkerReleaseManifest({ image: `sha256:${'b'.repeat(64)}`, runtimeBaseHash: 'e'.repeat(64),
  sourceHashes: Object.fromEntries(workerSourceFiles.map(file => [file, 'c'.repeat(64)])) });
const legacyManifest = createWorkerReleaseManifest({ image: `sha256:${'a'.repeat(64)}`, runtimeBaseHash: 'd'.repeat(64),
  sourceHashes: { ...currentManifest.sourceHashes, 'entry.mjs': legacyWorkerEntrySha256[0] } });
const catalog = (manifest: typeof currentManifest) => ({ version: 1 as const, active: { image: manifest.image, manifestId: manifest.id }, manifests: [manifest] });
const freeSpace = async () => 100 * 1024 ** 3;
const fixedFailure = /설치형 작업실 이관 준비의 잠금·출처·보존 검증/;
const absent = (path: string) => assert.rejects(readFile(path), { code: 'ENOENT' });
class MigrationRuntime extends StorageFixtureRuntime {
  readonly config = { releaseCatalog: catalog(currentManifest) };
  readonly defaultReleasePin = this.config.releaseCatalog.active;
  readonly observations = { imports: 0, afterImport: undefined as undefined | (() => Promise<void>) };
  constructor(key: string, readonly parent?: MigrationRuntime) { super(key, parent?.spaces, parent?.calls); }
  override forkWorkspace(key: string) { return new MigrationRuntime(key, this.parent ?? this); }
  async confirmDeploymentIdle() {}
  override async importWorkspace(id: string, archive: string) {
    const own = (this.parent ?? this).observations; own.imports++; const result = await super.importWorkspace(id, archive);
    await own.afterImport?.(); return result;
  }
}
async function ledger(root: string, ownerKey: string, dailyLimit: number) {
  const directory = join(root, 'operational-budget'); await mkdir(directory); const identity = randomUUID();
  await writeFile(join(directory, 'identity.json'), JSON.stringify({ version: 1, ownerKey, identity }));
  const value = { version: 1, ownerKey, identity, createdAt: '2026-09-12T00:00:00.000Z', revision: 0, dailyLimit, projectDailyLimits: {}, starts: [], changes: [] };
  await writeFile(join(directory, 'ledger.json'), JSON.stringify(value)); return { directory, value };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-desktop-prepare-'));
  t.after(async () => { const location = relative(resolve(tmpdir()), resolve(directory)); assert.ok(location.startsWith('ac-desktop-prepare-') && !location.includes('..'));
    await rm(resolve(directory), { recursive: true, force: true }); });
  const sourceRoot = join(directory, 'source'), sourceBackups = join(directory, 'source-backups'), sourceOwner = randomUUID();
  await mkdir(sourceRoot); await mkdir(sourceBackups); await writeFile(join(sourceRoot, 'workspace-id'), sourceOwner);
  await writeFile(join(sourceRoot, 'runtime-release.identity.json'), JSON.stringify({ version: 1, ownerKey: sourceOwner }));
  await writeFile(join(sourceRoot, 'runtime-release.json'), JSON.stringify({ version: 2, ownerKey: sourceOwner, target: { mode: 'docker', wslDistro: 'Fixture' },
    activeImage: legacyManifest.image, previousImage: legacyManifest.image, catalog: catalog(legacyManifest), planHash: 'a'.repeat(64),
    history: [{ image: legacyManifest.image, previousImage: legacyManifest.image, action: 'activate', createdAt: '2026-09-12T00:00:00.000Z', sourceHashes: legacyManifest.sourceHashes }] }));
  await ledger(sourceRoot, sourceOwner, 500);
  const sourceStore = await WorkspaceStore.open(join(sourceRoot, 'db')); await sourceStore.close();
  const sourceRuntime = new MigrationRuntime(sourceOwner), sourceRunId = randomUUID();
  sourceRuntime.spaces.get(sourceOwner)!.set(sourceRunId, { 'source-work.txt': Buffer.from('source work preserved').toString('base64') });
  const source = await exportOperatingWorkspace({ sourceRoot, backupRoot: sourceBackups, sourceOwner, destination: join(directory, 'source-export'),
    wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Fixture' }, { freeSpace, createRuntime: async () => sourceRuntime });
  const paths = desktopPaths(join(directory, 'resources'), join(directory, 'appdata')); await mkdir(paths.distDir, { recursive: true });
  await writeFile(join(paths.distDir, 'index.html'), '<!doctype html><title>fixture</title>'); await mkdir(paths.appDataRoot);
  const installation = await openDesktopInstallation(paths), targetOwner = installation.workspaceKey; await installation.release();
  await desktopRuntimeSettings(paths.appDataRoot, targetOwner).save({ kind: 'wsl-docker', wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Fixture', model: 'fixture-model' }, 0);
  const targetLedger = await ledger(paths.dataDir, targetOwner, 100);
  const targetStore = await WorkspaceStore.open(join(paths.dataDir, 'db')); let targetStateSha256: string;
  try { await targetStore.change(state => { state.operatorPaused = true; }); targetStateSha256 = sha(JSON.stringify(await targetStore.read())); }
  finally { await targetStore.close(); }
  const runtime = new MigrationRuntime(targetOwner), targetRunId = randomUUID();
  runtime.spaces.get(targetOwner)!.set(targetRunId, { 'target-work.txt': Buffer.from('target original').toString('base64') });
  const options: PrepareDesktopMigrationOptions = { sourceExport: source.directory, sourceReceiptSha256: source.receiptSha256, appDataRoot: paths.appDataRoot,
    resourceRoot: paths.resourceRoot, targetOwner, rollbackBackup: join(directory, 'rollback-backup'), receiptPath: join(directory, 'preparation.json'),
    sourceDailyLimit: 500, targetDailyLimit: 100, plannedDailyLimit: 200, targetBudgetRevision: 0 };
  const contexts: DesktopRuntimeContextOptions[] = []; let opens = 0, closes = 0;
  const dependencies = { freeSpace, createContext: async (input: DesktopRuntimeContextOptions) => {
    contexts.push(input); validateWorkerReleaseCatalogSet(runtime.config.releaseCatalog, input.historicalReleaseCatalogs);
    validateHistoricalWorkerAuthBindings(runtime.config.releaseCatalog, input.historicalReleaseCatalogs, input.historicalAuthBindings);
    return { runtime };
  }, openStore: async (path: string) => { opens++; const store = await WorkspaceStore.open(path), close = store.close.bind(store);
    store.close = async () => { await close(); closes++; }; return store; } };
  return { directory, paths, options, dependencies, runtime, source, sourceRunId, targetRunId, targetLedger, targetStateSha256,
    contexts, get opens() { return opens; }, get closes() { return closes; } };
}

test('offline cutover blocks controllers during failure and forward-recovers exactly one budget import into a paused generation', async t => {
  const f = await fixture(t), prepared = await prepareDesktopMigration(f.options, f.dependencies);
  const server = join(f.paths.resourceRoot, 'server'); await mkdir(server);
  const files = [
    { path: 'resources/server/desktop-entry.js', text: 'export { desktopMigrationCutoverCapability } from "./desktop-migration-cutover.js";' },
    { path: 'resources/server/desktop-controller.js', text: 'fixture controller' },
    { path: 'resources/server/desktop-migration-cutover.js', text: `export const desktopMigrationCutoverCapability = '${desktopMigrationCutoverCapability}';` },
    { path: 'resources/dist/index.html', text: await readFile(join(f.paths.distDir, 'index.html'), 'utf8') },
  ];
  for (const file of files) await writeFile(join(f.paths.resourceRoot, file.path.slice('resources/'.length)), file.text);
  const manifest = { version: 1, target: 'x86_64-pc-windows-msvc', protocol: 1, entry: 'resources/server/desktop-entry.js', distributionReady: false,
    files: [...files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha(file.text) })),
      { path: 'binaries/node-x86_64-pc-windows-msvc.exe', bytes: 1, sha256: '0'.repeat(64) }] };
  const payloadManifest = join(f.directory, 'payload-manifest.json'); await writeFile(payloadManifest, JSON.stringify(manifest));
  const options = { preparation: f.options.receiptPath, preparationSha256: prepared.receiptSha256, sourceRoot: join(f.directory, 'source'),
    payloadManifest, payloadManifestSha256: sha(JSON.stringify(manifest)), entrySha256: sha(files[0].text), controllerSha256: sha(files[1].text) };
  const dependencies = { freeSpace, createRuntime: async () => f.runtime };
  await assert.rejects(activateDesktopMigration({ ...options, controllerSha256: '0'.repeat(64) }, dependencies), /ACTIVATION_INVALID/);
  await absent(cutoverJournalPath(f.paths.appDataRoot));
  for (const startupFailure of [new ServiceStartupCleanupError(new Error('fixture startup'), new Error('fixture cleanup')),
    Object.assign(new Error('fixture cleanup pending'), { code: 'SERVICE_STARTUP_CLEANUP_PENDING' })]) {
    await assert.rejects(activateDesktopMigration(options, { ...dependencies, openStore: async () => { throw startupFailure; } }),
      error => error === startupFailure);
    await assert.rejects(openDesktopInstallation(f.paths), { code: 'ELOCKED' });
    await assert.rejects(lockfile.lock(options.sourceRoot, { lockfilePath: join(options.sourceRoot, 'controller.lock') }), { code: 'ELOCKED' });
    await absent(cutoverJournalPath(f.paths.appDataRoot));
    // These injected opens never acquired a database. Release only the fixture
    // leases whose retention was just verified; live uncertain DBs keep theirs.
    await lockfile.unlock(f.paths.dataDir, { lockfilePath: join(f.paths.dataDir, 'controller.lock') });
    await lockfile.unlock(f.paths.appDataRoot, { lockfilePath: join(f.paths.appDataRoot, 'desktop.lock') });
    await lockfile.unlock(options.sourceRoot, { lockfilePath: join(options.sourceRoot, 'controller.lock') });
  }
  let payloadChanged = false;
  await assert.rejects(activateDesktopMigration(options, { ...dependencies, openStore: async directory => {
    if (!payloadChanged) { payloadChanged = true; await writeFile(join(server, 'desktop-controller.js'), 'changed after initial payload check'); }
    return WorkspaceStore.open(directory);
  } }), /DESKTOP_PROVIDER_INPUT_INVALID/);
  await absent(cutoverJournalPath(f.paths.appDataRoot));
  await assertOperatingMigrationStartup(options.sourceRoot);
  await writeFile(join(server, 'desktop-controller.js'), files[1].text);
  const sourceLease = await lockfile.lock(options.sourceRoot, { lockfilePath: join(options.sourceRoot, 'controller.lock') });
  try { await assert.rejects(activateDesktopMigration(options, dependencies), { code: 'ELOCKED' }); }
  finally { await sourceLease(); }
  await assert.rejects(activateDesktopMigration(options, { ...dependencies, afterPhase: async phase => {
    if (phase === 'source-fenced') throw new Error('injected before budget');
  } }), /injected before budget/);
  assert.equal(JSON.parse(await readFile(join(f.targetLedger.directory, 'ledger.json'), 'utf8')).dailyLimit, 100);
  await assert.rejects(assertDesktopMigrationStartup(f.paths.appDataRoot, f.options.targetOwner), /CUTOVER_REQUIRED/);
  await assert.rejects(activateDesktopMigration(options, { ...dependencies, afterPhase: async phase => {
    if (phase === 'budget-imported') throw new Error('injected interruption');
  } }), /injected interruption/);
  await assert.rejects(assertDesktopMigrationStartup(f.paths.appDataRoot, f.options.targetOwner), /CUTOVER_REQUIRED/);
  await assert.rejects(assertOperatingMigrationStartup(options.sourceRoot), /CUTOVER_REQUIRED/);
  const budget = await OperationalModelBudget.open({ directory: f.targetLedger.directory, ownerKey: f.options.targetOwner });
  assert.equal((await budget.status()).dailyLimit, 200);
  const importedLedger = JSON.parse(await readFile(join(f.targetLedger.directory, 'ledger.json'), 'utf8'));
  assert.equal(importedLedger.usageImports.length, 1);
  await assert.rejects(activateDesktopMigration(options, { ...dependencies, afterPhase: async phase => {
    if (phase === 'generation-activated') throw new Error('injected after activation');
  } }), /injected after activation/);
  await assert.rejects(assertDesktopMigrationStartup(f.paths.appDataRoot, f.options.targetOwner), /CUTOVER_REQUIRED/);
  const committed = await activateDesktopMigration(options, dependencies);
  assert.equal(committed.phase, 'committed');
  await assertDesktopMigrationStartup(f.paths.appDataRoot, f.options.targetOwner);
  await assert.rejects(assertOperatingMigrationStartup(options.sourceRoot), /CUTOVER_REQUIRED/);
  const active = await activeStorage({ rootDir: f.paths.dataDir, backupDir: f.paths.backupDir, ownerKey: f.options.targetOwner });
  assert.equal(active.workspaceKey, prepared.receipt.prepared.workspaceKey);
  const store = await WorkspaceStore.open(join(active.dataDir, 'db'));
  try { assert.equal((await store.read()).operatorPaused, true); } finally { await store.close(); }
  assert.equal((await activateDesktopMigration(options, dependencies)).id, committed.id);
  assert.deepEqual(JSON.parse(await readFile(join(f.targetLedger.directory, 'ledger.json'), 'utf8')), importedLedger);
  assert.equal(f.runtime.calls.length, 0);
  assert.equal(f.runtime.spaces.get(committed.workspaceKey)!.get(f.sourceRunId)!['source-work.txt'], Buffer.from('source work preserved').toString('base64'));
});

test('prepare CLI requires explicit policy plan and revision without coercing partial or duplicate flags', () => {
  const directory = resolve(tmpdir(), 'prepare-arguments');
  const args = ['--source-export', join(directory, 'source'), '--source-receipt-sha256', 'a'.repeat(64), '--app-data-root', join(directory, 'app'),
    '--resources-root', join(directory, 'resources'), '--target-owner', randomUUID(), '--rollback-backup', join(directory, 'rollback'), '--receipt', join(directory, 'receipt.json'),
    '--source-daily-limit', '500', '--target-daily-limit', '100', '--planned-daily-limit', '200', '--target-budget-revision', '0'];
  assert.equal(prepareDesktopMigrationArguments(args).plannedDailyLimit, 200);
  for (const bad of [args.slice(0, -2), [...args, '--planned-daily-limit', '200'], [...args.slice(0, -1), '1.0'], [...args, '--activate', 'true']]) {
    assert.throws(() => prepareDesktopMigrationArguments(bad), fixedFailure);
  }
});

test('actual source/target stores prepare a sealed paused generation after rollback, without activation, budget merge, or execution', async t => {
  const f = await fixture(t), targetLedger = await readFile(join(f.targetLedger.directory, 'ledger.json'));
  const result = await prepareDesktopMigration(f.options, f.dependencies);
  assert.equal(f.opens, 1); assert.equal(f.closes, 1); assert.equal(f.runtime.calls.length, 0); assert.equal(f.runtime.observations.imports, 1);
  assert.equal(result.receipt.activated, false); assert.equal(result.receipt.budgetImported, false); assert.equal(result.receipt.databaseClosed, true);
  assert.equal(result.receipt.rollback.stateSha256, f.targetStateSha256);
  assert.equal(f.contexts[0].historicalAuthBindings![0].entrySha256, legacyWorkerEntrySha256[0]);
  assert.equal(f.contexts[0].historicalAuthBindings![0].pin.image, legacyManifest.image);
  assert.equal(result.receipt.budget.sourceDailyLimit, 500); assert.equal(result.receipt.budget.targetDailyLimit, 100); assert.equal(result.receipt.budget.plannedDailyLimit, 200);
  const storage = { rootDir: f.paths.dataDir, backupDir: f.paths.backupDir, ownerKey: f.options.targetOwner };
  const active = await activeStorage(storage); assert.equal(active.workspaceKey, f.options.targetOwner); assert.equal(active.dataDir, f.paths.dataDir);
  const layout = await loadStorageLayout(storage); assert.equal(layout.activeId, null); assert.equal(layout.restores.length, 1); assert.equal(layout.restores[0].ready, true);
  const original = await WorkspaceStore.open(join(f.paths.dataDir, 'db'));
  try { assert.equal(sha(JSON.stringify(await original.read())), f.targetStateSha256); } finally { await original.close(); }
  const staged = await WorkspaceStore.open(join(result.receipt.prepared.directory, 'db'));
  try { assert.equal((await staged.read()).operatorPaused, true); } finally { await staged.close(); }
  const sealed = await loadDesktopMigrationRuntime(result.receipt.prepared.directory, f.options.targetOwner, result.receipt.prepared.workspaceKey);
  assert.equal(sealed.historicalReleaseCatalogs[0].active.image, legacyManifest.image);
  assert.equal(f.runtime.spaces.get(f.options.targetOwner)!.get(f.targetRunId)!['target-work.txt'], Buffer.from('target original').toString('base64'));
  assert.equal(f.runtime.spaces.get(result.receipt.prepared.workspaceKey)!.get(f.sourceRunId)!['source-work.txt'], Buffer.from('source work preserved').toString('base64'));
  assert.deepEqual(await readFile(join(f.targetLedger.directory, 'ledger.json')), targetLedger);
  assert.equal((await readdir(f.targetLedger.directory)).some(name => name.startsWith('ledger.import.')), false);
  assert.deepEqual(await readDesktopMigrationPreparation(f.options.receiptPath, result.receiptSha256), result.receipt);
  await assert.rejects(readDesktopMigrationPreparation(f.options.receiptPath, '0'.repeat(64)), fixedFailure);
  const runtimePath = join(result.receipt.prepared.directory, 'migration-runtime.json'), runtimeRaw = await readFile(runtimePath);
  await writeFile(runtimePath, `${runtimeRaw.toString('utf8')}\n`); await assert.rejects(readDesktopMigrationPreparation(f.options.receiptPath, result.receiptSha256), fixedFailure);
  await writeFile(runtimePath, runtimeRaw);
  const receiptRaw = await readFile(f.options.receiptPath), inconsistent = { ...result.receipt,
    budget: { ...result.receipt.budget, sourceLedgerSha256: '0'.repeat(64) } };
  await writeFile(f.options.receiptPath, JSON.stringify(inconsistent));
  await assert.rejects(readDesktopMigrationPreparation(f.options.receiptPath, sha(JSON.stringify(inconsistent))), fixedFailure);
  await writeFile(f.options.receiptPath, receiptRaw);
  const rollbackState = join(f.options.rollbackBackup, 'state.json'), rollbackOriginal = await readFile(rollbackState);
  await writeFile(rollbackState, `${rollbackOriginal.toString('utf8')}\n`);
  await assert.rejects(readDesktopMigrationPreparation(f.options.receiptPath, result.receiptSha256), fixedFailure); await writeFile(rollbackState, rollbackOriginal);
  await assert.rejects(prepareDesktopMigration({ ...f.options, receiptPath: join(f.directory, 'second.json'), rollbackBackup: join(f.directory, 'second-rollback') }, f.dependencies), fixedFailure);
  assert.equal(f.opens, 1, 'preexisting restore records block before the original DB is reopened');
});

test('running installation, unknown identity and stale policies refuse before context, rollback or DB admission', async t => {
  const f = await fixture(t), running = await openDesktopInstallation(f.paths);
  try { await assert.rejects(prepareDesktopMigration(f.options, f.dependencies), error => {
    assert.ok(error instanceof DesktopMigrationPreparationError); assert.equal(error.phase, 'installation-lock'); assert.equal(error.causeCode, 'ELOCKED'); return true;
  }); } finally { await running.release(); }
  await assert.rejects(prepareDesktopMigration({ ...f.options, targetOwner: randomUUID() }, f.dependencies), fixedFailure);
  for (const values of [{ sourceDailyLimit: 499 }, { targetDailyLimit: 99 }, { targetBudgetRevision: 1 }]) {
    await assert.rejects(prepareDesktopMigration({ ...f.options, ...values }, f.dependencies), fixedFailure);
  }
  const identity = join(f.paths.appDataRoot, 'desktop-installation.json'); await rename(identity, `${identity}.saved`);
  await assert.rejects(prepareDesktopMigration(f.options, f.dependencies), fixedFailure); await absent(identity); await rename(`${identity}.saved`, identity);
  assert.equal(f.contexts.length, 0); assert.equal(f.opens, 0); await absent(f.options.receiptPath); await absent(join(f.options.rollbackBackup, 'manifest.json'));
  await assert.rejects(prepareDesktopMigration(f.options, { ...f.dependencies, openStore: async () => {
    throw new ServiceStartupCleanupError(new Error('private startup'), new Error('private cleanup'));
  } }), error => {
    assert.ok(error instanceof DesktopMigrationPreparationError); assert.equal(error.phase, 'database-open'); assert.equal(error.cleanupUncertain, true);
    assert.doesNotMatch(error.message, /private/); return true;
  });
  await assert.rejects(openDesktopInstallation(f.paths), { code: 'ELOCKED' });
  // This injection never opened a DB; release only the fixture's known-owned leases.
  await lockfile.unlock(f.paths.dataDir, { lockfilePath: join(f.paths.dataDir, 'controller.lock') });
  await lockfile.unlock(f.paths.appDataRoot, { lockfilePath: join(f.paths.appDataRoot, 'desktop.lock') });
});

test('failed volume import preserves original and rollback, retains incomplete staging, and emits no preparation receipt', async t => {
  const f = await fixture(t);
  f.runtime.observations.afterImport = async () => { throw new Error('private transport detail'); };
  await assert.rejects(prepareDesktopMigration(f.options, f.dependencies), error => {
    assert.match(String(error), fixedFailure); assert.doesNotMatch(String(error), /private transport/); return true;
  });
  assert.equal(f.opens, 1); assert.equal(f.closes, 1); assert.equal(f.runtime.calls.length, 0); await absent(f.options.receiptPath);
  const manifest = JSON.parse(await readFile(join(f.options.rollbackBackup, 'manifest.json'), 'utf8')); assert.equal(manifest.pinned, true);
  const config = { rootDir: f.paths.dataDir, backupDir: f.paths.backupDir, ownerKey: f.options.targetOwner }, layout = await loadStorageLayout(config);
  assert.equal(layout.activeId, null); assert.equal(layout.restores.length, 1); assert.equal(layout.restores[0].ready, false);
  const actual = await WorkspaceStore.open(join(f.paths.dataDir, 'db'));
  try { assert.equal(sha(JSON.stringify(await actual.read())), f.targetStateSha256); } finally { await actual.close(); }
  assert.equal(JSON.parse(await readFile(join(f.targetLedger.directory, 'ledger.json'), 'utf8')).dailyLimit, 100);
  const reopened = await openDesktopInstallation(f.paths); await reopened.release();
});

test('uncertain close of the separate staging DB keeps both installation leases and cannot publish success', async t => {
  const f = await fixture(t), originalOpen = WorkspaceStore.open;
  let stagedClosed = false;
  WorkspaceStore.open = async directory => {
    const store = await originalOpen(directory);
    if (directory && /^[a-f0-9-]{36}[\\/]db$/.test(relative(join(f.paths.dataDir, 'storage-tmp'), directory))) {
      const close = store.close.bind(store);
      store.close = async () => { await close(); stagedClosed = true; throw new Error('simulated uncertain staging close'); };
    }
    return store;
  };
  try {
    await assert.rejects(prepareDesktopMigration(f.options, f.dependencies), error => {
      assert.ok(error instanceof DesktopMigrationPreparationError); assert.equal(error.phase, 'prepare-import');
      assert.equal(error.cleanupUncertain, true); assert.equal(error.causeCode, '409'); return true;
    });
  } finally { WorkspaceStore.open = originalOpen; }
  assert.equal(stagedClosed, true); assert.equal(f.closes, 1); await absent(f.options.receiptPath);
  await assert.rejects(openDesktopInstallation(f.paths), { code: 'ELOCKED' });
  await assert.rejects(lockfile.lock(f.paths.dataDir, { lockfilePath: join(f.paths.dataDir, 'controller.lock'), retries: 0 }), { code: 'ELOCKED' });
  // Both real DB handles were closed before the injected error. Only the fixture
  // can release these known-owned locks for test cleanup; production retains them.
  await lockfile.unlock(f.paths.dataDir, { lockfilePath: join(f.paths.dataDir, 'controller.lock') });
  await lockfile.unlock(f.paths.appDataRoot, { lockfilePath: join(f.paths.appDataRoot, 'desktop.lock') });
});
