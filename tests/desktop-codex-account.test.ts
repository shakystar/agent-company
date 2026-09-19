import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDesktopAccountHome } from '../server/desktop-account-home.ts';
import { openDesktopCodexAccount, type DesktopCodexAccountClient, type DesktopCodexAccountEvent } from '../server/desktop-codex-account.ts';

// A real pipe/process fixture, without account networking, credentials or a model.
const fixtureScript = String.raw`
import readline from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
let initialized = false, eof = false, exitReleased = false;
if (mode === 'timeout') process.on('message', message => {
  if (message === 'release-exit') { exitReleased = true; if (eof) process.exit(0); }
});
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const item = JSON.parse(line);
  appendFileSync(join(process.env.CODEX_HOME, 'fixture-requests.jsonl'), line + '\n');
  if (item.method === 'initialize') {
    if (mode === 'initialize-error') return send({ id: item.id, error: { message: 'private-upstream-fixture' } });
    return reply(item.id, { codexHome: mode === 'wrong-home' ? 'C:/unrelated' : process.env.CODEX_HOME,
      platformFamily: 'fixture', platformOs: process.platform, userAgent: 'fixture/0.154.0' });
  }
  if (item.method === 'initialized') { initialized = true; return; }
  if (!initialized) return process.exit(27);
  if (mode === 'timeout') { process.send({ type: 'request-seen' }); return; }
  if (mode === 'malformed') return process.stdout.write('{not-json}\n');
  if (mode === 'invalid-utf8') return process.stdout.write(Buffer.from([0xff, 10]));
  if (mode === 'oversized') return process.stdout.write('x'.repeat(128 * 1024 + 1));
  if (mode === 'partial-eof') { process.stdout.write('{'); return process.exit(0); }
  if (mode === 'unsolicited-id') return reply(item.id + 123, {});
  if (mode === 'exit-failure') return process.exit(23);
  if (mode === 'request-error') {
    process.stderr.write('private-upstream-fixture\n');
    return send({ id: item.id, error: { message: 'private-upstream-fixture', data: { apiKey: 'fixture-secret' } } });
  }
  if (item.method === 'account/read') {
    if (mode === 'schema-error') return reply(item.id, { account: { type: 'apiKey' } });
    const result = { account: null, requiresOpenaiAuth: true, privateUnrelated: 'fixture-secret' };
    if (mode === 'delayed') return setTimeout(() => reply(item.id, result), 100);
    const output = Buffer.from(JSON.stringify({ id: item.id, result }) + '\n');
    process.stdout.write(output.subarray(0, 9));
    return setTimeout(() => process.stdout.write(output.subarray(9)), 5);
  }
  if (item.method === 'account/login/start') {
    const type = item.params.type;
    if (type === 'apiKey') {
      send({ method: 'account/login/completed', params: { success: true, loginId: null, error: 'private-upstream-fixture' } });
      send({ method: 'account/updated', params: { privateUnknown: 'fixture-secret' } });
      return reply(item.id, { type, privateUnknown: 'fixture-secret' });
    }
    const url = mode === 'unsafe-url' ? 'https://auth.openai.com.evil.example/login' : 'https://auth.openai.com/oauth/authorize?state=fixture';
    return reply(item.id, type === 'chatgpt' ? { type, loginId: 'fixture-login-1', authUrl: url }
      : { type, loginId: 'fixture-login-2', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' });
  }
  if (item.method === 'account/login/cancel') return reply(item.id, { status: 'canceled' });
  if (item.method === 'account/logout') return reply(item.id, {});
  process.exit(28);
});
input.on('close', () => {
  writeFileSync(join(process.env.CODEX_HOME, 'fixture-eof'), 'observed');
  if (mode === 'timeout') {
    eof = true; process.send({ type: 'eof-seen' });
    if (exitReleased) process.exit(0);
    return;
  }
  setTimeout(() => process.exit(mode === 'bad-shutdown' ? 29 : 0), 10);
});
`;

