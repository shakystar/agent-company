import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import lockfile from 'proper-lockfile';
import { exportOperatingWorkspace, operatingWorkspaceExportArguments, OperatingExportError, readOperatingWorkspaceExport,
  type OperatingWorkspaceExportDependencies, type OperatingWorkspaceExportOptions } from '../scripts/export-operating-workspace.ts';
import { WorkspaceStore } from '../server/store.ts';
import { ServiceStartupCleanupError } from '../server/startup-cleanup.ts';
import { pinArtifactPreview } from '../server/artifact-preview.ts';
import { createWorkerReleaseManifest, stableRuntimeHash, workerSourceFiles } from '../shared/runtime-releases.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const absent = (path: string) => assert.rejects(readFile(path), { code: 'ENOENT' });
const fixedFailure = /운영 작업실 내보내기의 잠금·출처·보존 검증/;
const free = async () => 100 * 1024 ** 3;

class ExportRuntime extends StorageFixtureRuntime {
  readonly observations = { idle: [] as string[], exported: 0, blocked: false, afterExport: undefined as undefined | (() => Promise<void>) };
  constructor(key: string, readonly parent?: ExportRuntime) { super(key, parent?.spaces, parent?.calls); }
  override forkWorkspace(key: string) { return new ExportRuntime(key, this.parent ?? this); }
  async confirmDeploymentIdle() {
    const own = (this.parent ?? this).observations; own.idle.push(this.key);
    if (own.blocked) throw new Error('simulated sensitive Docker error must never escape');
  }
  override async exportWorkspace(runId: string, archive: string) {
    const own = (this.parent ?? this).observations; own.exported++;
    const result = await super.exportWorkspace(runId, archive); await own.afterExport?.(); return result;
  }
}

