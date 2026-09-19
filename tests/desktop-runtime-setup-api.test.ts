import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.ts';
import { createDesktopAccess } from '../server/desktop-access.ts';
import { DesktopSetup } from '../server/desktop-setup.ts';
import { DesktopRuntimeSetup, type DesktopRuntimeSetupOptions } from '../server/desktop-runtime-setup.ts';
import type { DesktopRuntimeRecoveryInfo } from '../shared/desktop-runtime-setup.ts';
import { desktopRuntimeSettings } from '../server/desktop-runtime-settings.ts';
import { WorkspaceStore } from '../server/store.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

const selection = { kind: 'wsl-docker' as const, wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Fixture-Distro', model: 'fixture-model' };
const recoveryInfo = (): DesktopRuntimeRecoveryInfo => ({ fingerprint: 'b'.repeat(64), selection: { ...selection }, images: [{ kind: 'worker', status: 'present' }] });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const until = async (check: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Local API state timed out'); await delay(10); }
};
class NoModelRuntime extends StorageFixtureRuntime {
  override async execute(): Promise<never> { assert.fail('Initial setup must not execute a model'); }
  async confirmDeploymentIdle() {}
}
async function fixture(t: test.TestContext, desktop = true, installer = false, recovering = false) {
  const root = await mkdtemp(join(tmpdir(), 'ac-runtime-setup-api-')), owner = randomUUID();
  const appData = join(root, 'appdata'), dataDir = join(root, 'workspace', 'db'); await mkdir(appData);
  await writeFile(join(appData, 'desktop-installation.json'), JSON.stringify({ version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: owner }));
  const settings = desktopRuntimeSettings(appData, owner), initial = await settings.read();
  const token = randomBytes(32).toString('base64url'), cookieName = `ac_desktop_${randomBytes(16).toString('hex')}`;
  let origin = 'http://127.0.0.1:46703';
  const headers = { host: '127.0.0.1:46703', origin, cookie: `${cookieName}=${token}` };
  let probe: (signal: AbortSignal) => Promise<void> = async () => {}; let calls = 0;
  let install: NonNullable<DesktopRuntimeSetupOptions['install']> = async () => {}; let installCalls = 0;
  const recovery: NonNullable<DesktopRuntimeSetupOptions['recovery']> = { inspect: async () => recoveryInfo(), recover: async () => {}, finish: async () => {} };
  const app = await createApp({ dataDir, runtime: new NoModelRuntime(owner), ...(desktop ? {
    desktopAccess: createDesktopAccess({ token, cookieName, origin: () => origin }),
    desktopSetup: admit => new DesktopSetup({ provider: null, credentialsRoot: join(appData, 'credentials'), workspaceKey: owner, admit, assertIdle() {} }),
    desktopRuntimeSetup: admit => new DesktopRuntimeSetup({ available: true, recoveryRequired: recovering, initial, settings,
      admit, assertAccountIdle() {}, probe: async (_, signal) => { calls++; await probe(signal); },
      ...(recovering ? { recovery } : {}),
      ...(installer ? { install: async (selection, signal, progress) => { installCalls++; return install(selection, signal, progress); } } : {}) }),
  } : {}) });
  t.after(async () => { await app.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /ac-runtime-setup-api-[^\\/]+$/); await rm(root, { recursive: true, force: true }); });
  const get = (url: string) => app.inject({ url, headers });
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload });
  return { app, appData, dataDir, settings, get, post, headers, recovery, calls: () => calls, probe: (value: typeof probe) => { probe = value; },
    installCalls: () => installCalls, install: (value: typeof install) => { install = value; },
    async listen() { origin = await app.listen({ host: '127.0.0.1', port: 0 }); headers.host = new URL(origin).host; headers.origin = origin; return origin; } };
}

