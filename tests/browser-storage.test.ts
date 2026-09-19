import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BROWSER_IMAGE_BYTES, type BrowserCapture } from '../shared/browser.ts';
import type { FileRecord } from '../shared/storage.ts';
import { BlobFiles } from '../server/files.ts';
import { StorageManager, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2E8AAAAASUVORK5CYII=', 'base64');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const timestamp = '2026-09-08T00:00:00.000Z';
const metadata = (record: { id: string; bytes: number; sha256: string }, type: 'agent' | 'team' | 'project' = 'agent'): BrowserCapture => ({
  ...record, runId: randomUUID(), agentId: randomUUID(), conversationId: null,
  scope: { type, id: randomUUID() }, createdAt: timestamp,
  mediaType: 'image/png', width: 390, height: 844, url: 'http://127.0.0.1:8080/index.html', sourceHash: 'c'.repeat(64),
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-browser-backup-'));
  const config: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: randomUUID(), freeSpace: async () => 100 * 1024 ** 3 };
  const store = await WorkspaceStore.open(), stores = new Set([store]);
  const runtime = new StorageFixtureRuntime(config.ownerKey);
  const manager = new StorageManager(config, () => ({ store, runtime, dataDir: config.rootDir }));
  await manager.initialize();
  const blobs = new BlobFiles(config.rootDir);
  t.after(async () => {
    for (const saved of stores) await saved.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-browser-backup-[^\\/]+$/);
    const entry = await lstat(directory); assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    await rm(directory, { recursive: true });
  });
  const capture = async (scope: 'agent' | 'team' | 'project' = 'agent') => {
    const saved = metadata(await blobs.put(png), scope);
    await store.change(state => { (state.browserCaptures ??= []).push(saved); });
    return saved;
  };
  return { config, store, stores, runtime, manager, blobs, capture };
}

async function rewriteState(directory: string, mutate: (state: any) => void) {
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  mutate(state);
  const bytes = Buffer.from(JSON.stringify(state));
  await writeFile(statePath, bytes);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  Object.assign(manifest.files.find((item: { path: string }) => item.path === 'state.json'), { bytes: bytes.length, sha256: hash(bytes) });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

test('browser evidence in all scopes survives independent backup/restore with its metadata and bytes', async t => {
  const f = await fixture(t);
  const captures = [];
  for (const scope of ['agent', 'team', 'project'] as const) captures.push(await f.capture(scope));
  const before = await f.store.read();
  const backup = await f.manager.backup();
  const directory = join(f.manager.backupRoot, backup.id);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  for (const capture of captures) {
    assert.ok(manifest.files.some((file: { path: string }) => file.path === `files/${capture.id}.blob`));
    assert.deepEqual(await readFile(join(directory, 'files', `${capture.id}.blob`)), png);
  }
  const prepared = await f.manager.prepareRestore(backup.id);
  const restored = await f.manager.activate(prepared.id); f.stores.add(restored.store);
  assert.deepEqual((await restored.store.read()).browserCaptures, captures);
  assert.equal((await restored.store.read()).operatorPaused, true);
  const restoredBlobs = new BlobFiles(restored.dataDir);
  for (const capture of captures) assert.deepEqual(await restoredBlobs.read(capture), png);
  assert.deepEqual(await f.store.read(), before);
  assert.equal(f.runtime.calls.length, 0);
});

test('private capture blobs are backed up without changing the exclusion of personal imported file blobs', async t => {
  const f = await fixture(t), capture = await f.capture();
  const shared = await f.blobs.put(Buffer.from('shared source'));
  const personal: FileRecord = { id: randomUUID(), scope: { type: 'agent', id: randomUUID() }, path: 'private.txt',
    bytes: 12, sha256: 'a'.repeat(64), createdAt: timestamp, mediaType: 'text/plain' };
  await f.store.change(state => {
    state.files.push(personal, { ...shared, scope: { type: 'project', id: randomUUID() }, path: 'source.txt', mediaType: 'text/plain', createdAt: timestamp });
  });
  // No personal blob exists: personal imported bytes are normally in volumes.
  const backup = await f.manager.backup();
  const directory = join(f.manager.backupRoot, backup.id);
  const files = await readdir(join(directory, 'files'));
  assert.deepEqual(files.sort(), [`${capture.id}.blob`, `${shared.id}.blob`].sort());
  const prepared = await f.manager.prepareRestore(backup.id);
  const restored = await f.manager.activate(prepared.id); f.stores.add(restored.store);
  assert.deepEqual((await restored.store.read()).files.find(file => file.id === personal.id), personal);
  assert.deepEqual(await new BlobFiles(restored.dataDir).read(capture), png);
});

test('missing capture bytes cannot publish or rotate backups and preserve the live evidence metadata', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) await f.manager.backup();
  const before = (await readdir(f.manager.backupRoot)).sort();
  const missing = metadata({ id: randomUUID(), bytes: png.length, sha256: hash(png) });
  await f.store.change(state => { state.browserCaptures = [missing]; });
  await assert.rejects(f.manager.backup(), /ENOENT|없습니다/);
  assert.deepEqual((await readdir(f.manager.backupRoot)).sort(), before);
  assert.deepEqual((await f.store.read()).browserCaptures, [missing]);
  assert.deepEqual(await readdir(f.manager.temporary), []);
});

