import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { artifactPreviewArchive, pinArtifactPreview, resolveArtifactPreview } from '../server/artifact-preview.ts';
import { activeStorage, StorageError, StorageManager, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

const timestamp = '2026-09-11T00:00:00.000Z';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-preview-backup-'));
  const config: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'),
    ownerKey: randomUUID(), freeSpace: async () => 100 * 1024 ** 3 };
  const store = await WorkspaceStore.open(), stores = new Set([store]);
  const runtime = new StorageFixtureRuntime(config.ownerKey);
  const manager = new StorageManager(config, () => ({ store, runtime, dataDir: config.rootDir }));
  await manager.initialize();
  const scope = { type: 'project' as const, id: randomUUID() }, artifactId = randomUUID();
  await store.change(state => {
    state.projects.push({ id: scope.id, name: 'Static preview fixture', description: '', teamIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp });
    state.sharedArtifacts.push({ id: artifactId, scope, name: 'site/index.html', mediaType: 'text/html',
      version: 2, content: '<h1>Current v2</h1>', authorAgentId: null, createdAt: timestamp, updatedAt: timestamp,
      history: [{ version: 1, content: '<h1>Original v1</h1>', authorAgentId: null, createdAt: timestamp }] });
    state.artifactPreviews = [pinArtifactPreview(state, { scope, prefix: 'site', versions: [{ artifactId, version: 1 }] })];
  });
  const preview = (await store.read()).artifactPreviews![0];
  t.after(async () => {
    for (const saved of stores) await saved.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-preview-backup-[^\\/]+$/);
    const entry = await lstat(directory); assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    await rm(directory, { recursive: true });
  });
  return { config, directory, store, stores, runtime, manager, scope, preview, artifactId };
}