test('runtime setup is desktop-only, guarded and strict; first save exposes no private selection in workspace', async t => {
  const cli = await fixture(t, false);
  assert.equal((await cli.get('/api/desktop/runtime-setup')).statusCode, 404);
  for (const action of ['inspect', 'retry']) assert.equal((await cli.post(`/api/desktop/runtime-setup/recovery/${action}`, { revision: 0 })).statusCode, 404);
  assert.equal((await cli.get('/api/workspace')).json().desktop, undefined);
  const f = await fixture(t);
  assert.equal((await f.app.inject({ url: '/api/desktop/runtime-setup', headers: { host: f.headers.host } })).statusCode, 403);
  assert.equal((await f.app.inject({ url: '/api/desktop/runtime-setup', headers: { ...f.headers, origin: 'http://127.0.0.1:9999' } })).statusCode, 403);
  assert.equal((await f.post('/api/desktop/runtime-setup/configure', { revision: 0, selection: { ...selection, apiKey: 'PRIVATE' } })).statusCode, 400);
  assert.equal((await f.post('/api/desktop/runtime-setup/configure', { revision: 0, selection: { ...selection, wslExecutable: 'wsl.exe' } })).statusCode, 400);
  assert.equal(f.calls(), 0);
  const response = await f.post('/api/desktop/runtime-setup/configure', { revision: 0, selection });
  assert.equal(response.statusCode, 200); assert.equal(response.json().phase, 'restartRequired');
  assert.deepEqual((await f.settings.read()).selection, selection);
  const workspace = (await f.get('/api/workspace')).json(); assert.equal(workspace.desktop.runtimeSetup, true);
  const serialized = JSON.stringify(workspace);
  assert.ok(!serialized.includes(selection.distro)); assert.ok(!serialized.includes('wsl.exe'));
  assert.equal((await f.get('/api/desktop/runtime-setup')).json().phase, 'restartRequired');
});

test('image install and cancel remain desktop guarded, strict and revision checked before installer admission', async t => {
  const cli = await fixture(t, false);
  assert.equal((await cli.post('/api/desktop/runtime-setup/install', { revision: 0, selection })).statusCode, 404);
  assert.equal((await cli.post('/api/desktop/runtime-setup/cancel', { revision: 0 })).statusCode, 404);
  const f = await fixture(t, true, true);
  assert.equal((await f.get('/api/desktop/runtime-setup')).json().imageInstallAvailable, true);
  for (const url of ['/api/desktop/runtime-setup/install', '/api/desktop/runtime-setup/cancel']) {
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { host: f.headers.host }, payload: { revision: 0, selection } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { ...f.headers, origin: 'http://127.0.0.1:9999' }, payload: { revision: 0, selection } })).statusCode, 403);
  }
  for (const body of [{ revision: -1, selection }, { revision: 0.5, selection }, { revision: '0', selection },
    { revision: 0, selection, token: 'PRIVATE_TOKEN' }, { revision: 0, selection: { ...selection, auth: 'PRIVATE_AUTH' } },
    { revision: 0, selection: { ...selection, wslExecutable: 'wsl.exe' } }]) {
    const response = await f.post('/api/desktop/runtime-setup/install', body);
    assert.equal(response.statusCode, 400); assert.ok(!response.body.includes('PRIVATE'));
  }
  for (const body of [{ revision: '0' }, { revision: 0, selection }, { revision: -1 }, { revision: 0, token: 'PRIVATE_TOKEN' }]) {
    const response = await f.post('/api/desktop/runtime-setup/cancel', body); assert.equal(response.statusCode, 400); assert.ok(!response.body.includes('PRIVATE'));
  }
  assert.equal((await f.post('/api/desktop/runtime-setup/install', { revision: 9, selection })).statusCode, 409);
  assert.equal((await f.post('/api/desktop/runtime-setup/cancel', { revision: 9 })).statusCode, 409);
  assert.equal((await f.post('/api/desktop/runtime-setup/cancel', { revision: 0 })).statusCode, 409);
  assert.equal(f.installCalls(), 0); assert.equal(f.calls(), 0); assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
});

