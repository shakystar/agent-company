import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';

async function fixture(t: TestContext) {
  const store = await WorkspaceStore.open();
  t.after(() => store.close());
  // Inspect the real PostgreSQL counters, not a query mock or an application
  // counter that could miss row-lock WAL and unnecessary aggregate rewrites.
  const db = (store as unknown as { db: PGlite }).db;
  const position = async () => (await db.query<{ revision: string; wal: string }>(
    'SELECT revision::text, pg_current_wal_insert_lsn()::text AS wal FROM workspace_state WHERE singleton = true',
  )).rows[0];
  return { store, db, position };
}

test('unchanged change, changeLocked and replace leave both revision and actual WAL position fixed', async t => {
  const { store, db, position } = await fixture(t);
  const initial = await store.read();
  const beforeLock = await position();
  await db.transaction(tx => tx.query('SELECT value FROM workspace_state WHERE singleton = true FOR UPDATE'));
  const before = await position();
  assert.notEqual(before.wal, beforeLock.wal, 'the probe must detect the original row-lock-only WAL defect');
  assert.equal(before.revision, beforeLock.revision);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await store.change(state => state.agents.length), 0);
    await store.exclusive(() => store.changeLocked(state => { state.operatorPaused = false; }));
    await store.replace(initial);
  }
  assert.deepEqual(await position(), before);
  assert.deepEqual(await store.read(), initial);
});

test('real and concurrent mutations are serialized, with exactly one revision per changed state', async t => {
  const { store, position } = await fixture(t);
  const before = await position();
  const results = await Promise.all(Array.from({ length: 24 }, () => store.change(state => {
    const next = Number(state.messageOrigins.counter ?? 0) + 1;
    state.messageOrigins.counter = String(next);
    return next;
  })));
  assert.deepEqual(results, Array.from({ length: 24 }, (_, index) => index + 1));
  assert.equal((await store.read()).messageOrigins.counter, '24');
  const after = await position();
  assert.equal(BigInt(after.revision), BigInt(before.revision) + 24n);
  assert.notEqual(after.wal, before.wal);
  await store.exclusive(() => store.changeLocked(state => { state.operatorPaused = true; }));
  assert.equal(BigInt((await position()).revision), BigInt(after.revision) + 1n);
});

test('mutator, serialization and result-cloning failures leave state intact and do not poison the queue', async t => {
  const { store, position } = await fixture(t);
  const before = await position();
  const initial = await store.read();
  await assert.rejects(store.change(state => { state.operatorPaused = true; throw new Error('mutation failed'); }), /mutation failed/);
  await assert.rejects(store.change(state => {
    (state as unknown as { circular: unknown }).circular = state;
  }), /circular/i);
  await assert.rejects(store.change(state => { state.operatorPaused = true; return () => 'not cloneable'; }), /clone/i);
  assert.deepEqual(await store.read(), initial);
  assert.deepEqual(await position(), before);
  await store.change(state => { state.operatorPaused = true; });
  assert.equal((await store.read()).operatorPaused, true);
  assert.equal(BigInt((await position()).revision), BigInt(before.revision) + 1n);
});

test('JSON-equivalent object order, omitted properties and numeric encodings are not state changes', async t => {
  const { store, position } = await fixture(t);
  type JsonFixture = WorkspaceState & { jsonFixture: Record<string, unknown> };
  await store.change(state => {
    (state as JsonFixture).jsonFixture = { alpha: 1, beta: 2, empty: null, zero: 0, list: [null] };
  });
  const before = await position();
  await store.change(state => {
    (state as JsonFixture).jsonFixture = { list: [undefined], zero: -0, empty: Number.NaN, beta: 2, alpha: 1, omitted: undefined };
  });
  const same = await store.read() as JsonFixture;
  same.jsonFixture = { list: [null], zero: 0, empty: null, beta: 2, alpha: 1 };
  await store.replace(same);
  assert.deepEqual(await position(), before);
  await store.change(state => { (state as JsonFixture).jsonFixture.list = [null, null]; });
  assert.equal(BigInt((await position()).revision), BigInt(before.revision) + 1n, 'array content remains significant');
});

test('normalization of legacy state is preserved once, without repeated empty writes', async t => {
  const { store, db, position } = await fixture(t);
  await db.query("UPDATE workspace_state SET value = value - 'browserCaptures' - 'executionStates' - 'operatorPaused' WHERE singleton = true");
  const before = await position();
  assert.deepEqual((await store.read()).browserCaptures, []);
  assert.deepEqual(await position(), before, 'read must not persist its defaults');
  await store.change(() => undefined);
  const normalized = await position();
  assert.equal(BigInt(normalized.revision), BigInt(before.revision) + 1n);
  const raw = (await db.query<{ value: WorkspaceState }>('SELECT value FROM workspace_state WHERE singleton = true')).rows[0].value;
  assert.deepEqual(raw.browserCaptures, []);
  assert.deepEqual(raw.executionStates, {});
  assert.equal(raw.operatorPaused, false);
  await store.change(() => undefined);
  await store.replace(await store.read());
  assert.deepEqual(await position(), normalized);
});

test('returned data stays detached and a queued stale-store write is guarded before its mutator runs', async t => {
  const { store, position } = await fixture(t);
  const returned = await store.change(state => {
    state.messageOrigins.first = 'stored';
    return state.messageOrigins;
  });
  returned.first = 'caller mutation';
  assert.equal((await store.read()).messageOrigins.first, 'stored');
  let release!: () => void;
  const held = store.exclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await new Promise<void>(resolve => setImmediate(resolve));
  const before = await position();
  let active = true, calls = 0;
  store.writeGuard = () => { if (!active) throw new Error('inactive store'); };
  const queued = store.change(() => { calls += 1; });
  const rejection = assert.rejects(queued, /inactive store/);
  active = false;
  release();
  await held; await rejection;
  assert.equal(calls, 0);
  assert.deepEqual(await position(), before);
  active = true;
  await store.change(() => { calls += 1; });
  assert.equal(calls, 1);
  assert.deepEqual(await position(), before);
});

test('replacement preserves its complete snapshot across reopen and an identical restore does not revise it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-store-noop-'));
  let store: WorkspaceStore | undefined;
  t.after(async () => {
    await store?.close();
    const suffix = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(suffix.startsWith('ac-store-noop-') && !isAbsolute(suffix) && !suffix.split(/[\\/]/).includes('..'));
    await rm(directory, { recursive: true });
  });
  store = await WorkspaceStore.open(directory);
  const state = await store.read();
  state.operatorPaused = true;
  state.messageOrigins = { durable: 'preserved' };
  await store.replace(state);
  await store.close(); store = undefined;
  store = await WorkspaceStore.open(directory);
  assert.deepEqual(await store.read(), state);
  const db = (store as unknown as { db: PGlite }).db;
  const readPosition = async () => (await db.query<{ revision: string; wal: string }>(
    'SELECT revision::text, pg_current_wal_insert_lsn()::text AS wal FROM workspace_state WHERE singleton = true',
  )).rows[0];
  const before = await readPosition();
  assert.equal(before.revision, '1');
  await store.replace(state);
  assert.deepEqual(await readPosition(), before);
});