test('capture backup checks both bytes and SHA-256 against persisted metadata', async t => {
  const f = await fixture(t), capture = await f.capture();
  for (const change of [{ bytes: capture.bytes + 1 }, { sha256: 'f'.repeat(64) }]) {
    await f.store.change(state => { state.browserCaptures = [{ ...capture, ...change }]; });
    await assert.rejects(f.manager.backup(), /캡처.*DB 기록과 일치하지/);
    assert.deepEqual(await f.manager.backups(), []);
    assert.deepEqual(await readdir(f.manager.temporary), []);
  }
});

test('restore rejects a capture missing from an otherwise coherent manifest before staging a generation', async t => {
  const f = await fixture(t), capture = await f.capture(), backup = await f.manager.backup();
  const directory = join(f.manager.backupRoot, backup.id), path = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files = manifest.files.filter((file: { path: string }) => file.path !== `files/${capture.id}.blob`);
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(f.manager.prepareRestore(backup.id), /캡처.*백업에 없습니다/);
  assert.deepEqual((await f.manager.status(false, false)).restores, []);
  assert.equal(f.runtime.spaces.size, 1);
});

test('restore detects corrupt capture bytes even if a forged manifest matches the changed blob', async t => {
  const f = await fixture(t), capture = await f.capture(), backup = await f.manager.backup();
  const directory = join(f.manager.backupRoot, backup.id), path = join(directory, 'files', `${capture.id}.blob`);
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
  await writeFile(path, changed);
  await assert.rejects(f.manager.prepareRestore(backup.id), /무결성/);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  Object.assign(manifest.files.find((file: { path: string }) => file.path === `files/${capture.id}.blob`), { bytes: changed.length, sha256: hash(changed) });
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.manager.prepareRestore(backup.id), /캡처.*DB 기록과 일치하지/);
  assert.deepEqual((await f.manager.status(false, false)).restores, []);
  assert.equal(f.runtime.spaces.size, 1);
});

test('restore validates capture metadata and collection shape despite coherent state hashes', async t => {
  const f = await fixture(t), capture = await f.capture(), backup = await f.manager.backup();
  const directory = join(f.manager.backupRoot, backup.id);
  const malformed = [null, {}, ['bad capture'],
    ...[{ id: '../secret' }, { runId: 'not-a-run' }, { agentId: 'not-an-agent' }, { conversationId: 'not-a-conversation' },
      { scope: { type: 'host', id: randomUUID() } }, { scope: { type: 'agent', id: '../private' } },
      { createdAt: 'yesterday' }, { bytes: 0 }, { bytes: BROWSER_IMAGE_BYTES + 1 }, { bytes: 1.5 },
      { sha256: 'not-a-hash' }, { sourceHash: 'not-a-hash' }, { mediaType: 'image/svg+xml' },
      { width: 0 }, { height: -1 }, { url: '' }, { url: 'x'.repeat(2049) }].map(change => [{ ...capture, ...change }]),
  ];
  for (const captures of malformed) {
    await rewriteState(directory, state => { state.browserCaptures = captures; });
    await assert.rejects(f.manager.prepareRestore(backup.id), /캡처 기록 형식/);
  }
  assert.deepEqual((await f.manager.status(false, false)).restores, []);
  assert.equal(f.runtime.spaces.size, 1);
});

test('duplicate capture IDs and collisions with ordinary file IDs fail before backup publication', async t => {
  const f = await fixture(t), capture = await f.capture();
  await f.store.change(state => { state.browserCaptures = [capture, capture]; });
  await assert.rejects(f.manager.backup(), /캡처 파일 ID가 중복/);
  await f.store.change(state => {
    state.browserCaptures = [capture];
    state.files = [{ id: capture.id, scope: capture.scope, path: 'same-id.png', mediaType: capture.mediaType,
      bytes: capture.bytes, sha256: capture.sha256, createdAt: capture.createdAt }];
  });
  await assert.rejects(f.manager.backup(), /캡처 파일 ID가 중복/);
  assert.deepEqual(await f.manager.backups(), []);
});

test('legacy backups without browser captures normalize only their restored copy', async t => {
  const f = await fixture(t), backup = await f.manager.backup();
  const directory = join(f.manager.backupRoot, backup.id);
  await rewriteState(directory, state => { delete state.browserCaptures; });
  const original = await readFile(join(directory, 'state.json'));
  await f.manager.pin(backup.id, true);
  const prepared = await f.manager.prepareRestore(backup.id);
  const restored = await f.manager.activate(prepared.id); f.stores.add(restored.store);
  assert.deepEqual((await restored.store.read()).browserCaptures, []);
  assert.deepEqual(await readFile(join(directory, 'state.json')), original);
  assert.equal(Object.hasOwn(JSON.parse(original.toString()), 'browserCaptures'), false);
});
