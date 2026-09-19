import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = new URL('../worker/entry.mjs', import.meta.url);
const { prepareWorkerAuthentication } = await import(entry.href);
const binding = { authBinding: 'codex-file-v1' };
const secret = 'fixture-private-value';
const document = ` { "tokens": { "refresh_token": "${secret}" } }\n`;
const version = async () => 'codex-cli 0.154.0\n';
const invalid = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code: string }).code, 'WORKER_AUTH_BINDING_INVALID');
  assert.equal(error.message, '연결된 Codex 인증 파일 또는 실행 버전을 확인해야 합니다.');
  assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes(secret));
  return true;
};
async function fixture(t: TestContext, contents: string | Buffer | null = document) {
  const root = await mkdtemp(join(tmpdir(), 'agent-company-mounted-auth-'));
  t.after(async () => {
    const target = resolve(root);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}agent-company-mounted-auth-`));
    await rm(target, { recursive: true, force: true });
  });
  const home = join(root, 'home'); await mkdir(home);
  const auth = join(home, 'auth.json');
  if (contents !== null) await writeFile(auth, contents);
  return { root, home, auth };
}
const prepare = (home: string, payload: object = binding, readVersion = version, secretDirectory?: string) =>
  prepareWorkerAuthentication(payload, home, { readVersion, secretDirectory });

test('importing the worker entry does not read input, emit events or execute main', async () => {
  const result = await new Promise<{ stdout: string; stderr: string }>((yes, no) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(entry.href)}); process.stdout.write('imported\\n');`],
    { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => error ? no(error) : yes({ stdout, stderr }));
    child.stdin!.end();
  });
  assert.equal(result.stdout, 'imported\n'); assert.equal(result.stderr, '');
});

test('direct worker entry still reads stdin and reports invalid input through JSONL with exit 1', async () => {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((yes, no) => {
    const child = execFile(process.execPath, [fileURLToPath(entry)], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return no(error);
      yes({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
    child.stdin!.end(JSON.stringify({ phase: 'invalid' }));
  });
  assert.equal(result.code, 1); assert.equal(result.stderr, '');
  const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ['telemetry', 'error']);
  assert.equal(events[1].message, '실행 입력이 올바르지 않습니다.');
});

test('mounted authentication validates the exact version and preserves original bytes and identity', async t => {
  const { home, auth } = await fixture(t), before = await lstat(auth, { bigint: true });
  let calls = 0;
  assert.equal(await prepare(home, binding, async () => { calls++; return version(); }), undefined);
  assert.equal(calls, 1);
  assert.equal(await readFile(auth, 'utf8'), document);
  const after = await lstat(auth, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key]);
});

test('binding rejects mixed credentials and unknown modes before any version process or file write', async t => {
  const { home, auth } = await fixture(t);
  const readVersion = async () => { assert.fail('mixed input must not start a process'); };
  for (const payload of [{ ...binding, auth: { mode: 'codex', content: secret } }, { ...binding, auth: null },
    { ...binding, auth: undefined }, { authBinding: 'codex-file-v2' }, { authBinding: null }, { authBinding: undefined }]) {
    await assert.rejects(prepare(home, payload, readVersion), invalid);
  }
  for (const secretDirectory of ['', join(home, secret)]) await assert.rejects(prepare(home, binding, readVersion, secretDirectory), invalid);
  assert.equal(await readFile(auth, 'utf8'), document);
});

test('missing files and directories are rejected without creating authentication', async t => {
  const { root, home, auth } = await fixture(t, null);
  const readVersion = async () => { assert.fail('invalid file must not start a process'); };
  await assert.rejects(prepare(home, binding, readVersion), invalid);
  await assert.rejects(lstat(auth), { code: 'ENOENT' });
  await mkdir(auth);
  await assert.rejects(prepare(home, binding, readVersion), invalid);
  await assert.rejects(prepare(join(root, 'absent'), binding, readVersion), invalid);
  await assert.rejects(lstat(join(root, 'absent')), { code: 'ENOENT' });
});

test('bounded UTF-8 validation rejects malformed JSON, nonobjects and oversized data without exposing content', async t => {
  const { home, auth } = await fixture(t);
  const readVersion = async () => { assert.fail('invalid JSON must not start a process'); };
  for (const contents of ['', `{"secret":"${secret}",`, '[]', 'null', 'true', '42', `"${secret}"`,
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), Buffer.alloc(1024 * 1024 + 1, 0x20)]) {
    await writeFile(auth, contents);
    await assert.rejects(prepare(home, binding, readVersion), invalid);
    assert.deepEqual(await readFile(auth), Buffer.from(contents));
  }
});

