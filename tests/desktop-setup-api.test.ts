import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.ts';
import { createDesktopAccess } from '../server/desktop-access.ts';
import { unconfiguredDesktopRuntime } from '../server/desktop-controller.ts';
import { DesktopSetup } from '../server/desktop-setup.ts';
import { AgentService } from '../server/service.ts';
import { WorkspaceStore } from '../server/store.ts';
import type { DesktopCodexAccount, DesktopCodexAccountClient, DesktopCodexAccountOptions,
  DesktopCodexLogin, DesktopCodexLoginResult } from '../server/desktop-codex-account.ts';
import type { DesktopSetupStatus } from '../shared/desktop-setup.ts';
import type { ExecutionResult } from '../shared/types.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Isolated setup API state timed out'); await delay(10); }
}
const verificationUrl = 'https://auth.openai.com/codex/device?fixture=private-login-url';
const userCode = 'PRIVATE-CODE', apiKey = 'sk-private-api-fixture';
class NoModelRuntime extends StorageFixtureRuntime {
  confirmations = 0;
  override async execute(): Promise<ExecutionResult> { assert.fail('Setup API tests must never execute a model'); }
  async confirmDeploymentIdle() { this.confirmations++; }
}
class Account implements DesktopCodexAccountClient {
  readonly ended = deferred();
  readonly closed = this.ended.promise;
  closeGate?: ReturnType<typeof deferred>;
  private closePromise?: Promise<void>;
  closeRequested = false;
  account: DesktopCodexAccount['account'] = null;
  readonly calls: unknown[][] = [];
  constructor(readonly options: DesktopCodexAccountOptions) {}
  async readAccount(refreshToken = false): Promise<DesktopCodexAccount> {
    this.calls.push(['read', refreshToken]); return { account: this.account, requiresOpenaiAuth: true };
  }
  async startLogin(input: DesktopCodexLogin): Promise<DesktopCodexLoginResult> {
    this.calls.push(['login', input]);
    if (input.type === 'apiKey') { this.account = { type: 'apiKey' }; return { type: 'apiKey' }; }
    return { type: 'chatgptDeviceCode', loginId: 'provider-login-id', verificationUrl, userCode };
  }
  async cancelLogin(id: string): Promise<{ status: 'canceled' }> { this.calls.push(['cancel', id]); return { status: 'canceled' }; }
  async logout() { this.calls.push(['logout']); this.account = null; }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closeRequested = true; this.calls.push(['close']);
      await this.closeGate?.promise; this.ended.resolve();
    })();
  }
}
async function fixture(t: test.TestContext, options: { desktop?: boolean; storage?: boolean; unconfiguredRuntime?: boolean; executionReady?: () => Promise<boolean> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-setup-api-')), owner = randomUUID();
  const dataRoot = join(root, 'workspace'), dataDir = join(dataRoot, 'db'), credentialsRoot = join(root, 'private-credentials');
  const runtime = new NoModelRuntime(owner), clients: Account[] = [];
  const token = randomBytes(32).toString('base64url'), cookieName = `ac_desktop_${randomBytes(16).toString('hex')}`;
  const origin = 'http://127.0.0.1:46701', headers = { host: '127.0.0.1:46701', origin, cookie: `${cookieName}=${token}` };
  let setup: DesktopSetup | undefined;
  const app = await createApp({ dataDir, runtime: options.unconfiguredRuntime ? unconfiguredDesktopRuntime() : runtime,
    ...(options.storage ? { storage: { rootDir: dataRoot, backupDir: join(root, 'backups'), ownerKey: owner, freeSpace: async () => 100 * 1024 ** 3 } } : {}),
    ...(options.desktop === false ? {} : {
      desktopAccess: createDesktopAccess({ token, cookieName, origin: () => origin }),
      desktopSetup: (admit: () => () => void) => setup = new DesktopSetup({ admit, assertIdle() {},
        executionReady: options.executionReady,
        provider: { executable: join(root, 'bundled-codex.exe'), version: '0.154.0' }, credentialsRoot, workspaceKey: owner,
        openAccount: async accountOptions => { const client = new Account(accountOptions); clients.push(client); return client; },
      }),
    }),
  });
  t.after(async () => {
    for (const client of clients) client.closeGate?.resolve();
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /ac-desktop-setup-api-[^\\/]+$/);
    await rm(root, { recursive: true, force: true });
  });
  const get = (url: string) => app.inject({ url, headers });
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload });
  const status = async (): Promise<DesktopSetupStatus> => (await get('/api/desktop/setup')).json();
  return { root, dataDir, credentialsRoot, app, runtime, clients, token, headers, get, post, status, setup: () => setup! };
}
function excludes(value: unknown, secrets: string[]) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    assert.ok(!serialized.includes(secret) && !serialized.includes(JSON.stringify(secret).slice(1, -1)), 'Private setup data escaped into a shared DTO');
  }
}