test('open HTTP install and cancel keep deployment draining until real mock cleanup, with held status and no new install', { timeout: 15_000 }, async t => {
  const ended = deferred(), started = deferred(); t.after(() => ended.resolve());
  const f = await fixture(t, true, true); let aborted = false;
  f.install(async (value, signal, progress) => {
    assert.deepEqual(value, selection); progress({ stage: 'loading', completed: 1, total: 2 });
    signal.addEventListener('abort', () => { aborted = true; }); started.resolve(); await ended.promise;
  });
  const origin = await f.listen();
  const httpPost = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const httpGet = (path: string) => fetch(origin + path, { headers: f.headers });
  let installEnded = false, cancelEnded = false;
  const installing = httpPost('/api/desktop/runtime-setup/install', { revision: 0, selection }).then(response => { installEnded = true; return response; });
  await started.promise;
  const state = await (await httpGet('/api/desktop/runtime-setup')).json(); assert.equal(state.phase, 'installing');
  assert.deepEqual(state.progress, { stage: 'loading', completed: 1, total: 2 });
  assert.equal((await (await httpPost('/api/deployment/prepare', {})).json()).phase, 'draining');
  assert.equal((await httpGet('/api/desktop/runtime-setup')).status, 200);
  assert.equal((await httpPost('/api/desktop/runtime-setup/install', { revision: state.revision, selection })).status, 409);
  assert.equal((await httpPost('/api/desktop/runtime-setup/cancel', { revision: 0 })).status, 409); assert.equal(aborted, false);
  const cancelling = httpPost('/api/desktop/runtime-setup/cancel', { revision: state.revision }).then(response => { cancelEnded = true; return response; });
  await until(() => aborted);
  assert.equal((await (await httpGet('/api/desktop/runtime-setup')).json()).phase, 'canceling');
  await delay(250); assert.equal(installEnded, false); assert.equal(cancelEnded, false);
  assert.equal((await (await httpGet('/api/deployment')).json()).phase, 'draining');
  assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
  await assert.rejects(readFile(join(f.appData, 'desktop-runtime-configured.json')), { code: 'ENOENT' });
  ended.resolve(); const [installed, cancelled] = await Promise.all([installing, cancelling]);
  assert.equal(installed.status, 200); assert.equal(cancelled.status, 200);
  const final = await cancelled.json(); assert.equal(final.phase, 'unconfigured'); assert.equal(final.error.code, 'SETUP_RUNTIME_CANCELLED');
  assert.deepEqual(await installed.json(), final); assert.equal(final.selection, null);
  await until(async () => (await (await httpGet('/api/deployment')).json()).phase === 'ready');
  assert.equal((await httpPost('/api/desktop/runtime-setup/install', { revision: final.revision, selection })).status, 409);
  assert.equal(f.installCalls(), 1); assert.equal(f.calls(), 0);
  await assert.rejects(readFile(join(f.appData, 'desktop-runtime.json')), { code: 'ENOENT' });
});

test('actual HTTP close aborts installation and waits both POST and cleanup before DB release', { timeout: 15_000 }, async t => {
  const ended = deferred(), started = deferred(); t.after(() => ended.resolve());
  const f = await fixture(t, true, true); let aborted = false;
  assert.equal((await f.post('/api/agents', { name: 'Preserved installer fixture', persona: 'No models' })).statusCode, 201);
  f.install(async (_, signal) => { signal.addEventListener('abort', () => { aborted = true; }); started.resolve(); await ended.promise; });
  const origin = await f.listen();
  let postEnded = false;
  const installing = fetch(origin + '/api/desktop/runtime-setup/install', { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 0, selection }) }).then(response => { postEnded = true; return response; });
  await started.promise;
  let closed = false; const closing = f.app.close().then(() => { closed = true; });
  await until(() => aborted); await delay(100); assert.equal(closed, false); assert.equal(postEnded, false);
  await assert.rejects(readFile(join(f.appData, 'desktop-runtime.json')), { code: 'ENOENT' });
  ended.resolve(); const response = await installing; assert.equal(response.status, 200); assert.equal((await response.json()).phase, 'closing');
  await closing; assert.equal(closed, true); assert.equal(f.calls(), 0); assert.equal(f.installCalls(), 1);
  const reopened = await WorkspaceStore.open(f.dataDir);
  try { assert.equal((await reopened.read()).agents[0].name, 'Preserved installer fixture'); } finally { await reopened.close(); }
  await assert.rejects(readFile(join(f.appData, 'desktop-runtime-configured.json')), { code: 'ENOENT' });
});

