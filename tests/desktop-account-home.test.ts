import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import lockfile from 'proper-lockfile';
import { openDesktopAccountHome } from '../server/desktop-account-home.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-account-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, credentials: join(root, '개인 인증'), workspaceKey: randomUUID() };
}
const marker = (workspaceKey: string) => JSON.stringify({ version: 1, product: 'agent-company-desktop-codex', workspaceKey });

test('desktop Codex home uses a fixed child and preserves only its own identity and auth across reopen', async t => {
  const f = await fixture(t), first = await openDesktopAccountHome(f.credentials, f.workspaceKey);
  assert.equal(first.directory, join(f.credentials, 'codex'));
  const markerPath = join(first.directory, 'desktop-codex-home.json');
  assert.equal(await readFile(markerPath, 'utf8'), marker(f.workspaceKey));
  await writeFile(join(first.directory, 'auth.json'), 'private test bytes are preserved, not interpreted');
  await mkdir(join(first.directory, 'nested'));
  await writeFile(join(first.directory, 'nested', 'config.toml'), 'fixture');
  await Promise.all([first.release(), first.release()]);
  await first.release();
  assert.equal(first.signal.aborted, false);
  assert.deepEqual(await readdir(f.credentials), ['codex']);
  const next = await openDesktopAccountHome(f.credentials, f.workspaceKey);
  try {
    assert.equal(next.directory, first.directory);
    assert.equal(await readFile(join(next.directory, 'auth.json'), 'utf8'), 'private test bytes are preserved, not interpreted');
    assert.equal(await readFile(markerPath, 'utf8'), marker(f.workspaceKey));
  } finally { await next.release(); }
});

test('desktop Codex home requires an absolute non-root path and a UUID before filesystem changes', async t => {
  const f = await fixture(t);
  await assert.rejects(openDesktopAccountHome('relative', f.workspaceKey), /절대 경로/);
  await assert.rejects(openDesktopAccountHome(parse(f.root).root, f.workspaceKey), /파일시스템 루트/);
  await assert.rejects(openDesktopAccountHome(`${f.credentials}\0`, f.workspaceKey), /절대 경로/);
  await assert.rejects(openDesktopAccountHome(f.credentials, 'not-a-uuid'));
  assert.deepEqual(await readdir(f.root), []);
});

test('desktop Codex home excludes simultaneous login holders without retries and permits reopen after release', async t => {
  const f = await fixture(t);
  const opened = await Promise.allSettled([
    openDesktopAccountHome(f.credentials, f.workspaceKey), openDesktopAccountHome(f.credentials, f.workspaceKey),
  ]);
  assert.equal(opened.filter(value => value.status === 'fulfilled').length, 1);
  const failed = opened.find(value => value.status === 'rejected');
  assert.equal(failed?.status === 'rejected' && failed.reason.code, 'ELOCKED');
  const held = opened.find(value => value.status === 'fulfilled');
  assert.ok(held?.status === 'fulfilled');
  try {
    await assert.rejects(lockfile.lock(held.value.directory, { lockfilePath: join(f.credentials, 'codex.login.lock'), retries: 0 }), { code: 'ELOCKED' });
  } finally { await held.value.release(); }
  const reopened = await openDesktopAccountHome(f.credentials, f.workspaceKey); await reopened.release();
});

test('unmarked existing auth is preserved and never adopted; failed validation releases the login lease', async t => {
  const f = await fixture(t), directory = join(f.credentials, 'codex');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'auth.json'), 'existing unrelated credential fixture');
  await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey), /자동 선택/);
  assert.deepEqual(await readdir(f.credentials), ['codex']);
  assert.deepEqual(await readdir(directory), ['auth.json']);
  assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), 'existing unrelated credential fixture');
});

test('wrong owner, malformed, oversized and redirected markers fail without rewriting original content', async t => {
  const f = await fixture(t), directory = join(f.credentials, 'codex');
  const home = await openDesktopAccountHome(f.credentials, f.workspaceKey); await home.release();
  const markerPath = join(directory, 'desktop-codex-home.json');
  for (const document of [marker(randomUUID()), '{broken', 'x'.repeat(4097), marker(f.workspaceKey).replace('agent-company-desktop-codex', 'other-product')]) {
    await writeFile(markerPath, document);
    await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey));
    assert.equal(await readFile(markerPath, 'utf8'), document);
    assert.deepEqual(await readdir(f.credentials), ['codex']);
  }
  await rm(markerPath); await mkdir(markerPath);
  await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey), /식별 파일/);
  assert.ok((await lstat(markerPath)).isDirectory());
});