async function fixture(t: TestContext, realDatabase = false, activeGeneration = false, preview = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-operating-export-'));
  t.after(async () => {
    const path = resolve(directory), local = relative(resolve(tmpdir()), path);
    assert.ok(local.startsWith('ac-operating-export-') && !local.includes('..'));
    await rm(path, { recursive: true, force: true });
  });
  const sourceRoot = join(directory, 'source'), backupRoot = join(directory, 'old-backups');
  await mkdir(sourceRoot); await mkdir(backupRoot);
  const ownerKey = randomUUID(), workspaceKey = activeGeneration ? randomUUID() : ownerKey;
  const activeId = activeGeneration ? randomUUID() : null;
  const dataDir = activeGeneration ? join(sourceRoot, 'generations', activeId!) : sourceRoot;
  await mkdir(join(dataDir, 'files'), { recursive: true });
  await writeFile(join(sourceRoot, 'workspace-id'), `${ownerKey}\n`);
  if (activeId) await writeFile(join(sourceRoot, 'storage-layout.json'), JSON.stringify({ version: 1, ownerKey, activeId,
    generations: [{ id: activeId, workspaceKey }], restores: [] }));
  const manifest = createWorkerReleaseManifest({ image: `sha256:${'a'.repeat(64)}`, runtimeBaseHash: 'b'.repeat(64),
    sourceHashes: Object.fromEntries(workerSourceFiles.map(name => [name, 'c'.repeat(64)])) });
  const catalog = { version: 1, active: { image: manifest.image, manifestId: manifest.id }, manifests: [manifest] };
  await writeFile(join(sourceRoot, 'runtime-release.identity.json'), JSON.stringify({ version: 1, ownerKey }));
  await writeFile(join(sourceRoot, 'runtime-release.json'), JSON.stringify({ version: 2, ownerKey, target: { mode: 'docker', wslDistro: 'Fixture' },
    activeImage: manifest.image, previousImage: manifest.image, catalog, planHash: 'd'.repeat(64),
    history: [{ image: manifest.image, previousImage: manifest.image, action: 'activate', createdAt: '2026-09-12T00:00:00.000Z', sourceHashes: manifest.sourceHashes }] }));
  const identity = randomUUID(), budgetRoot = join(sourceRoot, 'operational-budget'); await mkdir(budgetRoot);
  await writeFile(join(budgetRoot, 'identity.json'), JSON.stringify({ version: 1, ownerKey, identity }));
  const ledger = { version: 1, ownerKey, identity, createdAt: '2026-09-12T00:00:00.000Z', revision: 0, dailyLimit: 100,
    projectDailyLimits: {}, starts: [], changes: [] };
  await writeFile(join(budgetRoot, 'ledger.json'), JSON.stringify(ledger));
  await writeFile(join(backupRoot, 'preserved.backup'), 'prior backup must survive');
  // Files outside the logical workspace are not discovered/copied by export.
  await mkdir(join(sourceRoot, '.codex')); await writeFile(join(sourceRoot, '.codex', 'auth.json'), 'fixture-account-not-to-read');
  await writeFile(join(sourceRoot, '.env'), 'fixture-environment-not-to-read');
  const options: OperatingWorkspaceExportOptions = { sourceRoot, backupRoot, destination: join(directory, 'export'),
    sourceOwner: ownerKey, wslExecutable: join(directory, 'wsl.exe'), distro: 'Fixture' };
  const runtime = new ExportRuntime(workspaceKey), runId = randomUUID(), agentId = randomUUID(), teamId = randomUUID(), fileId = randomUUID();
  runtime.spaces.get(workspaceKey)!.set(runId, { 'work.txt': Buffer.from('preserved volume work').toString('base64') });
  const blob = Buffer.from('shared logical original'); await writeFile(join(dataDir, 'files', `${fileId}.blob`), blob);
  let stateSha256: string | undefined, stateSemanticSha256: string | undefined;
  if (realDatabase) {
    const store = await WorkspaceStore.open(join(dataDir, 'db'));
    try {
      await store.change(state => {
        const at = '2026-09-12T00:00:00.000Z';
        state.agents.push({ id: agentId, name: 'Preserved agent', description: '', persona: 'Existing instructions', color: '#72836b', model: 'fixture',
          status: 'idle', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: at, updatedAt: at,
          workspaceRunId: runId });
        state.runs.push({ id: runId, agentId, agentVersion: 1, snapshotId: randomUUID(), prompt: 'Must not execute during export', status: 'queued',
          result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: null, completedAt: null });
        state.files.push({ id: fileId, scope: { type: 'team', id: teamId }, path: '.env', mediaType: 'text/plain', bytes: blob.length, sha256: sha(blob), createdAt: at });
        if (preview) {
          const scope = { type: 'team' as const, id: teamId };
          state.teams.push({ id: teamId, name: 'Preview scope', description: '', workflow: '', memberIds: [agentId], version: 1, createdAt: at, updatedAt: at });
          state.sharedArtifacts.push({ id: randomUUID(), scope, name: 'site/index.html', mediaType: 'text/html', content: '<!doctype html><title>Preserved preview</title>',
            version: 1, authorAgentId: agentId, history: [], createdAt: at, updatedAt: at });
          state.artifactPreviews!.push(pinArtifactPreview(state, { scope, prefix: 'site' }));
        }
      });
      stateSha256 = sha(JSON.stringify(await store.read()));
      stateSemanticSha256 = stableRuntimeHash(await store.read());
    } finally { await store.close(); }
  } else { await mkdir(join(dataDir, 'db')); await writeFile(join(dataDir, 'db', 'PG_VERSION'), '17\n'); }
  let opens = 0, closes = 0;
  const dependencies: OperatingWorkspaceExportDependencies = { freeSpace: free, createRuntime: async config => {
    assert.equal(config.auth, 'none'); assert.equal(config.authFile, ''); assert.equal(config.apiKey, undefined);
    assert.equal(config.wslDistro, undefined); assert.equal(config.image, manifest.image); return runtime;
  }, openStore: async path => {
    opens++; const store = await WorkspaceStore.open(path), close = store.close.bind(store);
    store.close = async () => { await close(); closes++; }; return store;
  } };
  return { directory, options, runtime, dependencies, dataDir, budgetRoot, ledger, identity, manifest, workspaceKey, runId, fileId,
    stateSha256, stateSemanticSha256, get opens() { return opens; }, get closes() { return closes; } };
}