async function fixture(t: test.TestContext, mode = 'normal', requestTimeoutMs = 2000) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-codex-'));
  const script = join(root, 'fixture.mjs'), credentialsRoot = join(root, '개인 인증'), workspaceKey = randomUUID();
  await writeFile(script, fixtureScript);
  let config: SpawnOptionsWithoutStdio | undefined, args: string[] | undefined, spawned = 0;
  const events: DesktopCodexAccountEvent[] = [];
  let client: DesktopCodexAccountClient | undefined;
  let fixtureChild: ChildProcessWithoutNullStreams | undefined;
  let fixtureClosed = Promise.resolve();
  let requestSeen!: () => void, eofSeen!: () => void;
  const requestObserved = new Promise<void>(resolve => { requestSeen = resolve; });
  const eofObserved = new Promise<void>(resolve => { eofSeen = resolve; });
  const releaseExit = () => { if (fixtureChild?.connected) fixtureChild.send('release-exit'); };
  t.after(async () => {
    releaseExit();
    if (mode === 'timeout' && fixtureChild && !fixtureChild.stdin.writableEnded) fixtureChild.stdin.end();
    await client?.close().catch(() => {});
    await fixtureClosed;
    // Only this mkdtemp root is removed, after actual child/pipe closure.
    await rm(root, { recursive: true, force: true });
  });
  const open = async (assertNoCredentialWriters?: () => Promise<void>) => client = await openDesktopCodexAccount({ executable: process.execPath,
    credentialsRoot, workspaceKey, requestTimeoutMs, onEvent: event => events.push(event),
    assertNoCredentialWriters,
    spawn: (_exe, passedArgs, passedConfig) => {
      spawned++; config = passedConfig; args = passedArgs;
      // Only the timeout fixture has a private test IPC exit gate. The account
      // protocol continues to use the same real stdin/stdout/stderr pipes.
      fixtureChild = spawn(process.execPath, [script, mode], { ...passedConfig,
        stdio: mode === 'timeout' ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe' }) as ChildProcessWithoutNullStreams;
      fixtureClosed = new Promise<void>(resolve => { fixtureChild!.once('close', resolve); });
      fixtureChild.on('message', message => {
        if ((message as { type?: string }).type === 'request-seen') requestSeen();
        if ((message as { type?: string }).type === 'eof-seen') eofSeen();
      });
      return fixtureChild;
    },
  });
  return { root, credentialsRoot, workspaceKey, home: join(credentialsRoot, 'codex'), open, events,
    requestObserved, eofObserved, releaseExit,
    get config() { return config; }, get args() { return args; }, get spawned() { return spawned; } };
}

test('configured account admission checks actual credential writers under the shared lease before spawning', async t => {
  const f = await fixture(t);
  let entered!: () => void, proceed!: () => void;
  const checked = new Promise<void>(yes => { entered = yes; }), gate = new Promise<void>(yes => { proceed = yes; });
  const starting = f.open(async () => {
    await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
    entered(); await gate;
    throw new Error('PRIVATE_DOCKER_CREDENTIAL_WRITER_DIAGNOSTIC');
  });
  const rejected = assert.rejects(starting, error => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, 'CODEX_ACCOUNT_WRITER_ACTIVE');
    assert.equal(error.message, 'CODEX_ACCOUNT_WRITER_ACTIVE'); assert.equal('cause' in error, false);
    return true;
  });
  await checked; assert.equal(f.spawned, 0); proceed(); await rejected;
  const home = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await home.release();
  const client = await f.open(async () => {
    await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
  });
  assert.equal(f.spawned, 1); await client.readAccount(); await client.close();
});