async function rewriteState(directory: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(join(directory, 'state.json'), bytes);
  const path = join(directory, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(manifest.files.find((entry: { path: string }) => entry.path === 'state.json'), { bytes: bytes.length, sha256: hash(bytes) });
  await writeFile(path, JSON.stringify(manifest));
}

test('backup restores pinned historical artifacts without duplicate blobs, changing the original or starting a worker', async t => {
  const f = await fixture(t), before = await f.store.read();
  const archive = artifactPreviewArchive(before, f.preview);
  const backup = await f.manager.backup(), directory = join(f.manager.backupRoot, backup.id);
  assert.deepEqual(await readdir(join(directory, 'files')), []);
  assert.deepEqual(await readdir(join(directory, 'volumes')), []);
  const preserved = await readFile(join(directory, 'state.json'));
  await f.store.change(state => {
    const artifact = state.sharedArtifacts[0];
    artifact.history.push({ version: artifact.version, content: artifact.content, authorAgentId: null, createdAt: timestamp });
    artifact.version = 3; artifact.content = '<h1>After backup v3</h1>';
  });
  const originalAfter = await f.store.read();
  const prepared = await f.manager.prepareRestore(backup.id), restored = await f.manager.activate(prepared.id);
  f.stores.add(restored.store);
  const state = await restored.store.read();
  assert.deepEqual(state.artifactPreviews, before.artifactPreviews);
  assert.deepEqual(state.sharedArtifacts, before.sharedArtifacts);
  assert.equal(state.operatorPaused, true);
  assert.deepEqual(artifactPreviewArchive(state, state.artifactPreviews![0]), archive);
  assert.equal(resolveArtifactPreview(state, state.artifactPreviews![0]).files.get('index.html')!.bytes.toString(), '<h1>Original v1</h1>');
  assert.deepEqual(await f.store.read(), originalAfter);
  assert.deepEqual(await readFile(join(directory, 'state.json')), preserved);
  assert.equal(f.runtime.calls.length, 0);
});

test('legacy backup without previews restores an empty collection without rewriting original bytes', async t => {
  const f = await fixture(t), backup = await f.manager.backup(), directory = join(f.manager.backupRoot, backup.id);
  const value = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  delete value.artifactPreviews;
  await rewriteState(directory, value);
  const bytes = await readFile(join(directory, 'state.json'));
  const prepared = await f.manager.prepareRestore(backup.id), restored = await f.manager.activate(prepared.id);
  f.stores.add(restored.store);
  assert.deepEqual((await restored.store.read()).artifactPreviews, []);
  assert.deepEqual(await readFile(join(directory, 'state.json')), bytes);
  assert.equal(Object.hasOwn(JSON.parse(bytes.toString()), 'artifactPreviews'), false);
});

test('restore rejects malformed preview collections, duplicate IDs and mismatched hashes despite coherent backup checksums', async t => {
  const f = await fixture(t), backup = await f.manager.backup(), directory = join(f.manager.backupRoot, backup.id);
  const baseline = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  const malformed = [null, {}, 'invalid', ['invalid'], [{ ...f.preview, schemaVersion: 99 }],
    [{ ...f.preview, id: '../secret' }], [f.preview, f.preview],
    [{ ...f.preview, sourceHash: '0'.repeat(64) }], [{ ...f.preview, totalBytes: f.preview.totalBytes + 1 }],
    [{ ...f.preview, entries: f.preview.entries.map(entry => ({ ...entry, path: '../secret.html' })) }],
  ];
  for (const previews of malformed) {
    const state = structuredClone(baseline); state.artifactPreviews = previews;
    await rewriteState(directory, state);
    await assert.rejects(f.manager.prepareRestore(backup.id), error => error instanceof StorageError && error.statusCode === 409 && /미리보기/.test(error.message));
    assert.deepEqual(await readdir(f.manager.temporary), []);
  }
  assert.deepEqual((await f.manager.status(false, false)).restores, []);
  assert.equal(f.runtime.spaces.size, 1);
  assert.deepEqual((await f.store.read()).artifactPreviews, [f.preview]);
});

test('missing historical source, removed scope and edited historical bytes fail before staging a restore', async t => {
  const f = await fixture(t), backup = await f.manager.backup(), directory = join(f.manager.backupRoot, backup.id);
  const baseline = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as WorkspaceState;
  const changes: Array<(state: WorkspaceState) => void> = [
    state => { state.sharedArtifacts[0].history = []; },
    state => { state.sharedArtifacts = []; },
    state => { state.projects = []; },
    state => { state.sharedArtifacts[0].history[0].content += 'changed'; },
    state => { state.sharedArtifacts[0].scope = { type: 'team', id: randomUUID() }; },
    state => { state.sharedArtifacts[0].name = 'other/index.html'; },
  ];
  for (const change of changes) {
    const state = structuredClone(baseline); change(state);
    await rewriteState(directory, state);
    await assert.rejects(f.manager.prepareRestore(backup.id), /고정 미리보기 원문·범위·해시/);
    assert.deepEqual(await readdir(f.manager.temporary), []);
  }
  assert.equal(f.runtime.calls.length, 0);
});

test('malformed preview evidence remains readable for diagnosis but cannot publish or rotate backups', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.manager.backup();
  const backups = (await readdir(f.manager.backupRoot)).sort();
  await f.store.change(state => { (state as unknown as { artifactPreviews: unknown }).artifactPreviews = 'invalid but readable'; });
  assert.equal((await f.store.read()).artifactPreviews, 'invalid but readable');
  await assert.rejects(f.manager.backup(), /미리보기 기록 형식/);
  assert.deepEqual((await readdir(f.manager.backupRoot)).sort(), backups);
  assert.deepEqual(await readdir(f.manager.temporary), []);
  assert.equal((await f.store.read()).artifactPreviews, 'invalid but readable');
});

test('activation revalidates a previously staged source and retains the active generation when it changed', async t => {
  const f = await fixture(t), original = await f.store.read(), backup = await f.manager.backup();
  const prepared = await f.manager.prepareRestore(backup.id);
  const staged = await WorkspaceStore.open(join(f.manager.temporary, prepared.id, 'db'));
  try { await staged.change(state => { state.sharedArtifacts[0].history[0].content = 'tampered after staging'; }); }
  finally { await staged.close(); }
  await assert.rejects(f.manager.activate(prepared.id), /고정 미리보기 원문·범위·해시/);
  assert.deepEqual(await activeStorage(f.config), { dataDir: resolve(f.config.rootDir), workspaceKey: f.config.ownerKey });
  assert.deepEqual(await f.store.read(), original);
  assert.ok((await readdir(f.manager.temporary)).includes(prepared.id), 'Preserve failed staged copy for diagnosis');
  assert.equal(f.runtime.calls.length, 0);
});
