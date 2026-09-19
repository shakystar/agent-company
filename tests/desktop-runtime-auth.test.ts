import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { openDesktopAccountHome } from '../server/desktop-account-home.ts';
import { openDesktopRuntimeAuth } from '../server/desktop-runtime-auth.ts';

const seed = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'FAKE_PRIVATE_CREDENTIAL_INITIAL' } });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-runtime-auth-')), credentialsRoot = join(root, '개인 인증'), workspaceKey = randomUUID();
  t.after(async () => {
    const rel = relative(tmpdir(), root);
    assert.ok(rel.startsWith('ac-runtime-auth-') && !isAbsolute(rel) && !rel.includes(sep));
    await rm(root, { recursive: true });
  });
  const home = await openDesktopAccountHome(credentialsRoot, workspaceKey), authFile = join(home.directory, 'auth.json');
  await writeFile(authFile, seed); await home.release();
  let writer = false, checks = 0;
  const options = { credentialsRoot, workspaceKey, async assertNoWriters() { checks++; if (writer) throw new Error('PRIVATE_DOCKER_DIAGNOSTIC'); } };
  return { root, options, authFile, setWriter: (value: boolean) => { writer = value; }, checks: () => checks };
}
const redacted = (code: string) => (error: unknown) => {
  assert.ok(error instanceof Error && 'code' in error);
  assert.equal(error.code, code); assert.equal(error.message, code);
  assert.equal('cause' in error, false);
  assert.ok(!JSON.stringify(error).includes('PRIVATE'));
  return true;
};

test('runtime lease shares the account lock and preserves an in-place refreshed file without copying secrets', async t => {
  const f = await fixture(t), lease = await openDesktopRuntimeAuth(f.options);
  assert.equal(lease.authFile, f.authFile); assert.equal(f.checks(), 1);
  assert.deepEqual(Object.keys(lease).sort(), ['authFile', 'release', 'signal', 'validate']);
  try {
    await assert.rejects(openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey), { code: 'ELOCKED' });
    await assert.rejects(openDesktopRuntimeAuth(f.options), redacted('DESKTOP_RUNTIME_AUTH_BUSY'));
    const before = await lstat(f.authFile);
    const refreshed = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'FAKE_PRIVATE_CREDENTIAL_UPDATED' }, last_refresh: '2026-09-12T00:00:00Z' });
    await writeFile(f.authFile, refreshed); // Mirrors the pinned provider's truncate/write; no model or real token.
    assert.equal((await lstat(f.authFile)).ino, before.ino);
    await lease.validate();
    await Promise.all([lease.release(), lease.release()]);
    assert.equal(await readFile(f.authFile, 'utf8'), refreshed); assert.equal(f.checks(), 2);
    assert.equal(lease.signal.aborted, false);
    const account = await openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey); await account.release();
  } finally { await lease.release(); }
});

test('a stale host lock is insufficient: actual writer admission is checked before touching a missing auth file', async t => {
  const f = await fixture(t); await rm(f.authFile); f.setWriter(true);
  await assert.rejects(openDesktopRuntimeAuth(f.options), redacted('DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE'));
  assert.equal(f.checks(), 1);
  await assert.rejects(lstat(f.authFile), { code: 'ENOENT' });
  f.setWriter(false);
  await assert.rejects(openDesktopRuntimeAuth(f.options), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  const account = await openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey); await account.release();
});

test('release retains the shared lock until real writer cleanup succeeds, and can retry without starting another writer', async t => {
  const f = await fixture(t), lease = await openDesktopRuntimeAuth(f.options);
  try {
    f.setWriter(true);
    await assert.rejects(lease.release(), redacted('DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE'));
    await assert.rejects(lease.validate(), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
    await assert.rejects(openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey), { code: 'ELOCKED' });
    f.setWriter(false); await lease.release();
    assert.equal(await readFile(f.authFile, 'utf8'), seed);
    const account = await openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey); await account.release();
  } finally { f.setWriter(false); await lease.release(); }
});

test('starting release closes new and already pending validation before the account lease is unlocked', async t => {
  const f = await fixture(t);
  let calls = 0, entered!: () => void, finish!: () => void;
  const started = new Promise<void>(yes => { entered = yes; }), waiting = new Promise<void>(yes => { finish = yes; });
  const lease = await openDesktopRuntimeAuth({ ...f.options, assertNoWriters: async () => {
    if (++calls > 1) { entered(); await waiting; }
  } });
  const validating = assert.rejects(lease.validate(), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  const releasing = lease.release();
  await started;
  await validating;
  await assert.rejects(lease.validate(), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  await assert.rejects(openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey), { code: 'ELOCKED' });
  finish(); await releasing;
  const account = await openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey); await account.release();
});

test('replacement identity is refused and never overwritten; settled damage does not strand the login lock', async t => {
  const f = await fixture(t), lease = await openDesktopRuntimeAuth(f.options);
  const preserved = join(f.root, 'original-auth-fixture');
  await rename(f.authFile, preserved); await writeFile(f.authFile, '{"replacement":true}');
  await assert.rejects(lease.validate(), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  await assert.rejects(lease.release(), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  assert.equal(await readFile(preserved, 'utf8'), seed);
  assert.equal(await readFile(f.authFile, 'utf8'), '{"replacement":true}');
  const account = await openDesktopAccountHome(f.options.credentialsRoot, f.options.workspaceKey); await account.release();
});

test('invalid, non-object, invalid-UTF8 and oversized credentials are refused without secret diagnostics or repair', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from('PRIVATE_SECRET not-json'), Buffer.from('[]'), Buffer.from('null'),
    Buffer.from([0xff, 0xfe]), Buffer.alloc(1024 * 1024 + 1, 65), Buffer.alloc(0)]) {
    await writeFile(f.authFile, bytes);
    await assert.rejects(openDesktopRuntimeAuth(f.options), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
    assert.deepEqual(await readFile(f.authFile), bytes);
  }
});

test('auth hard links and other workspace owners cannot acquire the runtime binding', async t => {
  const f = await fixture(t), other = join(f.root, 'hard-auth');
  await link(f.authFile, other);
  await assert.rejects(openDesktopRuntimeAuth(f.options), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  await rm(other);
  await assert.rejects(openDesktopRuntimeAuth({ ...f.options, workspaceKey: randomUUID() }), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  assert.equal(await readFile(f.authFile, 'utf8'), seed);
});

test('a mandatory writer gate and explicit local paths are checked before any initialization', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  await assert.rejects(openDesktopRuntimeAuth({ ...f.options, assertNoWriters: undefined! }), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  await assert.rejects(openDesktopRuntimeAuth({ ...f.options, credentialsRoot: 'relative' }), redacted('DESKTOP_RUNTIME_AUTH_INVALID'));
  assert.deepEqual(await readdir(f.root), before);
});