test('setup status API reports current runtime readiness only for a connected account', async t => {
  let ready = false;
  const f = await fixture(t, { executionReady: async () => ready });
  assert.equal((await f.status()).executionReady, false);
  const connected = await f.post('/api/desktop/setup/login', { revision: (await f.status()).revision, method: 'apiKey', apiKey });
  assert.equal(connected.statusCode, 200); assert.equal((await f.status()).executionReady, false);
  ready = true; assert.equal((await f.status()).executionReady, true);
  await f.post('/api/desktop/setup/logout', { revision: (await f.status()).revision });
  assert.equal((await f.status()).executionReady, false);
});

test('CLI has no setup capability or endpoints; desktop setup is guarded and workspace exposes only its capability', async t => {
  const cli = await fixture(t, { desktop: false });
  assert.equal((await cli.app.inject('/api/workspace')).json().desktop, undefined);
  assert.equal((await cli.app.inject('/api/desktop/setup')).statusCode, 404);
  for (const action of ['check', 'login', 'cancel', 'logout']) {
    assert.equal((await cli.app.inject({ method: 'POST', url: `/api/desktop/setup/${action}`, payload: {} })).statusCode, 404);
  }
  await cli.app.close();
  const f = await fixture(t);
  for (const [method, url] of [['GET', '/api/desktop/setup'], ['GET', '/api/workspace'],
    ...['check', 'login', 'cancel', 'logout'].map(action => ['POST', `/api/desktop/setup/${action}`])] as Array<['GET' | 'POST', string]>) {
    for (const headers of [{ host: f.headers.host }, { ...f.headers, origin: 'http://127.0.0.1:5173' }, { ...f.headers, host: 'localhost:46701' }]) {
      const response = await f.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: {} } : {}) });
      assert.equal(response.statusCode, 403); assert.equal(response.headers['cache-control'], 'no-store');
      excludes(response.json(), [f.token]);
    }
  }
  const workspace = (await f.get('/api/workspace')).json();
  assert.deepEqual(workspace.desktop, { accountSetup: true });
  assert.equal(workspace.desktopSetup, undefined); assert.equal(workspace.account, undefined);
  assert.equal((await f.status()).phase, 'unchecked'); assert.equal(f.clients.length, 0);
});