test('hard-linked authentication is rejected while the linked source is preserved', async t => {
  const { root, home, auth } = await fixture(t);
  const alias = join(root, 'alias.json'); await link(auth, alias);
  await assert.rejects(prepare(home), invalid);
  assert.equal(await readFile(alias, 'utf8'), document);
});

test('symbolic authentication files are rejected without reading or modifying their target', async t => {
  const { root, home, auth } = await fixture(t, null), target = join(root, 'private.json');
  await writeFile(target, document);
  try { await symlink(target, auth, 'file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows file symlink privilege is unavailable'); return; } throw error; }
  await assert.rejects(prepare(home), invalid);
  assert.equal(await readFile(target, 'utf8'), document);
});

test('redirected parent directories are rejected', async t => {
  const { root, home, auth } = await fixture(t), redirect = join(root, 'redirect');
  await symlink(home, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare(redirect), invalid);
  assert.equal(await readFile(auth, 'utf8'), document);
});

test('content mutation or file replacement during version verification is rejected', async t => {
  const { root, home, auth } = await fixture(t);
  await assert.rejects(prepare(home, binding, async () => {
    await writeFile(auth, document.replace(secret, 'fixture-changed-value'));
    return version();
  }), invalid);
  await writeFile(auth, document);
  await assert.rejects(prepare(home, binding, async () => {
    await rename(auth, join(root, 'original.json'));
    await writeFile(auth, document);
    return version();
  }), invalid);
  assert.equal(await readFile(join(root, 'original.json'), 'utf8'), document);
  assert.equal(await readFile(auth, 'utf8'), document);
});

test('other versions and private process failures are rejected without modifying authentication', async t => {
  const { home, auth } = await fixture(t);
  for (const output of ['codex-cli 0.153.4', 'codex-cli 0.154.0-beta', 'codex 0.154.0', `codex-cli 0.154.0\n${secret}`]) {
    await assert.rejects(prepare(home, binding, async () => output), invalid);
  }
  await assert.rejects(prepare(home, binding, async () => { throw new Error(`${home}: ${secret}`); }), invalid);
  assert.equal(await readFile(auth, 'utf8'), document);
});

test('default payload and secret-directory copies retain their original behavior without version checks', async t => {
  const { root, home, auth } = await fixture(t), secretDirectory = join(root, 'secret'); await mkdir(secretDirectory);
  const readVersion = async () => { assert.fail('legacy authentication must not probe the new required version'); };
  const payload: { auth?: { mode: string; content: string } } = { auth: { mode: 'codex', content: document } };
  await prepare(home, payload, readVersion);
  assert.deepEqual(JSON.parse(await readFile(auth, 'utf8')), JSON.parse(document));
  assert.equal(Object.hasOwn(payload, 'auth'), false);
  await prepare(home, { auth: { mode: 'api-key', content: secret } }, readVersion);
  assert.deepEqual(JSON.parse(await readFile(auth, 'utf8')), { OPENAI_API_KEY: secret });
  await writeFile(join(secretDirectory, 'auth.json'), document);
  await prepare(home, {}, readVersion, secretDirectory);
  assert.deepEqual(JSON.parse(await readFile(auth, 'utf8')), JSON.parse(document));
  await rm(join(secretDirectory, 'auth.json'));
  await writeFile(join(secretDirectory, 'api-key'), ` ${secret}\n`);
  await prepare(home, {}, readVersion, secretDirectory);
  assert.deepEqual(JSON.parse(await readFile(auth, 'utf8')), { OPENAI_API_KEY: secret });
});
