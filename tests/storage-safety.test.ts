import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { activeStorage, atomicJson, StorageError, StorageManager, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, limits?: StorageConfig['limits'], freeBytes = 100 * 1024 ** 3) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-storage-safety-'));
  const stores = new Set<WorkspaceStore>();
  t.after(async () => {
    for (const store of stores) await store.close();
    const suffix = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(suffix.startsWith('ac-storage-safety-') && !isAbsolute(suffix)
      && !suffix.split(/[\\/]/).includes('..'));
    const entry = await lstat(directory);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    await rm(directory, { recursive: true });
  });
  const config: StorageConfig = {
    rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'),
    ownerKey: randomUUID(), limits, freeSpace: async () => freeBytes,
  };
  const store = await WorkspaceStore.open(); stores.add(store);
  const runtime = new StorageFixtureRuntime(config.ownerKey);
  const host = () => ({ store, runtime, dataDir: config.rootDir });
  const manager = new StorageManager(config, host); await manager.initialize();
  return { directory, config, store, stores, runtime, host, manager };
}

test('a mutation queued on the former active store is rejected at execution time after a generation switch', async t => {
  const { store } = await fixture(t);
  let activeStore: WorkspaceStore | null = store;
  let guardCalls = 0;
  store.writeGuard = () => {
    guardCalls += 1;
    if (activeStore !== store) throw new StorageError(409, '활성 저장소가 변경되었습니다.');
  };
  const entered = deferred();
  const release = deferred();
  const maintenance = store.exclusive(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let mutationCalled = false;
  const staleMutation = store.change(state => { mutationCalled = true; state.operatorPaused = true; });
  const rejected = assert.rejects(staleMutation, { statusCode: 409 });
  try {
    assert.equal(guardCalls, 0, 'the check must not happen before the queued mutation executes');
    activeStore = null;
  } finally { release.resolve(); }
  await maintenance; await rejected;
  assert.equal(guardCalls, 1);
  assert.equal(mutationCalled, false);
  assert.equal((await store.read()).operatorPaused, false, 'the former generation must remain unchanged');
  activeStore = store;
  await store.change(state => { state.operatorPaused = true; });
  assert.equal((await store.read()).operatorPaused, true, 'a rejected mutation must not poison the queue');
});

test('concurrent disk admissions cannot reserve the same remaining data space and release returns capacity', async t => {
  const { manager } = await fixture(t, { dataBytes: 100, minFreeBytes: 0 });
  assert.equal((await manager.usage(true)).dataBytes, 0);
  const results = await Promise.allSettled([manager.reserveData('first', 60), manager.reserveData('second', 60)]);
  const accepted = results.filter((result): result is PromiseFulfilledResult<() => void> => result.status === 'fulfilled');
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(accepted.length, 1); assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof StorageError);
  assert.equal(rejected[0].reason.statusCode, 507);
  await assert.rejects(manager.reserveData('third', 41), { statusCode: 507 });
  accepted[0].value();
  const release = await manager.reserveData('entire-budget', 100);
  await assert.rejects(manager.reserveData('overflow', 1), { statusCode: 507 });
  release();
  const again = await manager.reserveData('entire-budget', 100); again();
});

test('disk reservations also protect physical free space and duplicate admission never releases an existing reservation', async t => {
  const { manager } = await fixture(t, { dataBytes: 1000, minFreeBytes: 20 }, 100);
  const first = await manager.reserveData('first', 60);
  await assert.rejects(manager.reserveData('first', 1), { statusCode: 409 });
  await assert.rejects(manager.reserveData('second', 21), { statusCode: 507 });
  const second = await manager.reserveData('second', 20);
  await assert.rejects(manager.reserveData('third', 1), { statusCode: 507 });
  first(); second();
  const final = await manager.reserveData('whole-free-reserve', 80); final();
});

test('restart repairs an owned restore moved before layout commit and allows a paused retry without changing the original store', async t => {
  const f = await fixture(t);
  const id = randomUUID(), restoredKey = randomUUID(), backupId = randomUUID(), runId = randomUUID();
  const moved = join(f.config.rootDir, 'generations', id);
  const staged = join(f.manager.temporary, id);
  await atomicJson(join(moved, 'operation.json'), { ownerKey: f.config.ownerKey, id });
  const prepared = await WorkspaceStore.open(join(moved, 'db'));
  try { await prepared.replace({ ...await f.store.read(), operatorPaused: true }); }
  finally { await prepared.close(); }
  const restoredRuntime = f.runtime.forkWorkspace(restoredKey);
  restoredRuntime.spaces.get(restoredKey)!.set(runId, { 'preserved.txt': Buffer.from('restored file').toString('base64') });
  await atomicJson(join(f.config.rootDir, 'storage-layout.json'), {
    version: 1, ownerKey: f.config.ownerKey, activeId: null, generations: [],
    restores: [{ id, workspaceKey: restoredKey, backupId, createdAt: new Date().toISOString(), ready: true }],
  });
  assert.equal((await activeStorage(f.config)).dataDir, resolve(f.config.rootDir));
  const restarted = new StorageManager(f.config, f.host);
  await restarted.initialize();
  await assert.rejects(lstat(moved), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(staged, 'operation.json'), 'utf8')), { ownerKey: f.config.ownerKey, id });
  assert.equal((await activeStorage(f.config)).dataDir, resolve(f.config.rootDir), 'recovery must not activate a restore implicitly');
  const activated = await restarted.activate(id); f.stores.add(activated.store);
  assert.equal((await activated.store.read()).operatorPaused, true);
  assert.equal((await f.store.read()).operatorPaused, false);
  assert.equal((await activeStorage(f.config)).dataDir, moved);
  assert.equal((await activeStorage(f.config)).workspaceKey, restoredKey);
  const file = await activated.runtime.downloadWorkspaceFile!(runId, 'preserved.txt');
  assert.equal(Buffer.from(file.contentBase64, 'base64').toString(), 'restored file');
  const layout = JSON.parse(await readFile(join(f.config.rootDir, 'storage-layout.json'), 'utf8'));
  assert.equal(layout.restores.length, 0);
  assert.deepEqual(layout.generations, [{ id, workspaceKey: restoredKey }]);
});