test('export CLI arguments require every explicit target and reject duplicate/unknown/relative input', () => {
  const root = resolve(tmpdir(), 'ac-export-arguments');
  const args = ['--source-root', join(root, 'source'), '--backup-root', join(root, 'backups'), '--destination', join(root, 'new'),
    '--source-owner', randomUUID(), '--wsl-executable', join(root, 'wsl.exe'), '--distro', 'Fixture'];
  assert.equal(operatingWorkspaceExportArguments(args).distro, 'Fixture');
  for (const invalid of [args.slice(0, -2), [...args, '--distro', 'Another'], [...args, '--api-key', 'do-not-log'],
    ['--source-root', 'relative', ...args.slice(2)], [...args.slice(0, -1), 'invalid distro']]) {
    assert.throws(() => operatingWorkspaceExportArguments(invalid), fixedFailure);
  }
});

test('actual standalone DB export preserves queued state, shared blobs, volume, raw v1 ledger and active-generation ownership', async t => {
  const f = await fixture(t, true, true, true), sourceLedger = await readFile(join(f.budgetRoot, 'ledger.json'));
  const result = await exportOperatingWorkspace(f.options, f.dependencies);
  assert.equal(f.opens, 1); assert.equal(f.closes, 1); assert.equal(f.runtime.calls.length, 0);
  const backupStateBytes = await readFile(join(result.directory, 'backup', 'state.json')), backupState = JSON.parse(backupStateBytes.toString('utf8'));
  assert.notEqual(result.receipt.backup.stateSha256, f.stateSha256, 'Zod reconstructs preview property order differently from JSONB');
  assert.equal(result.receipt.backup.stateSha256, sha(backupStateBytes), 'receipt pins the actual raw archive bytes');
  assert.equal(stableRuntimeHash(backupState), f.stateSemanticSha256, 'key order is not a semantic state change');
  assert.equal(backupState.artifactPreviews.length, 1); assert.equal(result.receipt.source.workspaceKey, f.workspaceKey);
  assert.equal(result.receipt.databaseClosed, true); assert.ok(f.runtime.observations.idle.includes(f.options.sourceOwner));
  assert.ok(f.runtime.observations.idle.includes(f.workspaceKey)); assert.equal(f.runtime.observations.exported, 1);
  const checked = await readOperatingWorkspaceExport(result.directory, result.receiptSha256);
  assert.equal(checked.budget.ledgerRaw, sourceLedger.toString('utf8')); assert.equal(checked.budget.identity, f.identity);
  assert.equal(checked.release.version, 2); assert.equal(checked.backup.ownerKey, f.options.sourceOwner);
  const manifest = JSON.parse(await readFile(join(result.directory, 'backup', 'manifest.json'), 'utf8'));
  assert.equal(manifest.pinned, true); assert.equal(manifest.files.filter((file: { path: string }) => file.path.includes('.blob')).length, 1);
  assert.equal(await readFile(join(result.directory, 'backup', 'files', `${f.fileId}.blob`), 'utf8'), 'shared logical original');
  assert.equal(JSON.parse(await readFile(join(result.directory, 'backup', 'state.json'), 'utf8')).runs[0].status, 'queued');
  assert.equal(await readFile(join(f.options.backupRoot, 'preserved.backup'), 'utf8'), 'prior backup must survive');
  assert.deepEqual(await readFile(join(f.budgetRoot, 'ledger.json')), sourceLedger);
  await absent(join(f.budgetRoot, 'ledger.v1.original.json')); await absent(join(f.options.sourceRoot, 'storage-tmp', 'operation.json'));
  assert.deepEqual((await readdir(result.directory)).sort(), ['backup', 'export-receipt.json', 'operational-budget.json', 'source']);
  await absent(join(result.directory, '.env')); await absent(join(result.directory, '.codex', 'auth.json'));
  const reopened = await WorkspaceStore.open(join(f.dataDir, 'db'));
  try { assert.equal(sha(JSON.stringify(await reopened.read())), f.stateSha256); } finally { await reopened.close(); }
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), fixedFailure);
  assert.equal(f.opens, 1, 'an existing destination does not open the source DB');
  await assert.rejects(readOperatingWorkspaceExport(result.directory, '0'.repeat(64)), fixedFailure);
  const receiptPath = join(result.directory, 'export-receipt.json'), raw = await readFile(receiptPath);
  const tampered = { ...result.receipt, sourceFiles: [...result.receipt.sourceFiles, result.receipt.sourceFiles[0]] };
  await writeFile(receiptPath, JSON.stringify(tampered));
  await assert.rejects(readOperatingWorkspaceExport(result.directory, sha(JSON.stringify(tampered))), fixedFailure);
  await writeFile(receiptPath, raw);
  const sourceIdentity = join(result.directory, 'source', 'workspace-id');
  const original = await readFile(sourceIdentity); await writeFile(sourceIdentity, `${randomUUID()}\n`);
  await assert.rejects(readOperatingWorkspaceExport(result.directory, result.receiptSha256), fixedFailure); await writeFile(sourceIdentity, original);
  await writeFile(join(result.directory, 'credentials.json'), 'unexpected file');
  await assert.rejects(readOperatingWorkspaceExport(result.directory, result.receiptSha256), fixedFailure);
});