test('installation failures expose fixed messages without saving and uncertain completion blocks subsequent setup', async t => {
  const f = await fixture(t, true, true);
  for (const code of ['DESKTOP_RUNTIME_INSTALL_FAILED', 'DESKTOP_RUNTIME_INSTALL_SPACE', 'DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE', 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN']) {
    f.install(async () => { throw Object.assign(new Error('PRIVATE_TOKEN C:\\private\\auth.json raw Docker stderr'), { code }); });
    const before = (await f.get('/api/desktop/runtime-setup')).json();
    const response = await f.post('/api/desktop/runtime-setup/install', { revision: before.revision, selection });
    assert.equal(response.statusCode, 200); assert.ok(!response.body.includes('PRIVATE')); assert.ok(!response.body.includes('auth.json'));
    const state = response.json(); assert.equal(state.selection, null); assert.equal(state.progress, null);
    assert.equal(state.phase, code.endsWith('UNCERTAIN') ? 'recoveryRequired' : 'unconfigured');
    if (code.endsWith('SPACE')) assert.equal(state.error.message, '실행 이미지를 설치할 여유 공간이 부족합니다.');
    if (code.endsWith('INCOMPATIBLE')) assert.equal(state.error.message, '실행 이미지와 Docker 저장 방식이 호환되지 않습니다. 호환되는 설치 묶음이 필요합니다.');
    if (code.endsWith('UNCERTAIN')) {
      assert.equal(state.error.code, 'SETUP_RUNTIME_INSTALL_UNCERTAIN'); assert.equal(state.available, false);
      assert.equal((await f.post('/api/desktop/runtime-setup/install', { revision: state.revision, selection })).statusCode, 409);
      assert.equal((await f.post('/api/desktop/runtime-setup/configure', { revision: state.revision, selection })).statusCode, 409);
    }
    assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
    await assert.rejects(readFile(join(f.appData, 'desktop-runtime-configured.json')), { code: 'ENOENT' });
    const workspace = (await f.get('/api/workspace')).body; assert.ok(!workspace.includes('PRIVATE')); assert.ok(!workspace.includes(selection.distro));
  }
  assert.equal(f.calls(), 0); assert.equal(f.installCalls(), 4);
});

test('pending setup prevents deployment readiness; status works while held and ready follows actual probe completion', async t => {
  const f = await fixture(t), gate = deferred(), started = deferred();
  f.probe(async () => { started.resolve(); await gate.promise; });
  const pending = f.post('/api/desktop/runtime-setup/configure', { revision: 0, selection });
  await started.promise;
  const state = (await f.get('/api/desktop/runtime-setup')).json(); assert.equal(state.phase, 'checking');
  assert.equal((await f.post('/api/desktop/runtime-setup/configure', { revision: state.revision, selection })).statusCode, 409);
  assert.equal((await f.post('/api/deployment/prepare', {})).json().phase, 'draining');
  await delay(300); assert.equal((await f.get('/api/deployment')).json().phase, 'draining');
  assert.equal((await f.get('/api/desktop/runtime-setup')).statusCode, 200);
  assert.equal((await f.post('/api/desktop/runtime-setup/configure', { revision: state.revision, selection })).statusCode, 409);
  gate.resolve(); assert.equal((await pending).json().phase, 'restartRequired');
  await until(async () => (await f.get('/api/deployment')).json().phase === 'ready');
  assert.equal(f.calls(), 1);
});

test('app shutdown aborts verification and waits for its child boundary before closing the saved DB', async t => {
  const f = await fixture(t), gate = deferred(), started = deferred(); let aborted = false;
  assert.equal((await f.post('/api/agents', { name: 'Saved agent', persona: 'No model calls' })).statusCode, 201);
  f.probe(async signal => { signal.addEventListener('abort', () => { aborted = true; }); started.resolve(); await gate.promise; });
  const pending = f.post('/api/desktop/runtime-setup/configure', { revision: 0, selection }); await started.promise;
  let ended = false; const closing = f.app.close().then(() => { ended = true; });
  await until(() => aborted); assert.equal(ended, false);
  await assert.rejects(readFile(join(f.appData, 'desktop-runtime.json')), { code: 'ENOENT' });
  gate.resolve(); await Promise.all([pending, closing]);
  const reopened = await WorkspaceStore.open(f.dataDir);
  try { assert.equal((await reopened.read()).agents[0].name, 'Saved agent'); }
  finally { await reopened.close(); }
  await assert.rejects(readFile(join(f.appData, 'desktop-runtime.json')), { code: 'ENOENT' });
});

test('actual HTTP shutdown cancels an admitted probe before waiting for the open POST response', { timeout: 15_000 }, async t => {
  const f = await fixture(t), gate = deferred(), started = deferred(); let aborted = false;
  f.probe(async signal => { signal.addEventListener('abort', () => { aborted = true; }); started.resolve(); await gate.promise; });
  const origin = await f.listen();
  const pending = fetch(origin + '/api/desktop/runtime-setup/configure', { method: 'POST',
    headers: { ...f.headers, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, selection }) });
  await started.promise;
  let ended = false; const closing = f.app.close().then(() => { ended = true; });
  try { await until(() => aborted); assert.equal(ended, false); }
  finally { gate.resolve(); }
  const response = await pending; assert.equal(response.status, 200); assert.equal((await response.json()).phase, 'closing');
  await closing; await assert.rejects(readFile(join(f.appData, 'desktop-runtime.json')), { code: 'ENOENT' });
});