test('redirected parent or Codex directories are rejected before an external marker is created', async t => {
  const f = await fixture(t), outside = join(f.root, '다른 위치');
  await mkdir(outside);
  await symlink(outside, f.credentials, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey), /링크|다른 위치/);
  assert.deepEqual(await readdir(outside), []);
  await rm(f.credentials); await mkdir(f.credentials);
  await symlink(outside, join(f.credentials, 'codex'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey), /링크|다른 위치/);
  assert.deepEqual(await readdir(outside), []);
});

test('owned Codex home rejects linked credentials and nested redirected directories without reading their contents', async t => {
  const f = await fixture(t), home = await openDesktopAccountHome(f.credentials, f.workspaceKey); await home.release();
  const original = join(f.root, 'private-fixture');
  await writeFile(original, 'outside-home fixture');
  await link(original, join(home.directory, 'auth.json'));
  await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey), /독립된 일반 파일/);
  assert.equal(await readFile(original, 'utf8'), 'outside-home fixture');
  await rm(join(home.directory, 'auth.json'));
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await mkdir(join(home.directory, 'nested'));
  await symlink(outside, join(home.directory, 'nested', 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey), /링크/);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(f.credentials), ['codex']);
});

test('a redirected login lock is preserved and rejected before lock acquisition', async t => {
  const f = await fixture(t), outside = join(f.root, 'unrelated-lock-target');
  await mkdir(outside); await mkdir(f.credentials);
  await symlink(outside, join(f.credentials, 'codex.login.lock'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openDesktopAccountHome(f.credentials, f.workspaceKey), /잠금 경로/);
  assert.ok((await lstat(join(f.credentials, 'codex.login.lock'))).isSymbolicLink());
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(join(f.credentials, 'codex')), []);
});

test('actual login lock loss aborts once at the normal update interval and preserves a replacement holder', { timeout: 20_000 }, async t => {
  const f = await fixture(t), home = await openDesktopAccountHome(f.credentials, f.workspaceKey);
  const clean = await openDesktopAccountHome(join(f.root, 'normal-release'), randomUUID());
  await clean.release();
  const lockPath = join(f.credentials, 'codex.login.lock');
  const identity = await readFile(join(home.directory, 'desktop-codex-home.json'), 'utf8');
  let aborts = 0;
  home.signal.addEventListener('abort', () => { aborts++; });
  const observed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Normal 10 second lock update did not report loss')), 15_000);
    home.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  // Remove exactly this test's owned, empty lock directory. No lease TTL or
  // dependency timers are replaced, and no actual Codex process is started.
  assert.ok((await lstat(lockPath)).isDirectory());
  await rmdir(lockPath);
  await observed;
  const first = home.signal.reason;
  assert.ok(first instanceof Error);
  assert.equal((first as Error & { code: string }).code, 'DESKTOP_ACCOUNT_LEASE_LOST');
  assert.equal((first.cause as NodeJS.ErrnoException).code, 'ECOMPROMISED');
  assert.equal(aborts, 1);
  assert.equal(clean.signal.aborted, false);
  const replacement = await openDesktopAccountHome(f.credentials, f.workspaceKey);
  try {
    const firstRelease = home.release();
    assert.equal(home.release(), firstRelease);
    await assert.rejects(firstRelease, error => error === first);
    await assert.rejects(home.release(), error => error === first);
    assert.equal(home.signal.reason, first);
    assert.equal(aborts, 1);
    assert.equal(replacement.signal.aborted, false);
    assert.ok((await lstat(lockPath)).isDirectory());
    assert.equal(await readFile(join(home.directory, 'desktop-codex-home.json'), 'utf8'), identity);
  } finally { await replacement.release(); }
  assert.equal(replacement.signal.aborted, false);
  await clean.release();
  assert.equal(clean.signal.aborted, false);
});
