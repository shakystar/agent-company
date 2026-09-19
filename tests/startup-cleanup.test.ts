import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AgentService, ServiceStartupCleanupError } from '../server/service.ts';
import { WorkspaceStore } from '../server/store.ts';
import { StorageManager, StorageError, type StorageConfig } from '../server/storage.ts';
import type { RuntimeDriver } from '../shared/types.ts';

const runtime: RuntimeDriver = {
  async inspect() { throw new Error('Startup failure must precede runtime inspection'); },
  async execute() { throw new Error('Startup cleanup must never start a model'); },
};

test('real storage initialization failure closes the opened PGlite DB before rejecting and preserves its state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-startup-cleanup-')), dataDir = join(root, 'workspace', 'db');
  const storage: StorageConfig = { rootDir: join(root, 'workspace'), backupDir: join(root, 'backups'), ownerKey: randomUUID() };
  await mkdir(storage.rootDir);
  const seed = await WorkspaceStore.open(dataDir);
  await seed.change(state => { state.operatorPaused = true; }); await seed.close();
  await writeFile(join(storage.rootDir, 'storage-tmp'), 'Preserve this invalid-path fixture');
  const open = WorkspaceStore.open, close = WorkspaceStore.prototype.close, initialize = StorageManager.prototype.initialize;
  let opened: WorkspaceStore | undefined, closed = false, closeCalls = 0, initializationError: unknown;
  t.after(async () => { if (opened && !closed) await close.call(opened); await rm(root, { recursive: true, force: true }); });
  t.mock.method(WorkspaceStore, 'open', async (path?: string) => { opened = await open(path); return opened; });
  t.mock.method(WorkspaceStore.prototype, 'close', async function (this: WorkspaceStore) {
    closeCalls++; await close.call(this); closed = true;
  });
  t.mock.method(StorageManager.prototype, 'initialize', async function (this: StorageManager) {
    try { await initialize.call(this); } catch (error) { initializationError = error; throw error; }
  });
  await assert.rejects(AgentService.create({ dataDir, runtime, storage }), error => {
    assert.equal(error, initializationError); assert.ok(error instanceof StorageError); assert.equal(error.statusCode, 409);
    assert.equal(closed, true, 'DB cleanup must complete before the original initialization error escapes');
    return true;
  });
  assert.equal(closeCalls, 1); assert.ok(opened);
  await assert.rejects(opened.read(), /closed/i);
  const reopened = await open(dataDir);
  try { assert.equal((await reopened.read()).operatorPaused, true); }
  finally { await close.call(reopened); }
});

test('service initialization cleanup failure preserves both causes and marks the unreleased live database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-startup-cleanup-pending-')), dataDir = join(root, 'workspace', 'db');
  const startupError = new Error('injected storage initialization failure'), cleanupError = new Error('injected DB cleanup failure');
  const open = WorkspaceStore.open, close = WorkspaceStore.prototype.close;
  let opened: WorkspaceStore | undefined;
  t.after(async () => { if (opened) await close.call(opened); await rm(root, { recursive: true, force: true }); });
  t.mock.method(WorkspaceStore, 'open', async (path?: string) => { opened = await open(path); return opened; });
  t.mock.method(WorkspaceStore.prototype, 'close', async () => { throw cleanupError; });
  t.mock.method(StorageManager.prototype, 'initialize', async () => { throw startupError; });
  await assert.rejects(AgentService.create({ dataDir, runtime,
    storage: { rootDir: join(root, 'workspace'), backupDir: join(root, 'backups'), ownerKey: randomUUID() } }), error => {
    assert.ok(error instanceof ServiceStartupCleanupError); assert.equal(error.code, 'SERVICE_STARTUP_CLEANUP_PENDING');
    assert.deepEqual(error.errors, [startupError, cleanupError]); assert.equal(error.cause, startupError); return true;
  });
  assert.ok(opened);
  assert.ok(Array.isArray((await opened.read()).agents), 'the retained live DB is evidence that the owner must keep its lease');
});

test('failed initial SQL closes the actual PGlite instance before WorkspaceStore.open rejects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-store-open-cleanup-')), dataDir = join(root, 'db');
  const startupError = new Error('injected initial SQL failure');
  const exec = PGlite.prototype.exec, close = PGlite.prototype.close;
  let opened: PGlite | undefined, closed = false, closeCalls = 0;
  t.after(async () => { if (opened && !closed) await close.call(opened); await rm(root, { recursive: true, force: true }); });
  const mockExec = t.mock.method(PGlite.prototype, 'exec', async function (this: PGlite, ...args: Parameters<PGlite['exec']>) {
    const result = await exec.apply(this, args);
    if (args[0].includes('CREATE TABLE IF NOT EXISTS workspace_state')) { opened = this; throw startupError; }
    return result;
  });
  t.mock.method(PGlite.prototype, 'close', async function (this: PGlite) {
    if (this !== opened) return close.call(this);
    closeCalls++; await close.call(this); closed = true;
  });
  await assert.rejects(WorkspaceStore.open(dataDir), error => error === startupError && closed);
  assert.equal(closeCalls, 1); assert.ok(opened);
  await assert.rejects(opened.query('SELECT 1'), /closed/i);
  mockExec.mock.restore();
  const reopened = await WorkspaceStore.open(dataDir);
  try { assert.ok(Array.isArray((await reopened.read()).agents)); }
  finally { await reopened.close(); }
});

test('initial SQL and database-close failures preserve the same cleanup-pending contract before a store exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-store-open-pending-')), dataDir = join(root, 'db');
  const startupError = new Error('injected initial SQL failure'), cleanupError = new Error('injected PGlite close failure');
  const exec = PGlite.prototype.exec, close = PGlite.prototype.close;
  let opened: PGlite | undefined;
  t.after(async () => { if (opened) await close.call(opened); await rm(root, { recursive: true, force: true }); });
  t.mock.method(PGlite.prototype, 'exec', async function (this: PGlite, ...args: Parameters<PGlite['exec']>) {
    const result = await exec.apply(this, args);
    if (args[0].includes('CREATE TABLE IF NOT EXISTS workspace_state')) { opened = this; throw startupError; }
    return result;
  });
  t.mock.method(PGlite.prototype, 'close', async function (this: PGlite) {
    if (this === opened) throw cleanupError;
    await close.call(this);
  });
  await assert.rejects(WorkspaceStore.open(dataDir), error => {
    assert.ok(error instanceof ServiceStartupCleanupError); assert.equal(error.code, 'SERVICE_STARTUP_CLEANUP_PENDING');
    assert.deepEqual(error.errors, [startupError, cleanupError]); assert.equal(error.cause, startupError); return true;
  });
  assert.ok(opened); assert.equal((await opened.query<{ value: number }>('SELECT 1 AS value')).rows[0].value, 1);
});
