import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { openDesktopMcpGrants, type DesktopMcpGrantCreate } from '../server/desktop-mcp-grants.ts';

type Store = Awaited<ReturnType<typeof openDesktopMcpGrants>>;
const invalid = { code: 'DESKTOP_MCP_GRANTS_INVALID', message: 'DESKTOP_MCP_GRANTS_INVALID', statusCode: 503 };
const denied = { code: 'DESKTOP_MCP_GRANT_DENIED', message: 'DESKTOP_MCP_GRANT_DENIED', statusCode: 403 };
const stale = { code: 'DESKTOP_MCP_GRANTS_STALE', statusCode: 409 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const request = (revision = 0): DesktopMcpGrantCreate => {
  const id = randomUUID(); return { revision, label: '외부 기획 도구', scope: { type: 'team', id }, submitTasks: true, budgetTeamId: id };
};
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-mcp-grants-')), ownerKey = randomUUID(), generationKey = randomUUID();
  const options: { appDataRoot: string; ownerKey: string; generationKey: string } = { appDataRoot: root, ownerKey, generationKey };
  const stores: Store[] = [];
  const ownerPath = join(root, 'desktop-installation.json'), path = join(root, 'desktop-mcp-grants.json');
  await writeFile(ownerPath, JSON.stringify({ version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: ownerKey }));
  t.after(async () => {
    await Promise.all(stores.map(store => store.close()));
    const location = relative(tmpdir(), root);
    assert.ok(location.startsWith('ac-desktop-mcp-grants-') && !isAbsolute(location) && !location.includes(sep));
    await rm(root, { recursive: true });
  });
  return { root, path, ownerPath, options, open: async (changes: Partial<typeof options> = {}) => {
    const store = await openDesktopMcpGrants({ ...options, ...changes }); stores.push(store); return store;
  } };
}

test('fresh grants store writes only hashes and preserves scoped DTOs and tokens across restart', async t => {
  const f = await fixture(t), store = await f.open();
  assert.deepEqual(await store.status(), { revision: 0, grants: [] });
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
  const input = request(), created = await store.create(input);
  assert.equal(created.revision, 1); assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(created.token, 'base64url').length, 32);
  const raw = await readFile(f.path, 'utf8'), stored = JSON.parse(raw);
  assert.equal(stored.grants[0].tokenHash, hash(created.token)); assert.ok(!raw.includes(created.token));
  const expected = { id: created.grant.id, label: input.label, scope: input.scope, submitTasks: true, budgetTeamId: input.budgetTeamId,
    createdAt: created.grant.createdAt, revokedAt: null, generationKey: f.options.generationKey };
  assert.deepEqual(created.grant, expected);
  const credential = { id: created.grant.id, token: created.token };
  assert.deepEqual(await store.withGrant(credential, async grant => grant), expected);
  const snapshot = await store.status(); snapshot.grants[0]!.scope.id = randomUUID(); created.grant.label = 'changed';
  assert.deepEqual((await store.status()).grants, [expected]);
  assert.ok(!JSON.stringify(snapshot).includes('tokenHash'));
  await store.close(); const reopened = await f.open();
  assert.deepEqual(await reopened.withGrant(credential, async grant => grant), expected);
  assert.deepEqual(await reopened.status(), { revision: 1, grants: [expected] });
});

test('old generation grants remain visible but cannot authenticate after restore', async t => {
  const f = await fixture(t), first = await f.open(), old = await first.create(request()); await first.close();
  const nextGeneration = randomUUID(), store = await f.open({ generationKey: nextGeneration });
  assert.equal((await store.status()).grants[0]!.generationKey, f.options.generationKey);
  await assert.rejects(store.withGrant({ id: old.grant.id, token: old.token }, async () => assert.fail()), denied);
  const current = await store.create({ ...request(1), scope: { type: 'project', id: randomUUID() }, submitTasks: false, budgetTeamId: null });
  assert.equal(current.grant.generationKey, nextGeneration);
  assert.equal(await store.withGrant({ id: current.grant.id, token: current.token }, async grant => grant.budgetTeamId), null);
});

