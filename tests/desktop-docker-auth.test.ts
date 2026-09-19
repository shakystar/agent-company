import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DesktopDockerAuth } from '../server/desktop-docker-auth.ts';
import { openDesktopAccountHome } from '../server/desktop-account-home.ts';
import { DesktopSetup } from '../server/desktop-setup.ts';
import type { DesktopDockerTarget } from '../server/desktop-docker-target.ts';
import type { CommandOptions, CommandResult } from '../server/process.ts';

const deferred = () => {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const expected = (code: string) => (error: unknown) => {
  assert.ok(error instanceof Error && 'code' in error);
  assert.equal(error.code, code); assert.equal(error.message, code); assert.equal('cause' in error, false);
  return true;
};
async function fixture(t: TestContext, initialize = true) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-docker-auth-')), credentialsRoot = join(root, 'credentials'), workspaceKey = randomUUID();
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}ac-desktop-docker-auth-`));
    await rm(root, { recursive: true, force: true });
  });
  const authFile = join(credentialsRoot, 'codex', 'auth.json');
  if (initialize) {
    const home = await openDesktopAccountHome(credentialsRoot, workspaceKey);
    await writeFile(authFile, '{"tokens":{"access_token":"PRIVATE_FIXTURE"}}'); await home.release();
  }
  const calls: Array<{ args: string[]; options?: CommandOptions }> = [];
  let maps = 0, writer = false, response: CommandResult | undefined, commandFailure = false;
  let gate: ReturnType<typeof deferred> | undefined, started: ReturnType<typeof deferred> | undefined;
  let mapHook: ((signal?: AbortSignal) => Promise<void>) | undefined;
  const target: DesktopDockerTarget = {
    command: async (file, args, options) => {
      assert.equal(file, 'docker');
      assert.deepEqual(args, ['ps', '-aq', '--filter', `label=agent-company.credential-owner=${workspaceKey}`]);
      assert.equal(options?.timeoutMs, 15_000);
      calls.push({ args, options });
      const blocked = gate; gate = undefined; started?.resolve(); started = undefined;
      if (blocked) await blocked.promise;
      if (commandFailure) throw new Error('PRIVATE_DOCKER_FAILURE');
      return response ?? { code: 0, stdout: writer ? `${'a'.repeat(12)}\n` : '', stderr: '' };
    },
    mapFile: async () => { assert.fail('only auth.json may be mapped by this coordinator'); },
    mapAuthFile: async (path, signal) => {
      assert.equal(path, authFile); maps++; await mapHook?.(signal);
      return `/mnt/c/fixture/${workspaceKey}/auth.json`;
    },
  };
  const auth = new DesktopDockerAuth({ credentialsRoot, workspaceKey, target });
  return { root, credentialsRoot, workspaceKey, authFile, auth, calls, target, maps: () => maps,
    writer(value: boolean) { writer = value; }, response(value?: CommandResult) { response = value; },
    commandFailure(value: boolean) { commandFailure = value; },
    gateNext() { gate = deferred(); started = deferred(); return { gate, started }; },
    mapHook(value: (signal?: AbortSignal) => Promise<void>) { mapHook = value; },
  };
}

test('credential presence checks only the dedicated ownership marker and regular auth file without initializing or reading secrets', async t => {
  const f = await fixture(t, false);
  assert.equal(await f.auth.hasCredentials(), false); assert.deepEqual(await readdir(f.root), []);
  await mkdir(join(f.credentialsRoot, 'codex'), { recursive: true }); await writeFile(f.authFile, 'unowned');
  assert.equal(await f.auth.hasCredentials(), false);
  await writeFile(join(f.credentialsRoot, 'codex', 'desktop-codex-home.json'), JSON.stringify({ version: 1,
    product: 'agent-company-desktop-codex', workspaceKey: f.workspaceKey }));
  assert.equal(await f.auth.hasCredentials(), true); // Intentionally not a JSON or model-auth validity check.
  assert.equal(await readFile(f.authFile, 'utf8'), 'unowned'); assert.equal(f.calls.length, 0); assert.equal(f.maps(), 0);
  await writeFile(join(f.credentialsRoot, 'codex', 'desktop-codex-home.json'), JSON.stringify({ version: 1,
    product: 'agent-company-desktop-codex', workspaceKey: randomUUID() }));
  await assert.rejects(f.auth.hasCredentials(), expected('DESKTOP_DOCKER_AUTH_INVALID'));
});

test('FIFO acquisition shares the account lease; a queued cancellation starts no writer checks or path mapping', async t => {
  const f = await fixture(t), first = await f.auth.acquire(new AbortController().signal), middleController = new AbortController();
  let thirdDone = false;
  const middle = assert.rejects(f.auth.acquire(middleController.signal), expected('DESKTOP_DOCKER_AUTH_ABORTED'));
  const third = f.auth.acquire(new AbortController().signal).then(lease => { thirdDone = true; return lease; });
  const before = f.calls.length;
  middleController.abort(new Error('PRIVATE_CANCEL_REASON')); await middle;
  assert.equal(thirdDone, false); assert.equal(f.maps(), 1); assert.equal(f.calls.length, before);
  await assert.rejects(f.auth.assertIdle(), expected('DESKTOP_DOCKER_AUTH_BUSY'));
  await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
  await f.auth.retryCleanup(); assert.equal(f.calls.length, before); // Active lease is never released by this method.
  await first.release(); const next = await third;
  assert.equal(next.ownerKey, f.workspaceKey); assert.ok(next.source.endsWith('/auth.json')); assert.equal(f.maps(), 2);
  await next.release(); await f.auth.assertIdle();
});

test('active cancellation reports a redacted signal and retains the home until explicit real-writer cleanup', async t => {
  const f = await fixture(t), controller = new AbortController(), lease = await f.auth.acquire(controller.signal);
  controller.abort(new Error('PRIVATE_CANCEL_REASON'));
  assert.equal(lease.signal.aborted, true); assert.ok(expected('DESKTOP_DOCKER_AUTH_ABORTED')(lease.signal.reason));
  await assert.rejects(lease.validate(), expected('DESKTOP_DOCKER_AUTH_ABORTED'));
  await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
  await lease.release();
  const account = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await account.release();
});

test('account admission prevents new model leases until actual account cleanup releases its admission', async t => {
  const f = await fixture(t);
  const release = f.auth.admitAccount();
  assert.throws(() => f.auth.admitAccount(), expected('DESKTOP_DOCKER_AUTH_BUSY'));
  await assert.rejects(f.auth.assertIdle(), expected('DESKTOP_DOCKER_AUTH_BUSY'));
  const home = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey);
  await f.auth.assertNoWriters();
  const queuedController = new AbortController();
  const cancelled = assert.rejects(f.auth.acquire(queuedController.signal), expected('DESKTOP_DOCKER_AUTH_ABORTED'));
  queuedController.abort(); await cancelled;
  const next = f.auth.acquire(new AbortController().signal);
  assert.equal(f.maps(), 0); // No model-side home or WSL mapping while account admission remains held.
  await home.release(); assert.equal(f.maps(), 0);
  release(); release();
  const lease = await next; assert.equal(f.maps(), 1);
  assert.throws(() => f.auth.admitAccount(), expected('DESKTOP_DOCKER_AUTH_BUSY'));
  await lease.release(); await f.auth.assertIdle();
});

test('failed release blocks queued work and idle; retry waits real cleanup and never reopens the old lease', async t => {
  const f = await fixture(t), first = await f.auth.acquire(new AbortController().signal);
  f.writer(true);
  await assert.rejects(first.release(), expected('DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE'));
  await assert.rejects(first.validate(), expected('DESKTOP_DOCKER_AUTH_INVALID'));
  let admitted = false;
  const next = f.auth.acquire(new AbortController().signal).then(lease => { admitted = true; return lease; });
  await assert.rejects(f.auth.assertIdle(), expected('DESKTOP_DOCKER_AUTH_BUSY'));
  await assert.rejects(f.auth.retryCleanup(), expected('DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE'));
  assert.equal(admitted, false); assert.equal(f.maps(), 1);
  await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
  f.writer(false); await f.auth.retryCleanup(); const second = await next;
  assert.equal(f.maps(), 2); await second.release(); await f.auth.assertIdle();
});

test('already-unlocked invalid authentication reports damage without leaving permanent cleanup pending', async t => {
  const f = await fixture(t), lease = await f.auth.acquire(new AbortController().signal);
  await writeFile(f.authFile, 'PRIVATE_DAMAGED_AUTH');
  await assert.rejects(lease.release(), expected('DESKTOP_RUNTIME_AUTH_INVALID'));
  await f.auth.retryCleanup(); await f.auth.assertIdle();
  const account = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await account.release();
  await assert.rejects(f.auth.acquire(new AbortController().signal), expected('DESKTOP_RUNTIME_AUTH_INVALID'));
  await writeFile(f.authFile, '{}');
  const repaired = await f.auth.acquire(new AbortController().signal); await repaired.release();
});

test('cancellation during mapping does not settle admission before its acquired home is cleaned up', async t => {
  const f = await fixture(t), mapping = deferred(), controller = new AbortController();
  f.mapHook(signal => new Promise((_yes, no) => {
    mapping.resolve(); signal!.addEventListener('abort', () => no(new Error('PRIVATE_MAP_CANCEL')), { once: true });
  }));
  let settled = false;
  const acquiring = assert.rejects(f.auth.acquire(controller.signal), expected('DESKTOP_DOCKER_AUTH_ABORTED')).then(() => { settled = true; });
  await mapping.promise;
  const cleanup = f.gateNext(); controller.abort(); await cleanup.started.promise;
  assert.equal(settled, false);
  await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
  cleanup.gate.resolve(); await acquiring;
  assert.equal(f.maps(), 1); await f.auth.assertIdle();
});

test('stale writer state blocks acquisition before mapping and account writer checks work under the active home lease', async t => {
  const f = await fixture(t); f.writer(true);
  await assert.rejects(f.auth.acquire(new AbortController().signal), expected('DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE'));
  assert.equal(f.maps(), 0);
  const account = await openDesktopAccountHome(f.credentialsRoot, f.workspaceKey); await account.release();
  f.writer(false); const lease = await f.auth.acquire(new AbortController().signal);
  await f.auth.assertNoWriters(); // The method cannot reject solely because this coordinator owns the lease.
  await lease.release();
});

test('malformed, duplicate, failed and unknown Docker inventory all fail closed with fixed errors', async t => {
  const f = await fixture(t);
  for (const stdout of ['PRIVATE_DIAGNOSTIC', 'abc\n', `${'a'.repeat(12)}\n${'a'.repeat(12)}\n`,
    `${'a'.repeat(12)}\n${'a'.repeat(64)}\n`, '\n', ' \n', `${'a'.repeat(12)}\n\n`]) {
    f.response({ code: 0, stdout, stderr: 'PRIVATE_STDERR' });
    await assert.rejects(f.auth.assertNoWriters(), expected('DESKTOP_DOCKER_AUTH_IDLE_UNCONFIRMED'));
  }
  f.response({ code: 1, stdout: '', stderr: 'PRIVATE_FAILED_QUERY' });
  await assert.rejects(f.auth.assertNoWriters(), expected('DESKTOP_DOCKER_AUTH_IDLE_UNCONFIRMED'));
  f.commandFailure(true);
  await assert.rejects(f.auth.assertNoWriters(), expected('DESKTOP_DOCKER_AUTH_IDLE_UNCONFIRMED'));
  f.commandFailure(false); f.response({ code: 0, stdout: `${'a'.repeat(64)}\n`, stderr: '' });
  await assert.rejects(f.auth.assertNoWriters(), expected('DESKTOP_DOCKER_AUTH_WRITER_ACTIVE'));
});

test('idle confirmation cannot race an acquisition admitted while the Docker read is pending', async t => {
  const f = await fixture(t), gate = f.gateNext();
  const idle = assert.rejects(f.auth.assertIdle(), expected('DESKTOP_DOCKER_AUTH_BUSY'));
  await gate.started.promise;
  const lease = await f.auth.acquire(new AbortController().signal);
  gate.gate.resolve(); await idle; await lease.release();
});

test('presence rejects hard links and a pre-canceled acquisition does not inspect Docker', async t => {
  const f = await fixture(t); await link(f.authFile, join(f.root, 'alias'));
  await assert.rejects(f.auth.hasCredentials(), expected('DESKTOP_DOCKER_AUTH_INVALID'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.auth.acquire(controller.signal), expected('DESKTOP_DOCKER_AUTH_ABORTED'));
  assert.equal(f.calls.length, 0); assert.equal(f.maps(), 0);
  assert.equal((await lstat(f.authFile)).nlink, 2);
});

test('device cancellation retains its existing account admission until the client releases the real home lease', async t => {
  const f = await fixture(t), closeGate = deferred(), closeStarted = deferred(), closed = deferred();
  const setup = new DesktopSetup({ provider: { executable: 'fixture.exe', version: '0.154.0' },
    credentialsRoot: f.credentialsRoot, workspaceKey: f.workspaceKey,
    admit: () => f.auth.admitAccount(), assertIdle: () => f.auth.assertAccountAvailable(),
    assertNoCredentialWriters: () => f.auth.assertNoWriters(),
    openAccount: async options => {
      const home = await openDesktopAccountHome(options.credentialsRoot, options.workspaceKey);
      await options.assertNoCredentialWriters!();
      return { closed: closed.promise, readAccount: async () => ({ account: null, requiresOpenaiAuth: true }),
        startLogin: async () => ({ type: 'chatgptDeviceCode', loginId: 'fixture-login',
          verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FIXT-1234' }),
        cancelLogin: async () => ({ status: 'canceled' }), logout: async () => {},
        close: async () => { closeStarted.resolve(); await closeGate.promise; await home.release(); closed.resolve(); } };
    } });
  t.after(async () => { closeGate.resolve(); await setup.close(); });
  const pending = await setup.login({ revision: 0, method: 'chatgptDeviceCode' });
  assert.equal(pending.phase, 'awaiting');
  assert.throws(() => setup.cancel(0, pending.login!.attemptId), { code: 'SETUP_STALE' });
  assert.throws(() => setup.cancel(pending.revision, randomUUID()), { code: 'SETUP_STALE_LOGIN' });
  let modelAdmitted = false;
  const model = f.auth.acquire(new AbortController().signal).then(lease => { modelAdmitted = true; return lease; });
  const cancel = setup.cancel(pending.revision, pending.login!.attemptId);
  await closeStarted.promise;
  assert.equal(setup.status().phase, 'canceling'); assert.equal(modelAdmitted, false); assert.equal(f.maps(), 0);
  await assert.rejects(openDesktopAccountHome(f.credentialsRoot, f.workspaceKey), { code: 'ELOCKED' });
  assert.throws(() => f.auth.assertAccountAvailable(), expected('DESKTOP_DOCKER_AUTH_BUSY'));
  closeGate.resolve(); assert.equal((await cancel).phase, 'disconnected');
  const lease = await model; assert.equal(modelAdmitted, true); await lease.release(); await f.auth.assertIdle();
});