test('recovery HTTP input admits only revision, guards both routes and never publishes the recorded target in workspace', async t => {
  const f = await fixture(t, true, false, true); let inspections = 0, replays = 0, finishes = 0;
  f.recovery.inspect = async () => { inspections++; return recoveryInfo(); };
  f.recovery.recover = async info => { replays++; assert.deepEqual(info, recoveryInfo()); };
  f.recovery.finish = async () => { finishes++; assert.deepEqual(await f.settings.read(), { revision: 1, selection }); };
  assert.equal((await f.get('/api/desktop/runtime-setup')).json().recoveryAvailable, true);
  for (const action of ['inspect', 'retry']) {
    const url = `/api/desktop/runtime-setup/recovery/${action}`;
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { host: f.headers.host }, payload: { revision: 0 } })).statusCode, 403);
    for (const body of [{ revision: -1 }, { revision: '0' }, { revision: 0.5 }, { revision: 0, selection },
      { revision: 0, fingerprint: 'b'.repeat(64) }, { revision: 0, token: 'PRIVATE' }]) {
      const result = await f.post(url, body); assert.equal(result.statusCode, 400); assert.ok(!result.body.includes('PRIVATE'));
    }
    assert.equal((await f.post(url, { revision: 1 })).statusCode, 409);
  }
  assert.equal((await f.post('/api/desktop/runtime-setup/recovery/retry', { revision: 0 })).statusCode, 409);
  assert.equal(inspections, 0); assert.equal(replays, 0);
  const inspected = (await f.post('/api/desktop/runtime-setup/recovery/inspect', { revision: 0 })).json();
  assert.deepEqual(inspected.recovery, recoveryInfo()); assert.equal(inspections, 1); assert.equal(f.calls(), 0);
  assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
  const workspace = (await f.get('/api/workspace')).body; assert.ok(!workspace.includes(selection.distro)); assert.ok(!workspace.includes('wsl.exe'));
  const saved = await f.post('/api/desktop/runtime-setup/recovery/retry', { revision: inspected.revision });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().phase, 'restartRequired'); assert.equal(replays, 1); assert.equal(finishes, 1); assert.equal(f.calls(), 1);
});