test('revocation waits for the full preceding operation and rejects later admitted calls', async t => {
  const f = await fixture(t), store = await f.open(), created = await store.create(request());
  const credential = { id: created.grant.id, token: created.token }, entered = deferred(), finish = deferred(), events: string[] = [];
  const call = store.withGrant(credential, async () => { events.push('entered'); entered.resolve(); await finish.promise; events.push('completed'); return 7; });
  await entered.promise;
  const revocation = store.revoke({ revision: 1, id: created.grant.id }).then(value => { events.push('revoked'); return value; });
  const later = assert.rejects(store.withGrant(credential, async () => assert.fail('revoked callback must not execute')), denied);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(events, ['entered']);
  finish.resolve(); assert.equal(await call, 7);
  const revoked = await revocation; await later;
  assert.deepEqual(events, ['entered', 'completed', 'revoked']); assert.equal(revoked.revision, 2); assert.ok(revoked.grants[0]!.revokedAt);
  assert.deepEqual(await store.revoke({ revision: 2, id: created.grant.id }), revoked);
  await assert.rejects(store.revoke({ revision: 1, id: created.grant.id }), stale);
});

test('concurrent revision CAS allows exactly one create and snapshots input at admission', async t => {
  const f = await fixture(t), store = await f.open(), input = request(), expected = structuredClone(input);
  const first = store.create(input), second = assert.rejects(store.create(request()), stale);
  input.label = 'mutated'; input.scope.id = randomUUID(); input.budgetTeamId = null;
  const created = await first; await second;
  assert.equal(created.grant.label, expected.label); assert.deepEqual(created.grant.scope, expected.scope);
  assert.equal(created.grant.budgetTeamId, expected.budgetTeamId); assert.equal((await store.status()).grants.length, 1);
});

test('malformed credentials and input are redacted without poisoning valid stored grants', async t => {
  const f = await fixture(t), store = await f.open(), created = await store.create(request());
  const credential = { id: created.grant.id, token: created.token };
  for (const value of [null, {}, { ...credential, id: randomUUID() }, { ...credential, token: randomBytes(32).toString('base64url') },
    { ...credential, token: `${created.token}=` }, { ...credential, token: 'A'.repeat(42) + 'B' }, { ...credential, extra: 'PRIVATE_SENTINEL' }]) {
    await assert.rejects(store.withGrant(value as typeof credential, async () => assert.fail()), denied);
  }
  for (const value of [null, {}, { ...request(1), budgetTeamId: undefined }, { ...request(1), budgetTeamId: 'not-a-uuid' },
    { ...request(1), token: 'PRIVATE_SENTINEL' }, { ...request(1), scope: { type: 'agent', id: randomUUID() } }, { ...request(1), label: 'x'.repeat(101) }]) {
    await assert.rejects(store.create(value as DesktopMcpGrantCreate), invalid);
  }
  await assert.rejects(store.revoke(null as never), invalid);
  assert.equal(await store.withGrant(credential, async () => 'valid'), 'valid');
  assert.equal((await store.status()).revision, 1); assert.ok(!(await readFile(f.path, 'utf8')).includes('PRIVATE_SENTINEL'));
});

test('close rejects new admission and holds single-store ownership until callbacks and queued work finish', async t => {
  const f = await fixture(t), store = await f.open(), created = await store.create(request()), entered = deferred(), finish = deferred();
  const credential = { id: created.grant.id, token: created.token };
  const operation = store.withGrant(credential, async () => { entered.resolve(); await finish.promise; throw new Error('operation failure'); });
  const rejected = assert.rejects(operation, { message: 'operation failure' }); await entered.promise;
  const acceptedStatus = store.status(), closed = store.close();
  assert.equal(store.close(), closed);
  await assert.rejects(store.status(), { code: 'DESKTOP_MCP_GRANTS_CLOSED', statusCode: 503 });
  await assert.rejects(store.create(request(1)), { code: 'DESKTOP_MCP_GRANTS_CLOSED' });
  await assert.rejects(f.open(), { code: 'DESKTOP_MCP_GRANTS_BUSY' });
  finish.resolve(); await rejected; assert.equal((await acceptedStatus).revision, 1); await closed;
  assert.equal((await (await f.open()).status()).revision, 1);
});