test('setup API validates inputs and excludes credentials and private login data from workspace, activity and real backup state', async t => {
  const f = await fixture(t, { storage: true });
  for (const revision of ['0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal((await f.post('/api/desktop/setup/check', { revision })).statusCode, 400);
  }
  for (const payload of [{ revision: 0, method: 'apiKey', apiKey: '' }, { revision: 0, method: 'apiKey', apiKey: 'key with space' },
    { revision: 0, method: 'apiKey', apiKey: 'a'.repeat(8193) }, { revision: 0, method: 'chatgptAuthTokens', accessToken: apiKey },
    { revision: 0, method: 'chatgpt' }, { revision: 0, method: 'chatgptDeviceCode', credentialsRoot: f.credentialsRoot },
    { revision: 0, method: 'apiKey', apiKey, internal: true }]) {
    const response = await f.post('/api/desktop/setup/login', payload);
    assert.equal(response.statusCode, 400); excludes(response.json(), [apiKey, f.credentialsRoot]);
  }
  assert.equal((await f.post('/api/desktop/setup/cancel', { revision: 0, attemptId: 'bad-id' })).statusCode, 400);
  assert.equal((await f.post('/api/desktop/setup/check', { revision: 99 })).statusCode, 409);
  assert.equal(f.clients.length, 0);
  const connected = await f.post('/api/desktop/setup/login', { revision: 0, method: 'apiKey', apiKey });
  assert.equal(connected.statusCode, 200); assert.equal(connected.json().phase, 'connected');
  assert.equal(connected.json().executionReady, false); excludes(connected.json(), [apiKey, f.credentialsRoot]);
  assert.deepEqual(f.clients[0].calls.find(call => call[0] === 'login'), ['login', { type: 'apiKey', apiKey }]);
  assert.equal((await f.post('/api/desktop/setup/logout', { revision: connected.json().revision })).json().phase, 'disconnected');
  const pending = await f.post('/api/desktop/setup/login', { revision: (await f.status()).revision, method: 'chatgptDeviceCode' });
  assert.equal(pending.statusCode, 200); assert.equal(pending.json().phase, 'awaiting');
  assert.equal(pending.json().login.verificationUrl, verificationUrl);
  await mkdir(f.credentialsRoot); await writeFile(join(f.credentialsRoot, 'credential-fixture'), apiKey);
  const workspace = (await f.get('/api/workspace')).json();
  const secrets = [apiKey, verificationUrl, userCode, f.credentialsRoot, f.token];
  excludes(workspace, secrets); excludes(workspace.activities, secrets);
  assert.deepEqual(workspace.desktop, { accountSetup: true });
  const response = await f.post('/api/storage/backups', {});
  assert.equal(response.statusCode, 200, response.body);
  const backup = response.json(); assert.equal(backup.backups[0].verified, true); excludes(backup, secrets);
  assert.ok(resolve(backup.backupDir).startsWith(`${resolve(f.root)}${process.platform === 'win32' ? '\\' : '/'}`));
  const state = JSON.parse(await readFile(join(backup.backupDir, backup.backups[0].id, 'state.json'), 'utf8'));
  excludes(state, secrets); assert.equal(state.desktop, undefined); assert.equal(state.desktopSetup, undefined);
  assert.equal(await readFile(join(f.credentialsRoot, 'credential-fixture'), 'utf8'), apiKey);
});

test('pending login blocks deployment ready; held status and cancel work and readiness waits for child close', async t => {
  const f = await fixture(t);
  const login = await f.post('/api/desktop/setup/login', { revision: 0, method: 'chatgptDeviceCode' });
  assert.equal(login.statusCode, 200); const pending = login.json<DesktopSetupStatus>();
  const child = f.clients[0]; child.closeGate = deferred();
  assert.equal((await f.post('/api/deployment/prepare', {})).json().phase, 'draining');
  await delay(350);
  assert.equal((await f.get('/api/deployment')).json().phase, 'draining'); assert.equal(f.runtime.confirmations, 0);
  assert.equal((await f.get('/api/desktop/setup')).statusCode, 200);
  for (const action of ['check', 'login', 'logout']) {
    assert.equal((await f.post(`/api/desktop/setup/${action}`, { revision: pending.revision, method: 'chatgptDeviceCode' })).statusCode, 409);
  }
  assert.equal((await f.post('/api/desktop/setup/cancel', { revision: pending.revision, attemptId: randomUUID() })).statusCode, 409);
  const cancellation = f.post('/api/desktop/setup/cancel', { revision: pending.revision, attemptId: pending.login!.attemptId });
  await until(() => child.closeRequested);
  assert.deepEqual(child.calls.slice(-4), [['cancel', 'provider-login-id'], ['logout'], ['read', false], ['close']]);
  await delay(350);
  assert.equal((await f.get('/api/deployment')).json().phase, 'draining'); assert.equal(f.runtime.confirmations, 0);
  assert.equal((await f.status()).phase, 'canceling');
  child.closeGate.resolve();
  const canceled = await cancellation;
  assert.equal(canceled.statusCode, 200); assert.equal(canceled.json().phase, 'disconnected'); assert.equal(canceled.json().login, null);
  await until(async () => (await f.get('/api/deployment')).json().phase === 'ready');
  assert.ok(f.runtime.confirmations > 0); assert.equal(f.clients.length, 1);
});

test('app close waits for the login child before closing the real workspace DB and preserves stored data on reopen', async t => {
  let store: WorkspaceStore | undefined;
  const originalOpen = WorkspaceStore.open;
  const openSpy = t.mock.method(WorkspaceStore, 'open', async (...args: Parameters<typeof WorkspaceStore.open>) => {
    const opened = await originalOpen.apply(WorkspaceStore, args); store ??= opened; return opened;
  });
  const f = await fixture(t); openSpy.mock.restore(); assert.ok(store);
  assert.equal((await f.post('/api/agents', { name: 'Saved before closing', persona: 'No model execution' })).statusCode, 201);
  await f.post('/api/desktop/setup/login', { revision: 0, method: 'chatgptDeviceCode' });
  const child = f.clients[0]; child.closeGate = deferred();
  let serviceClosing = false, dbClosed = false, appClosed = false;
  const originalServiceClose = AgentService.prototype.close;
  t.mock.method(AgentService.prototype, 'close', async function(this: AgentService) {
    serviceClosing = true; return originalServiceClose.call(this);
  });
  const originalClose = store.close.bind(store);
  t.mock.method(store, 'close', async () => { dbClosed = true; return originalClose(); });
  const closing = f.app.close().then(() => { appClosed = true; });
  await until(() => child.closeRequested); await delay(30);
  assert.equal(serviceClosing, false); assert.equal(dbClosed, false); assert.equal(appClosed, false);
  assert.equal((await store.read()).agents[0].name, 'Saved before closing');
  child.closeGate.resolve(); await closing;
  assert.equal(serviceClosing, true); assert.equal(dbClosed, true); assert.equal(appClosed, true); await assert.rejects(store.read());
  const reopened = await WorkspaceStore.open(f.dataDir);
  try { assert.equal((await reopened.read()).agents[0].name, 'Saved before closing'); }
  finally { await reopened.close(); }
});

test('the real unconfigured desktop runtime reaches deployment ready after its pending login child closes', async t => {
  const f = await fixture(t, { unconfiguredRuntime: true });
  assert.equal((await f.get('/api/workspace')).json().runtime.available, false);
  const login = await f.post('/api/desktop/setup/login', { revision: 0, method: 'chatgptDeviceCode' });
  assert.equal(login.statusCode, 200); const pending = login.json<DesktopSetupStatus>();
  assert.equal((await f.post('/api/deployment/prepare', {})).json().phase, 'draining');
  const canceled = await f.post('/api/desktop/setup/cancel', { revision: pending.revision, attemptId: pending.login!.attemptId });
  assert.equal(canceled.statusCode, 200); assert.equal(canceled.json().phase, 'disconnected');
  assert.equal(f.clients[0].closeRequested, true); await f.clients[0].closed;
  await until(async () => ['ready', 'blocked'].includes((await f.get('/api/deployment')).json().phase));
  const deployment = (await f.get('/api/deployment')).json();
  assert.equal(deployment.phase, 'ready', deployment.reason ?? 'The non-executing desktop runtime must be able to confirm idle');
  assert.ok(deployment.readyAt); assert.equal(deployment.reason, null);
  assert.equal((await f.status()).executionReady, false);
});