test('controller contention, pending release, wrong owner, missing database and linked metadata refuse before DB open', async t => {
  const f = await fixture(t), unlock = await lockfile.lock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock') });
  try { await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), error => {
    assert.ok(error instanceof OperatingExportError); assert.equal(error.phase, 'controller-lock'); assert.equal(error.causeCode, 'ELOCKED'); return true;
  }); } finally { await unlock(); }
  await assert.rejects(exportOperatingWorkspace({ ...f.options, sourceOwner: randomUUID() }, f.dependencies), fixedFailure);
  const pending = join(f.options.sourceRoot, 'runtime-release.pending.json'); await writeFile(pending, '{}');
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), fixedFailure); await rm(pending);
  const version = join(f.dataDir, 'db', 'PG_VERSION'); await rename(version, `${version}.saved`);
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), fixedFailure); await rename(`${version}.saved`, version);
  const release = join(f.options.sourceRoot, 'runtime-release.json'), linked = join(f.directory, 'linked-release.json'); await link(release, linked);
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), fixedFailure); await rm(linked);
  assert.equal(f.opens, 0); assert.equal(f.runtime.observations.idle.length, 0);
  await absent(join(f.options.destination, 'export-receipt.json'));
  const relock = await lockfile.lock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock'), retries: 0 }); await relock();
  await assert.rejects(exportOperatingWorkspace(f.options, { ...f.dependencies, openStore: async () => {
    throw new ServiceStartupCleanupError(new Error('private startup'), new Error('private close'));
  } }), error => {
    assert.ok(error instanceof OperatingExportError); assert.equal(error.phase, 'database-open'); assert.equal(error.cleanupUncertain, true); return true;
  });
  await assert.rejects(lockfile.lock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock'), retries: 0 }), { code: 'ELOCKED' });
  // No DB was opened by this injected startup failure; only the fixture clears its retained lease.
  await lockfile.unlock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock') });
});

