import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { DesktopSetup } from '../server/desktop-setup.ts';
import type { DesktopCodexAccount, DesktopCodexAccountClient, DesktopCodexAccountEvent, DesktopCodexLoginResult } from '../server/desktop-codex-account.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const chatgpt = { type: 'chatgpt' as const, email: 'fixture@example.invalid', planType: 'plus' };
const loginResult = { type: 'chatgptDeviceCode' as const, loginId: 'provider-login-1',
  verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FIXT-1234' };

function fixture(executionReady?: () => Promise<boolean>) {
  const log: string[] = [];
  let emit: ((event: DesktopCodexAccountEvent) => void) | undefined;
  let account: DesktopCodexAccount['account'] = null, admission = 0, opens = 0;
  const clients: { closeGate?: Promise<void>; finish: () => void; client: DesktopCodexAccountClient }[] = [];
  let login: () => Promise<DesktopCodexLoginResult> = async () => loginResult;
  let cancel = async () => ({ status: 'canceled' as 'canceled' | 'notFound' });
  let logout = async () => { account = null; };
  let denied = false;
  const setup = new DesktopSetup({ provider: { executable: 'fixture-explicit.exe', version: '0.154.0' },
    executionReady,
    credentialsRoot: 'fixture-private', workspaceKey: randomUUID(),
    admit: () => { admission++; let released = false; return () => { assert.ok(!released); released = true; admission--; }; },
    assertIdle: () => { if (denied) throw new Error('runtime admission is open'); },
    openAccount: async options => {
      opens++; emit = options.onEvent;
      const ended = deferred<void>();
      const current = { closeGate: undefined as Promise<void> | undefined, finish: () => ended.resolve(), client: {} as DesktopCodexAccountClient };
      current.client = {
        closed: ended.promise,
        readAccount: async () => { log.push('read'); return { account, requiresOpenaiAuth: true }; },
        startLogin: async input => { log.push(`login:${input.type}`); return login(); },
        cancelLogin: async id => { log.push(`cancel:${id}`); return cancel(); },
        logout: async () => { log.push('logout'); await logout(); },
        close: async () => { log.push('close:start'); await current.closeGate; current.finish(); log.push('close:done'); },
      };
      clients.push(current); return current.client;
    },
  });
  const notify = (success: boolean, loginId: string | null = loginResult.loginId) => emit?.({ type: 'loginCompleted', loginId, success });
  return { setup, log, notify, clients,
    get admission() { return admission; }, get opens() { return opens; },
    set account(value: DesktopCodexAccount['account']) { account = value; },
    set login(value: typeof login) { login = value; }, set cancel(value: typeof cancel) { cancel = value; },
    set logout(value: typeof logout) { logout = value; }, set denied(value: boolean) { denied = value; },
  };
}
async function settled(setup: DesktopSetup, phase: string) {
  for (let i = 0; i < 100 && setup.status().phase !== phase; i++) await tick();
  assert.equal(setup.status().phase, phase);
}

test('initial account inspection closes its child and preserves a cached account without starting another login', async () => {
  const f = fixture(); f.account = chatgpt;
  const result = await f.setup.login({ revision: 0, method: 'apiKey', apiKey: 'fixture-new-key-must-not-replace' });
  assert.equal(result.phase, 'connected'); assert.deepEqual(result.account, chatgpt);
  assert.deepEqual(f.log, ['read', 'close:start', 'close:done']); assert.equal(f.admission, 0);
  assert.equal(result.executionReady, false);
  const exposed = f.setup.status(); exposed.account = null;
  assert.deepEqual(f.setup.status().account, chatgpt);
  await f.setup.close();
});

test('pending device login holds deployment admission until matching completion, account read and actual close', async () => {
  const f = fixture(), pending = await f.setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  assert.equal(pending.phase, 'awaiting'); assert.ok(pending.login?.attemptId);
  assert.equal(f.admission, 1); assert.equal(f.log.includes('close:start'), false);
  f.notify(true, 'unrelated-old-login'); await tick(); assert.equal(f.setup.status().phase, 'awaiting');
  const closeGate = deferred<void>(); f.clients[0].closeGate = closeGate.promise;
  f.account = chatgpt; f.notify(true);
  await settled(f.setup, 'checking'); await tick();
  assert.equal(f.setup.status().account, null); assert.equal(f.admission, 1);
  closeGate.resolve(); await settled(f.setup, 'connected'); await tick();
  assert.deepEqual(f.setup.status().account, chatgpt); assert.equal(f.setup.status().login, null); assert.equal(f.admission, 0);
  assert.deepEqual(f.log, ['read', 'login:chatgptDeviceCode', 'read', 'close:start', 'close:done']);
  await f.setup.close();
});

test('completion received before login/start response is correlated after the provider ID is known', async () => {
  const f = fixture();
  f.login = async () => { f.account = chatgpt; f.notify(true); return loginResult; };
  await f.setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  await settled(f.setup, 'connected'); await tick();
  assert.equal(f.admission, 0); assert.deepEqual(f.setup.status().account, chatgpt);
  await f.setup.close();
});

test('completion success without a readable account is not reported as connected', async () => {
  const f = fixture(); await f.setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  f.notify(true); await settled(f.setup, 'failed'); await tick();
  assert.equal(f.setup.status().error?.code, 'SETUP_LOGIN_UNCONFIRMED'); assert.equal(f.setup.status().account, null);
  assert.equal(f.admission, 0); await f.setup.close();
});

test('cancellation wins a completion race and removes auth committed by that initially disconnected attempt', async () => {
  const f = fixture(), started = await f.setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  f.cancel = async () => { f.account = chatgpt; f.notify(true); return { status: 'notFound' }; };
  const canceled = await f.setup.cancel(started.revision, started.login!.attemptId);
  assert.equal(canceled.phase, 'disconnected'); assert.equal(canceled.account, null); assert.equal(canceled.login, null);
  assert.equal(f.admission, 0);
  assert.deepEqual(f.log, ['read', 'login:chatgptDeviceCode', 'cancel:provider-login-1', 'logout', 'read', 'close:start', 'close:done']);
  f.notify(true); await tick(); assert.equal(f.setup.status().phase, 'disconnected');
  await f.setup.close();
});

test('stale revision, wrong attempt and duplicate mutations cannot replace a pending login', async () => {
  const f = fixture(), pending = await f.setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  assert.throws(() => f.setup.check(0), { code: 'SETUP_STALE' });
  assert.throws(() => f.setup.cancel(pending.revision, randomUUID()), { code: 'SETUP_STALE_LOGIN' });
  assert.throws(() => f.setup.login({ revision: pending.revision, method: 'apiKey', apiKey: 'fixture-secret' }), { code: 'SETUP_BUSY' });
  assert.equal(f.opens, 1); assert.equal(f.admission, 1);
  await f.setup.cancel(pending.revision, pending.login!.attemptId); await f.setup.close();
});

test('API key request confirms storage without forwarding its value to status or enabling execution', async () => {
  const f = fixture(); f.login = async () => { f.account = { type: 'apiKey' }; return { type: 'apiKey' }; };
  const state = await f.setup.login({ revision: 0, method: 'apiKey', apiKey: 'fixture-private-key' });
  assert.equal(state.phase, 'connected'); assert.deepEqual(state.account, { type: 'apiKey' });
  assert.equal(state.executionReady, false); assert.ok(!JSON.stringify(state).includes('fixture-private-key'));
  const disconnected = await f.setup.logout(state.revision);
  assert.equal(disconnected.phase, 'disconnected'); assert.equal(f.admission, 0); await f.setup.close();
});

test('logout success without disappearance of the account remains unconfirmed', async () => {
  const f = fixture(); f.account = chatgpt;
  const connected = await f.setup.check(0); f.logout = async () => {};
  const result = await f.setup.logout(connected.revision);
  assert.equal(result.phase, 'failed'); assert.equal(result.error?.code, 'SETUP_LOGOUT_UNCONFIRMED');
  assert.equal(f.admission, 0); await f.setup.close();
});

test('unexpected child closure while waiting clears the one-time code and releases deployment admission', async () => {
  const f = fixture(); await f.setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  f.clients[0].finish(); await settled(f.setup, 'failed'); await tick();
  assert.equal(f.setup.status().login, null); assert.equal(f.setup.status().error?.code, 'SETUP_CONNECTION_LOST');
  assert.equal(f.admission, 0); await f.setup.close();
});

test('closing during login creation retains admission and awaits the owned child instead of returning a challenge', async () => {
  const f = fixture(), loginGate = deferred<DesktopCodexLoginResult>(), closeGate = deferred<void>();
  f.login = () => loginGate.promise;
  const started = f.setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  await tick(); f.clients[0].closeGate = closeGate.promise;
  let closed = false; const stopping = f.setup.close().then(() => { closed = true; });
  loginGate.resolve(loginResult); await started; await tick();
  assert.equal(f.setup.status().phase, 'closing'); assert.equal(f.setup.status().login, null);
  assert.equal(f.admission, 1); assert.equal(closed, false);
  closeGate.resolve(); await stopping; assert.equal(f.admission, 0);
  assert.throws(() => f.setup.check(f.setup.status().revision), { code: 'SETUP_CLOSING' });
});

test('runtime gate and unavailable provider prevent admission or process creation', async () => {
  const f = fixture(); f.denied = true;
  assert.throws(() => f.setup.check(0), /runtime admission/); assert.equal(f.admission, 0); assert.equal(f.opens, 0);
  const missing = new DesktopSetup({ provider: null, credentialsRoot: 'unused', workspaceKey: randomUUID(),
    admit: () => { throw new Error('must not admit'); }, assertIdle: () => { throw new Error('must not inspect'); } });
  assert.equal(missing.status().phase, 'unavailable'); assert.throws(() => missing.check(0), { code: 'SETUP_UNAVAILABLE' });
  await Promise.all([f.setup.close(), missing.close()]);
});

test('arbitrary provider errors are redacted and do not retain a pending login', async () => {
  const f = fixture(); f.login = async () => { throw new Error('fixture-secret-key and path'); };
  const result = await f.setup.login({ revision: 0, method: 'apiKey', apiKey: 'fixture-secret-key' });
  assert.equal(result.phase, 'failed'); assert.ok(!JSON.stringify(result).includes('fixture-secret-key'));
  assert.equal(f.admission, 0); assert.equal(result.login, null); await f.setup.close();
});

test('execution readiness requires a connected account and a current successful runtime query', async () => {
  let ready = false, calls = 0, fail = false;
  const f = fixture(async () => { calls++; if (fail) throw new Error('PRIVATE_RUNTIME_PATH'); return ready; });
  assert.equal((await f.setup.readStatus()).executionReady, false); assert.equal(calls, 0);
  f.account = chatgpt; await f.setup.check(0);
  assert.equal((await f.setup.readStatus()).executionReady, false);
  ready = true; assert.equal((await f.setup.readStatus()).executionReady, true);
  fail = true; const unavailable = await f.setup.readStatus();
  assert.equal(unavailable.executionReady, false); assert.ok(!JSON.stringify(unavailable).includes('PRIVATE'));
  await f.setup.close();
});

test('a readiness response pending during logout cannot restore the previous account or readiness', async () => {
  const pending = deferred<boolean>(), entered = deferred<void>();
  const f = fixture(async () => { entered.resolve(); return pending.promise; });
  f.account = chatgpt; await f.setup.check(0);
  const reading = f.setup.readStatus(); await entered.promise;
  await f.setup.logout(f.setup.status().revision);
  pending.resolve(true); const result = await reading;
  assert.equal(result.phase, 'disconnected'); assert.equal(result.account, null); assert.equal(result.executionReady, false);
  await f.setup.close();
});