test('same-process file tamper or loss permanently blocks status and grants without repair', async t => {
  for (const action of ['tamper', 'loss', 'owner', 'hardlink'] as const) {
    const f = await fixture(t), store = await f.open(), created = await store.create(request()), saved = await readFile(f.path);
    if (action === 'tamper') { const value = JSON.parse(saved.toString()); value.grants[0].label = 'changed externally'; await writeFile(f.path, JSON.stringify(value)); }
    if (action === 'loss') await rm(f.path);
    if (action === 'owner') await writeFile(f.ownerPath, JSON.stringify({ version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: randomUUID() }));
    if (action === 'hardlink') await link(f.path, join(f.root, 'alias.json'));
    await assert.rejects(store.status(), invalid);
    await assert.rejects(store.withGrant({ id: created.grant.id, token: created.token }, async () => assert.fail()), invalid);
    if (action === 'loss' || action === 'tamper') await writeFile(f.path, saved);
    await assert.rejects(store.status(), invalid); await assert.rejects(store.create(request(1)), invalid);
  }
});

test('fresh store does not adopt a ledger inserted after open', async t => {
  const f = await fixture(t), store = await f.open();
  const document = { version: 1, ownerKey: f.options.ownerKey, revision: 0, grants: [] };
  await writeFile(f.path, JSON.stringify(document)); await assert.rejects(store.status(), invalid);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), document);
  await rm(f.path); await assert.rejects(store.status(), invalid);
});

test('bounded strict UTF-8 documents reject foreign owner, schema, duplicate IDs and hashes', async t => {
  const f = await fixture(t), store = await f.open(); await store.create(request()); await store.close();
  const valid = JSON.parse(await readFile(f.path, 'utf8'));
  const variants: Array<string | Buffer> = ['', '{', 'null', Buffer.from([0xff]), 'x'.repeat(128 * 1024 + 1),
    JSON.stringify({ ...valid, ownerKey: randomUUID() }), JSON.stringify({ ...valid, extra: 'PRIVATE_SENTINEL' }),
    JSON.stringify({ ...valid, grants: [{ ...valid.grants[0], token: 'PRIVATE_SENTINEL' }] }),
    JSON.stringify({ ...valid, grants: [{ ...valid.grants[0], budgetTeamId: undefined }] }),
    JSON.stringify({ ...valid, grants: [valid.grants[0], { ...valid.grants[0], tokenHash: hash('different') }] }),
    JSON.stringify({ ...valid, grants: [valid.grants[0], { ...valid.grants[0], id: randomUUID() }] })];
  for (const value of variants) {
    await writeFile(f.path, value); await assert.rejects(f.open(), invalid); assert.deepEqual(await readFile(f.path), Buffer.from(value));
  }
  await writeFile(f.path, JSON.stringify(valid)); assert.equal((await (await f.open()).status()).revision, 1);
});

test('100 grant limit includes revoked entries and cannot be bypassed by reopening', async t => {
  const f = await fixture(t), store = await f.open(); await store.create(request()); await store.close();
  const document = JSON.parse(await readFile(f.path, 'utf8')), base = document.grants[0];
  document.grants = Array.from({ length: 100 }, (_, index) => ({ ...base, id: randomUUID(), tokenHash: hash(String(index)), revokedAt: new Date().toISOString() }));
  await writeFile(f.path, JSON.stringify(document)); const reopened = await f.open();
  await assert.rejects(reopened.create(request(1)), { code: 'DESKTOP_MCP_GRANTS_LIMIT', statusCode: 409 });
  assert.equal((await reopened.status()).grants.length, 100);
});

test('ordinary-file and canonical-parent checks reject links, directories and foreign installation identity', async t => {
  const f = await fixture(t), store = await f.open(); await store.create(request()); await store.close();
  await assert.rejects(f.open({ ownerKey: randomUUID() }), invalid);
  await assert.rejects(f.open({ generationKey: 'invalid' }), invalid);
  await assert.rejects(f.open({ appDataRoot: 'relative-root' }), invalid);
  await link(f.path, join(f.root, 'ledger-alias.json')); await assert.rejects(f.open(), invalid);
  await rm(f.path); await mkdir(f.path); await assert.rejects(f.open(), invalid); await rm(f.path, { recursive: true });
  const target = join(f.root, 'redirect'); await mkdir(target);
  await symlink(target, f.path, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.open(), invalid);
  assert.deepEqual(await readdir(target), []);
  const alias = join(f.root, 'parent-alias'); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.open({ appDataRoot: alias }), invalid);
});