test('source ledger partial state, overlap, disk floor and live worker never open the database or initialize missing metadata', async t => {
  const f = await fixture(t), ledgerPath = join(f.budgetRoot, 'ledger.json'); await rename(ledgerPath, `${ledgerPath}.saved`);
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), fixedFailure); await absent(ledgerPath);
  await rename(`${ledgerPath}.saved`, ledgerPath);
  for (const destination of [f.options.sourceRoot, join(f.options.sourceRoot, 'child'), join(f.options.backupRoot, 'child'), f.directory]) {
    await assert.rejects(exportOperatingWorkspace({ ...f.options, destination }, f.dependencies), fixedFailure);
  }
  await assert.rejects(exportOperatingWorkspace(f.options, { ...f.dependencies, freeSpace: async () => 20 * 1024 ** 3 }), error => {
    assert.ok(error instanceof OperatingExportError); assert.equal(error.phase, 'capacity'); assert.equal(error.causeCode, 'INVALID'); return true;
  });
  f.runtime.observations.blocked = true;
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), error => {
    assert.match(String(error), fixedFailure); assert.doesNotMatch(String(error), /sensitive Docker/); return true;
  });
  assert.equal(f.opens, 0); await absent(join(f.options.destination, 'export-receipt.json'));
});

test('a concurrent source metadata change after copy retains the protected backup but never publishes completion', async t => {
  const f = await fixture(t, true);
  f.runtime.observations.afterExport = async () => {
    const path = join(f.options.sourceRoot, 'runtime-release.json'); await writeFile(path, `${await readFile(path, 'utf8')}\n`);
  };
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), fixedFailure);
  assert.equal(f.opens, 1); assert.equal(f.closes, 1); assert.equal(f.runtime.calls.length, 0);
  await absent(join(f.options.destination, 'export-receipt.json'));
  assert.equal(JSON.parse(await readFile(join(f.options.destination, 'backup', 'manifest.json'), 'utf8')).pinned, true);
  assert.equal(await readFile(join(f.options.backupRoot, 'preserved.backup'), 'utf8'), 'prior backup must survive');
  const unlock = await lockfile.lock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock'), retries: 0 }); await unlock();
});

test('ledger change between snapshots, close failure and cancellation cannot publish an export receipt', async t => {
  const f = await fixture(t, true), initialLedger = await readFile(join(f.budgetRoot, 'ledger.json'));
  f.runtime.observations.afterExport = async () => { await writeFile(join(f.budgetRoot, 'ledger.json'), JSON.stringify({ ...f.ledger, dailyLimit: 99 })); };
  await assert.rejects(exportOperatingWorkspace(f.options, f.dependencies), fixedFailure);
  await absent(join(f.options.destination, 'export-receipt.json')); assert.equal(f.closes, 1);
  await writeFile(join(f.budgetRoot, 'ledger.json'), initialLedger); f.runtime.observations.afterExport = undefined;
  const closeOptions = { ...f.options, destination: join(f.directory, 'close-failure') };
  await assert.rejects(exportOperatingWorkspace(closeOptions, { ...f.dependencies, openStore: async path => {
    const store = await WorkspaceStore.open(path), close = store.close.bind(store); let closed = false;
    store.close = async () => { if (!closed) { await close(); closed = true; } throw new Error('close failed'); }; return store;
  } }), fixedFailure);
  await absent(join(closeOptions.destination, 'export-receipt.json'));
  await assert.rejects(lockfile.lock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock'), retries: 0 }), { code: 'ELOCKED' });
  // This fixture closed the actual DB before injecting the error. Only the test
  // releases its known-owned retained lease so subsequent independent cases run.
  await lockfile.unlock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock') });
  const aborted = new AbortController(), cancelOptions = { ...f.options, destination: join(f.directory, 'cancelled') };
  f.runtime.observations.afterExport = async () => { aborted.abort(); };
  await assert.rejects(exportOperatingWorkspace(cancelOptions, f.dependencies, aborted.signal), fixedFailure);
  await absent(join(cancelOptions.destination, 'export-receipt.json'));
  const unlock = await lockfile.lock(f.options.sourceRoot, { lockfilePath: join(f.options.sourceRoot, 'controller.lock'), retries: 0 }); await unlock();
  assert.equal(f.runtime.calls.length, 0);
});