test('account client initializes a private home, uses explicit env and completes official account methods over pipes', async t => {
  const f = await fixture(t), client = await f.open();
  assert.equal(f.config?.cwd, f.home);
  assert.equal(f.config?.windowsHide, true); assert.equal(f.config?.shell, false);
  assert.equal(f.config?.env?.CODEX_HOME, f.home);
  assert.deepEqual(Object.keys(f.config!.env!).filter(key => !['CODEX_HOME', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].includes(key)), []);
  assert.deepEqual(f.args, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"']);
  assert.deepEqual(await client.readAccount(), { account: null, requiresOpenaiAuth: true });
  assert.deepEqual(await client.startLogin({ type: 'chatgpt' }), {
    type: 'chatgpt', loginId: 'fixture-login-1', authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture',
  });
  assert.deepEqual(await client.cancelLogin('fixture-login-1'), { status: 'canceled' });
  assert.deepEqual(await client.startLogin({ type: 'chatgptDeviceCode' }), {
    type: 'chatgptDeviceCode', loginId: 'fixture-login-2', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device',
  });
  assert.deepEqual(await client.startLogin({ type: 'apiKey', apiKey: 'fixture-api-key' }), { type: 'apiKey' });
  assert.deepEqual(f.events, [{ type: 'loginCompleted', loginId: null, success: true }, { type: 'accountChanged' }]);
  await client.logout();
  const transcript = (await readFile(join(f.home, 'fixture-requests.jsonl'), 'utf8')).trim().split('\n').map(value => JSON.parse(value));
  assert.equal(transcript[0].method, 'initialize'); assert.equal(transcript[1].method, 'initialized');
  assert.equal(transcript[0].params.capabilities.experimentalApi, false);
  assert.equal(transcript.find(value => value.method === 'account/read').params.refreshToken, false);
  assert.ok(!JSON.stringify({ args: f.args, env: f.config!.env, events: f.events }).includes('fixture-api-key'));
  await Promise.all([client.close(), client.close(), client.closed]);
  assert.equal(await readFile(join(f.home, 'fixture-eof'), 'utf8'), 'observed');
  assert.deepEqual(await readdir(f.credentialsRoot), ['codex']);
  await assert.rejects(client.readAccount(), { code: 'CODEX_ACCOUNT_CLOSED' });
  const reopened = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await reopened.release();
});

test('invalid inputs and internal external-token login never enter the account protocol', async t => {
  const f = await fixture(t), client = await f.open();
  for (const input of [{ type: 'chatgptAuthTokens', accessToken: 'fixture-secret' }, { type: 'apiKey', apiKey: 'bad\nkey' },
    { type: 'chatgpt', extra: 'forbidden' }]) {
    await assert.rejects(client.startLogin(input as never), { code: 'CODEX_ACCOUNT_INVALID_INPUT' });
  }
  await assert.rejects(client.cancelLogin('bad\nlogin'), { code: 'CODEX_ACCOUNT_INVALID_INPUT' });
  await assert.rejects(client.readAccount('true' as never), { code: 'CODEX_ACCOUNT_INVALID_INPUT' });
  assert.deepEqual(await client.readAccount(true), { account: null, requiresOpenaiAuth: true });
  const transcript = await readFile(join(f.home, 'fixture-requests.jsonl'), 'utf8');
  assert.ok(!transcript.includes('fixture-secret') && !transcript.includes('account/login'));
  await client.close();
});

test('concurrent requests fail busy without replacing or canceling the in-flight account response', async t => {
  const f = await fixture(t, 'delayed'), client = await f.open(), first = client.readAccount();
  await assert.rejects(client.logout(), { code: 'CODEX_ACCOUNT_BUSY' });
  assert.deepEqual(await first, { account: null, requiresOpenaiAuth: true });
  await client.close();
});

test('upstream errors and stderr are redacted while a recoverable RPC error retains the session', async t => {
  const f = await fixture(t, 'request-error'), client = await f.open();
  await assert.rejects(client.readAccount(), error => {
    assert.equal((error as { code: string }).code, 'CODEX_ACCOUNT_REQUEST_FAILED');
    assert.ok(!String(error).includes('private-upstream-fixture') && !JSON.stringify(error).includes('fixture-secret'));
    return true;
  });
  assert.deepEqual(f.events, []);
  await client.close();
});

test('request timeout closes admission but retains the lease until actual process exit', { timeout: 30_000 }, async t => {
  // The 150ms request policy must not double as a wall-clock Node startup budget.
  // Advance it only after the real child has initialized and received account/read.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, 'timeout', 150), client = await f.open();
  let closed = false;
  void client.closed.then(() => { closed = true; }, () => { closed = true; });
  const timedOut = assert.rejects(client.readAccount(), { code: 'CODEX_ACCOUNT_TIMEOUT' });
  await f.requestObserved;
  t.mock.timers.tick(149); assert.deepEqual(f.events, []); assert.equal(closed, false);
  t.mock.timers.tick(1); await timedOut;
  await f.eofObserved;
  await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
  await assert.rejects(client.logout(), { code: 'CODEX_ACCOUNT_TIMEOUT' });
  assert.equal(closed, false, 'Observed EOF must not release a lease while the real child is still alive');
  f.releaseExit();
  await assert.rejects(client.closed, { code: 'CODEX_ACCOUNT_TIMEOUT' });
  assert.deepEqual(f.events, [{ type: 'failed', code: 'CODEX_ACCOUNT_TIMEOUT' }]);
  const reopened = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await reopened.release();
});

for (const mode of ['malformed', 'invalid-utf8', 'oversized', 'partial-eof', 'unsolicited-id', 'schema-error', 'unsafe-url']) {
  test(`account protocol rejects ${mode} and releases only after child closure`, async t => {
    const f = await fixture(t, mode), client = await f.open();
    const result = mode === 'unsafe-url' ? client.startLogin({ type: 'chatgpt' }) : client.readAccount();
    await assert.rejects(result, { code: 'CODEX_ACCOUNT_PROTOCOL_FAILED' });
    await assert.rejects(client.closed, { code: 'CODEX_ACCOUNT_PROTOCOL_FAILED' });
    assert.deepEqual(await readdir(f.credentialsRoot), ['codex']);
    assert.equal(f.events.length, 1);
  });
}

test('failed initialization drains and closes the owned process before rejecting', async t => {
  for (const mode of ['initialize-error', 'wrong-home']) {
    const f = await fixture(t, mode);
    await assert.rejects(f.open(), { code: mode === 'initialize-error' ? 'CODEX_ACCOUNT_REQUEST_FAILED' : 'CODEX_ACCOUNT_PROTOCOL_FAILED' });
    assert.equal(await readFile(join(f.home, 'fixture-eof'), 'utf8'), 'observed');
    const reopened = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await reopened.release();
  }
});

test('nonzero child exit after requested shutdown is not reported as a successful close', async t => {
  const f = await fixture(t, 'bad-shutdown'), client = await f.open();
  await assert.rejects(client.close(), { code: 'CODEX_ACCOUNT_EXIT_FAILED' });
  await assert.rejects(client.close(), { code: 'CODEX_ACCOUNT_EXIT_FAILED' });
});

test('missing executable and spawn failure do not leave a login holder', async t => {
  const f = await fixture(t);
  await assert.rejects(openDesktopCodexAccount({ executable: join(f.root, 'absent.exe'),
    credentialsRoot: f.credentialsRoot, workspaceKey: f.workspaceKey }), { code: 'CODEX_ACCOUNT_INVALID_INPUT' });
  await assert.rejects(openDesktopCodexAccount({ executable: process.execPath,
    credentialsRoot: f.credentialsRoot, workspaceKey: f.workspaceKey, spawn: () => { throw new Error('private-spawn-fixture'); } }),
  { code: 'CODEX_ACCOUNT_START_FAILED' });
  const reopened = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await reopened.release();
});

test('asynchronous spawn failure releases its home without exposing the failed process path', async t => {
  const f = await fixture(t);
  await assert.rejects(openDesktopCodexAccount({ executable: process.execPath,
    credentialsRoot: f.credentialsRoot, workspaceKey: f.workspaceKey,
    spawn: (_file, _args, options) => spawn(join(f.root, 'private-absent.exe'), [], { ...options, stdio: 'pipe' }),
  }), error => {
    assert.equal((error as { code: string }).code, 'CODEX_ACCOUNT_START_FAILED');
    assert.ok(!String(error).includes(f.root) && !JSON.stringify(error).includes(f.root));
    return true;
  });
  const reopened = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await reopened.release();
});

test('home acquisition failures are redacted and a concurrent client never spawns', async t => {
  const f = await fixture(t), client = await f.open();
  let spawned = false;
  await assert.rejects(openDesktopCodexAccount({ executable: process.execPath,
    credentialsRoot: f.credentialsRoot, workspaceKey: f.workspaceKey,
    spawn: () => { spawned = true; throw new Error('must not spawn'); },
  }), error => {
    assert.equal((error as { code: string }).code, 'CODEX_ACCOUNT_BUSY');
    assert.ok(!JSON.stringify(error).includes(f.home) && !('file' in (error as object)));
    return true;
  });
  assert.equal(spawned, false);
  await client.close();
  await assert.rejects(openDesktopCodexAccount({ executable: process.execPath,
    credentialsRoot: f.credentialsRoot, workspaceKey: randomUUID() }), { code: 'CODEX_ACCOUNT_START_FAILED' });
});

test('closing during a request rejects it and waits for the owned child before releasing the lease', async t => {
  const f = await fixture(t, 'delayed'), client = await f.open();
  const request = client.readAccount();
  const rejected = assert.rejects(request, { code: 'CODEX_ACCOUNT_CLOSED' });
  const stopped = client.close();
  await rejected;
  await stopped;
  const reopened = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await reopened.release();
});

test('real lease loss closes an idle account child and preserves the first failure', async t => {
  const f = await fixture(t), client = await f.open();
  // This exact temporary lease is intentionally removed to exercise proper-lockfile's normal update check.
  await rm(join(f.credentialsRoot, 'codex.login.lock'), { recursive: true });
  await assert.rejects(client.closed, { code: 'CODEX_ACCOUNT_LEASE_LOST' });
  assert.deepEqual(f.events, [{ type: 'failed', code: 'CODEX_ACCOUNT_LEASE_LOST' }]);
  await assert.rejects(client.readAccount(), { code: 'CODEX_ACCOUNT_LEASE_LOST' });
  assert.equal(await readFile(join(f.home, 'fixture-eof'), 'utf8'), 'observed');
  await delay(1);
});