test('open HTTP recovery and cancel stay draining until mock cleanup; held status remains available and retry cannot restart', { timeout: 15_000 }, async t => {
  const started = deferred(), ended = deferred(); t.after(() => ended.resolve()); const f = await fixture(t, true, false, true); let aborted = false, finishes = 0;
  f.recovery.recover = async (_, signal, progress) => { progress({ stage: 'loading', completed: 0, total: 1 });
    signal.addEventListener('abort', () => { aborted = true; }); started.resolve(); await ended.promise; };
  f.recovery.finish = async () => { finishes++; };
  const origin = await f.listen(), headers = { ...f.headers, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = (path: string) => fetch(origin + path, { headers });
  const inspected = await (await post('/api/desktop/runtime-setup/recovery/inspect', { revision: 0 })).json();
  let recoveryEnded = false, cancelEnded = false;
  const recovering = post('/api/desktop/runtime-setup/recovery/retry', { revision: inspected.revision }).then(response => { recoveryEnded = true; return response; });
  await started.promise; const current = await (await get('/api/desktop/runtime-setup')).json(); assert.equal(current.phase, 'recovering');
  assert.equal((await (await post('/api/deployment/prepare', {})).json()).phase, 'draining');
  assert.equal((await get('/api/desktop/runtime-setup')).status, 200);
  for (const action of ['inspect', 'retry']) assert.equal((await post(`/api/desktop/runtime-setup/recovery/${action}`, { revision: current.revision })).status, 409);
  assert.equal((await post('/api/desktop/runtime-setup/cancel', { revision: 0 })).status, 409); assert.equal(aborted, false);
  const cancel = post('/api/desktop/runtime-setup/cancel', { revision: current.revision }).then(response => { cancelEnded = true; return response; });
  await until(() => aborted); await delay(100); assert.equal(recoveryEnded, false); assert.equal(cancelEnded, false);
  assert.equal((await (await get('/api/deployment')).json()).phase, 'draining');
  assert.deepEqual(await f.settings.read(), { revision: 0, selection: null }); assert.equal(finishes, 0);
  ended.resolve(); const [original, cancelled] = await Promise.all([recovering, cancel]); const result = await cancelled.json();
  assert.equal(original.status, 200); assert.deepEqual(await original.json(), result); assert.equal(result.phase, 'recoveryRequired');
  assert.equal(result.recovery, null); assert.equal(result.error.code, 'SETUP_RUNTIME_RECOVERY_CANCELLED'); assert.equal(finishes, 0); assert.equal(f.calls(), 0);
  await until(async () => (await (await get('/api/deployment')).json()).phase === 'ready');
  for (const action of ['inspect', 'retry']) assert.equal((await post(`/api/desktop/runtime-setup/recovery/${action}`, { revision: result.revision })).status, 409);
  await assert.rejects(readFile(join(f.appData, 'desktop-runtime.json')), { code: 'ENOENT' });
});

test('actual HTTP shutdown waits committed recovery finalization before closing DB and does not claim cancellation', { timeout: 15_000 }, async t => {
  const started = deferred(), ended = deferred(); t.after(() => ended.resolve()); const f = await fixture(t, true, false, true);
  assert.equal((await f.post('/api/agents', { name: 'Recovery close fixture', persona: 'No models' })).statusCode, 201);
  f.recovery.finish = async () => { started.resolve(); await ended.promise; };
  const inspected = (await f.post('/api/desktop/runtime-setup/recovery/inspect', { revision: 0 })).json();
  const origin = await f.listen(); let responded = false;
  const response = fetch(origin + '/api/desktop/runtime-setup/recovery/retry', { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: inspected.revision }) }).then(result => { responded = true; return result; });
  await started.promise;
  assert.equal((await f.post('/api/desktop/runtime-setup/cancel', { revision: (await f.get('/api/desktop/runtime-setup')).json().revision })).statusCode, 409);
  let closed = false; const closing = f.app.close().then(() => { closed = true; }); await delay(100);
  assert.equal(closed, false); assert.equal(responded, false); assert.deepEqual(await f.settings.read(), { revision: 1, selection });
  ended.resolve(); const result = await response; assert.equal(result.status, 200); const state = await result.json();
  assert.equal(state.phase, 'closing'); assert.equal(state.error, null); await closing;
  const reopened = await WorkspaceStore.open(f.dataDir);
  try { assert.equal((await reopened.read()).agents[0].name, 'Recovery close fixture'); } finally { await reopened.close(); }
});

test('recovery HTTP failures are redacted and retain the recovery gate without settings changes', async t => {
  const f = await fixture(t, true, false, true); let finishes = 0;
  f.recovery.finish = async () => { finishes++; };
  for (const code of ['DESKTOP_RUNTIME_INSTALL_UNCERTAIN', 'DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE', 'DESKTOP_RUNTIME_INSTALL_SPACE']) {
    const diagnosed = (await f.post('/api/desktop/runtime-setup/recovery/inspect', { revision: (await f.get('/api/desktop/runtime-setup')).json().revision })).json();
    f.recovery.recover = async () => { throw Object.assign(new Error('PRIVATE_PATH C:\\private\\auth.json'), { code }); };
    const response = await f.post('/api/desktop/runtime-setup/recovery/retry', { revision: diagnosed.revision });
    assert.equal(response.statusCode, 200); const state = response.json(); assert.equal(state.phase, 'recoveryRequired'); assert.equal(state.recovery, null);
    assert.equal(state.error.code, 'SETUP_RUNTIME_RECOVERY_FAILED'); assert.ok(!response.body.includes('PRIVATE')); assert.ok(!response.body.includes('auth.json'));
    if (code.endsWith('INCOMPATIBLE')) assert.match(state.error.message, /Docker 저장 방식이 호환되지 않습니다/);
    if (code.endsWith('SPACE')) assert.match(state.error.message, /여유 공간이 부족합니다/);
    assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
  }
  assert.equal(finishes, 0); assert.equal(f.calls(), 0);
});
