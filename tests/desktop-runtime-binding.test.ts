import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerRuntime, dockerArguments, kubernetesResources, runtimeConfig, type RuntimeConfig } from '../server/runtime.ts';
import type { RuntimeAuthBinding, RuntimeAuthBindingLease } from '../server/runtime-auth-binding.ts';
import type { Command, CommandOptions } from '../server/process.ts';
import type { ExecutionHooks, ExecutionInput } from '../shared/types.ts';
import type { ModelPhase } from '../shared/telemetry.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { openDesktopAccountHome } from '../server/desktop-account-home.ts';
import { DesktopDockerAuth } from '../server/desktop-docker-auth.ts';
import { createWorkerReleaseManifest, workerSourceFiles, legacyWorkerEntrySha256 } from '../shared/runtime-releases.ts';

const ownerKey = '989e7400-b7ba-42d7-b2d6-e5d5fd8d7254';
const config: RuntimeConfig = { mode: 'docker', auth: 'desktop-codex', authFile: '', image: `sha256:${'a'.repeat(64)}`,
  workspaceKey: ownerKey, model: 'test-model', timeoutMs: 10_000, persistentWorkspaces: false };
const at = '2026-09-12T00:00:00.000Z';
const input: ExecutionInput = {
  agent: { id: 'agent-a', name: 'one', description: '', persona: 'Research', color: '#345555', model: 'test-model', status: 'running',
    generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: at, updatedAt: at },
  run: { id: 'run-a', agentId: 'agent-a', agentVersion: 1, snapshotId: 'snapshot-a', prompt: 'a task', status: 'running', result: '', error: null,
    inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: at, completedAt: null },
  memories: [], skills: [], connections: [],
};
const task = { result: 'completed', memories: [], skills: [], artifacts: [], inputTokens: 10, outputTokens: 4 };
const hooks = (extra: Partial<ExecutionHooks> = {}): ExecutionHooks => ({ signal: new AbortController().signal,
  onEvent: async () => {}, getSteering: async () => [], ...extra });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

function harness(options: { config?: Partial<RuntimeConfig>; model?: (options: CommandOptions) => Promise<void> } = {}) {
  const events: string[] = [], calls: Array<{ args: string[]; payload?: Record<string, unknown> }> = [];
  const leaseController = new AbortController();
  let active = false, pending = false, worker = false, credentials = true, failRemove = false, invalidFile = false, validateCount = 0;
  const authentication: RuntimeAuthBinding = {
    ownerKey, hasCredentials: async () => credentials,
    async acquire(signal) {
      signal.throwIfAborted(); assert.equal(active, false); assert.equal(worker, false); active = true; events.push('acquire');
      const lease: RuntimeAuthBindingLease = {
        source: '/mnt/c/설치 폴더, beta/credentials/codex/auth.json', ownerKey, signal: leaseController.signal,
        async validate() { events.push('validate'); validateCount++; if (invalidFile) throw Object.assign(new Error('DESKTOP_RUNTIME_AUTH_INVALID'), { code: 'DESKTOP_RUNTIME_AUTH_INVALID' }); },
        async release() {
          events.push('release');
          if (worker) { pending = true; throw new Error('PRIVATE_WRITER_ACTIVE'); }
          active = false; pending = false;
          if (invalidFile) throw Object.assign(new Error('DESKTOP_RUNTIME_AUTH_INVALID'), { code: 'DESKTOP_RUNTIME_AUTH_INVALID' });
        },
      };
      return lease;
    },
    async assertNoWriters() { if (worker) throw new Error('PRIVATE_WRITER_ACTIVE'); },
    async assertIdle() { events.push('idle'); if (active || pending || worker) throw new Error('AUTH_BUSY'); },
    async retryCleanup() {
      events.push('retry-auth');
      if (pending) { if (worker) throw new Error('PRIVATE_WRITER_ACTIVE'); active = false; pending = false; }
    },
  };
  const runner: Command = async (file, args, commandOptions = {}) => {
    assert.equal(file, 'docker');
    const payload = commandOptions.input ? JSON.parse(commandOptions.input) : undefined;
    calls.push({ args, payload });
    if (args[0] === 'version') return { code: 0, stdout: args[2]?.includes('Arch') ? '29.1.3/amd64' : '29.1.3', stderr: '' };
    if (args[0] === 'image') return { code: 0, stdout: config.image, stderr: '' };
    if (args[0] === 'ps') return { code: 0, stdout: worker ? 'a'.repeat(12) : '', stderr: '' };
    if (args[0] === 'volume') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'rm') {
      events.push('remove');
      if (failRemove) return { code: 1, stdout: '', stderr: 'PRIVATE_REMOVE_ERROR' };
      worker = false; return { code: 0, stdout: '', stderr: '' };
    }
    assert.equal(args[0], 'run'); assert.equal(active, true); worker = true; events.push('model');
    const legacy = options.config?.historicalAuthBindings?.some(binding => binding.pin.image === args.at(-1));
    if (legacy) assert.equal(Object.hasOwn(payload, 'authBinding'), false);
    else assert.equal(payload.authBinding, 'codex-file-v1');
    assert.equal(Object.hasOwn(payload, 'auth'), false);
    assert.ok(args.includes(`agent-company.credential-owner=${ownerKey}`));
    assert.ok(!JSON.stringify(payload).includes('/mnt/c'));
    await options.model?.(commandOptions);
    await commandOptions.onLine?.(JSON.stringify({ type: 'result', result: task }));
    return { code: 0, stdout: '', stderr: '' };
  };
  const mapHostPath = async (file: string) => { events.push('map'); return `/mapped/${file.replaceAll('\\', '/').split('/').at(-1)}`; };
  const runtime = new ContainerRuntime({ ...config, ...options.config }, runner, { authentication, mapHostPath });
  return { runtime, authentication, calls, events, runner, mapHostPath, leaseController, active: () => active, validateCount: () => validateCount,
    credentials: (value: boolean) => { credentials = value; }, failRemove: (value: boolean) => { failRemove = value; },
    invalidFile: (value: boolean) => { invalidFile = value; } };
}

test('desktop auth is explicit, Docker-only and rejects legacy credentials or an implicit WSL wrapper', () => {
  assert.throws(() => runtimeConfig({ AGENT_AUTH: 'desktop-codex' }));
  assert.throws(() => new ContainerRuntime(config));
  const h = harness(), desktop = { authentication: h.authentication, mapHostPath: h.mapHostPath };
  for (const change of [{ mode: 'kubernetes' }, { wslDistro: 'Ubuntu' }, { workspaceKey: '' }, { image: 'worker:latest' },
    { authFile: 'host-auth' }, { apiKey: 'PRIVATE' }, { authSecret: 'host-secret' }, { auth: 'codex' }]) {
    assert.throws(() => new ContainerRuntime({ ...config, ...change } as RuntimeConfig, h.runner, desktop));
  }
  assert.throws(() => kubernetesResources(config, 'name', {}));
});

test('one auth file bind uses Docker CSV while retaining private homes and sandbox boundaries', () => {
  const binding = { ownerKey, source: '/mnt/c/앱, "test"/auth.json' };
  const args = dockerArguments(config, 'ac-run-a-task', input, false, binding);
  assert.ok(args.includes('type=bind,"source=/mnt/c/앱, ""test""/auth.json",target=/home/node/.codex/auth.json'));
  assert.ok(args.includes('--tmpfs=/home/node/.codex:rw,noexec,nosuid,nodev,size=128m,uid=1000,gid=1000'));
  for (const option of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--log-driver=none']) assert.ok(args.includes(option));
  assert.equal(args.filter(arg => arg === '--mount').length, 1);
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.throws(() => dockerArguments(config, 'name'));
  assert.throws(() => dockerArguments({ ...config, auth: 'none' }, 'name', input, false, binding));
  for (const source of ['relative/auth.json', '/mnt/c/../auth.json', '/mnt/c/auth.json\n', '/mnt/c/auth.json/other', 'C:\\auth.json']) {
    assert.throws(() => dockerArguments(config, 'name', input, false, { ...binding, source }));
  }
});

test('real execute path takes a binding only for the model, cleans the worker before release, then checkpoints', async () => {
  const h = harness(), checkpoints: string[] = [];
  const result = await h.runtime.execute(input, hooks({ onCheckpoint: async value => { checkpoints.push(value.phase); h.events.push('checkpoint'); },
    beforeModelStart: async () => { assert.equal(h.active(), true); h.events.push('budget'); }, assertModelStart: () => { h.events.push('gate'); } }));
  assert.equal(result.result, task.result); assert.equal(h.active(), false); assert.equal(h.validateCount(), 2);
  assert.ok(h.events.indexOf('budget') > h.events.indexOf('acquire'));
  assert.equal(h.events[h.events.indexOf('model') - 1], 'gate');
  assert.ok(h.events.indexOf('remove') < h.events.indexOf('release'));
  assert.ok(h.events.indexOf('release') < h.events.indexOf('checkpoint'));
  assert.deepEqual(checkpoints, ['evaluate', 'evaluate', 'complete']);
  assert.equal(result.learningReview?.status, 'deferred');
  assert.match(result.learningReview!.reason, /구형 실행기/);
});

test('historical worker routing retains the same app credential lease and cleanup order', async () => {
  const sourceHashes = Object.fromEntries(workerSourceFiles.map(name => [name, 'c'.repeat(64)]));
  const old = createWorkerReleaseManifest({ image: config.image, sourceHashes, runtimeBaseHash: 'd'.repeat(64) });
  const modern = createWorkerReleaseManifest({ image: `sha256:${'b'.repeat(64)}`, sourceHashes, runtimeBaseHash: 'e'.repeat(64) });
  const catalog = (item: typeof old) => ({ version: 1 as const, active: { image: item.image, manifestId: item.id }, manifests: [item] });
  const h = harness({ config: { image: modern.image, releaseCatalog: catalog(modern), historicalReleaseCatalogs: [catalog(old)] } });
  const selected = { ...structuredClone(input), run: { ...input.run, runtimeRelease: catalog(old).active } };
  await h.runtime.execute(selected, hooks());
  const model = h.calls.find(call => call.payload?.phase)!;
  assert.equal(model.args.at(-1), old.image);
  assert.equal(model.payload!.authBinding, 'codex-file-v1');
  assert.ok(model.args.includes(`agent-company.credential-owner=${ownerKey}`));
  assert.equal(h.active(), false); assert.ok(h.events.indexOf('remove') < h.events.indexOf('release'));
  assert.deepEqual(h.runtime.defaultReleasePin, catalog(modern).active);
  assert.ok(!JSON.stringify(model.payload).includes('/mnt/c'));
});

test('inspected legacy entry uses one read-only secret file without copying credentials into payload or changing pins', async () => {
  const sourceHashes = Object.fromEntries(workerSourceFiles.map(name => [name, 'c'.repeat(64)]));
  const old = createWorkerReleaseManifest({ image: config.image, sourceHashes: { ...sourceHashes, 'entry.mjs': legacyWorkerEntrySha256[0] }, runtimeBaseHash: 'd'.repeat(64) });
  const modern = createWorkerReleaseManifest({ image: `sha256:${'b'.repeat(64)}`, sourceHashes, runtimeBaseHash: 'e'.repeat(64) });
  const catalog = (item: typeof old) => ({ version: 1 as const, active: { image: item.image, manifestId: item.id }, manifests: [item] });
  const base = { image: modern.image, releaseCatalog: catalog(modern), historicalReleaseCatalogs: [catalog(old)] };
  const options = { ...base, historicalAuthBindings: [{ pin: catalog(old).active, entrySha256: legacyWorkerEntrySha256[0], contract: 'codex-secret-directory-v1' as const }] };
  const selected = { ...structuredClone(input), run: { ...input.run, runtimeRelease: catalog(old).active } };
  const missing = harness({ config: base });
  await assert.rejects(missing.runtime.execute(selected, hooks()), { code: 'RUNTIME_RELEASE_BLOCKED' });
  assert.equal(missing.events.includes('acquire'), false); assert.equal(missing.events.includes('model'), false);
  const h = harness({ config: options });
  await h.runtime.execute(selected, hooks());
  const model = h.calls.find(call => call.payload?.phase)!;
  assert.equal(model.args.at(-1), old.image);
  assert.equal(model.args.filter(arg => arg === '--mount').length, 1);
  assert.ok(model.args.some(arg => arg.startsWith('type=bind,') && arg.endsWith('target=/run/agent-credentials/auth.json,readonly')));
  assert.ok(model.args.includes('--env=AGENT_SECRET_DIR=/run/agent-credentials'));
  assert.ok(!model.args.some(arg => /type=bind,.*target=\/home\/node/.test(arg)));
  assert.equal(Object.hasOwn(model.payload!, 'auth'), false); assert.equal(Object.hasOwn(model.payload!, 'authBinding'), false);
  assert.ok(!JSON.stringify(model.payload).includes('/mnt/c'));
  assert.ok(h.events.indexOf('remove') < h.events.indexOf('release')); assert.equal(h.active(), false);
  assert.deepEqual(h.runtime.defaultReleasePin, catalog(modern).active);
  assert.deepEqual(selected.run.runtimeRelease, catalog(old).active);
  const invalid = harness({ config: options }); invalid.invalidFile(true);
  await assert.rejects(invalid.runtime.execute(selected, hooks()), { code: 'DESKTOP_RUNTIME_AUTH_INVALID' });
  assert.equal(invalid.events.includes('model'), false); assert.equal(invalid.active(), false);
  const cleanup = harness({ config: options }); cleanup.failRemove(true);
  assert.equal((await cleanup.runtime.execute(selected, hooks())).result, task.result, 'received output survives uncertain cleanup');
  assert.equal(cleanup.active(), true, 'the legacy adapter cannot release an uncertain auth writer');
  await assert.rejects(cleanup.runtime.settle(selected.run.id), /정리/);
  cleanup.failRemove(false); await cleanup.runtime.settle(selected.run.id); assert.equal(cleanup.active(), false);
});

test('task, repair, independent trials and evaluation all enter the same binding boundary', async () => {
  const h = harness();
  // Direct phase calls isolate transport contracts from growth quality policy.
  const phase = (h.runtime as unknown as { phase: (phase: ModelPhase, input: ExecutionInput, hooks: ExecutionHooks, extra: object) => Promise<unknown> }).phase.bind(h.runtime);
  for (const selected of ['task', 'repair', 'trial', 'evaluate'] as const) await phase(selected, input, hooks(), {});
  assert.deepEqual(h.calls.filter(call => call.payload).map(call => call.payload!.phase), ['task', 'repair', 'trial', 'evaluate']);
  assert.equal(h.events.filter(value => value === 'acquire').length, 4);
  assert.equal(h.events.filter(value => value === 'release').length, 4);
});

test('budget rejection and a changed auth file after budget persistence never launch a model or strand the lease', async () => {
  const budget = harness();
  await assert.rejects(budget.runtime.execute(input, hooks({ beforeModelStart: async () => { throw new Error('BUDGET_STOP'); } })), /BUDGET_STOP/);
  assert.equal(budget.active(), false); assert.ok(!budget.events.includes('model')); assert.ok(!budget.events.includes('remove'));
  const changed = harness();
  await assert.rejects(changed.runtime.execute(input, hooks({ beforeModelStart: async () => { changed.invalidFile(true); } })), { code: 'DESKTOP_RUNTIME_AUTH_INVALID' });
  assert.equal(changed.active(), false); assert.ok(!changed.events.includes('model'));
});

test('lost auth lease cancels an active command and actual worker cleanup precedes lease release', async () => {
  const started = deferred();
  const h = harness({ model: options => new Promise<void>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_COMMAND_ERROR')), { once: true }); started.resolve();
  }) });
  const executing = h.runtime.execute(input, hooks());
  await started.promise;
  h.leaseController.abort(new Error('LEASE_LOST'));
  await assert.rejects(executing, /LEASE_LOST/);
  assert.ok(h.events.indexOf('remove') < h.events.indexOf('release')); assert.equal(h.active(), false);
});

test('unknown writer cleanup preserves the completed result and blocks new phases until settle succeeds', async () => {
  const h = harness(), events: string[] = [];
  h.failRemove(true);
  const result = await h.runtime.execute(input, hooks({ onEvent: async message => { events.push(message); } }));
  assert.equal(result.result, task.result); assert.equal(h.active(), true);
  const starts = h.events.filter(value => value === 'model').length;
  await assert.rejects(h.runtime.execute({ ...input, run: { ...input.run, id: 'run-b' } }, hooks()), /정리/);
  assert.equal(h.events.filter(value => value === 'model').length, starts);
  await assert.rejects(h.runtime.settle(input.run.id), /정리/);
  assert.equal(h.active(), true); assert.ok(!events.join(' ').includes('PRIVATE'));
  h.failRemove(false); await h.runtime.settle(input.run.id); assert.equal(h.active(), false);
  await h.runtime.execute({ ...input, run: { ...input.run, id: 'run-b' } }, hooks());
  assert.equal(h.events.filter(value => value === 'model').length, starts + 1);
});

test('an invalid auth document after model exit does not discard completed output or expose diagnostics', async () => {
  let h: ReturnType<typeof harness>;
  h = harness({ model: async () => { h.invalidFile(true); } });
  const messages: string[] = [];
  const result = await h.runtime.execute(input, hooks({ onEvent: async message => { messages.push(message); } }));
  assert.equal(result.result, task.result); assert.equal(h.active(), false);
  assert.ok(messages.some(message => message.includes('계정 연결'))); assert.ok(!messages.join(' ').includes('PRIVATE'));
});

test('read-only deployment idle check includes auth state and does not retry cleanup', async () => {
  const h = harness();
  const lease = await h.authentication.acquire(new AbortController().signal);
  await assert.rejects(h.runtime.confirmDeploymentIdle(), /AUTH_BUSY/);
  assert.ok(!h.events.includes('retry-auth')); assert.equal(h.active(), true);
  await lease.release(); await h.runtime.confirmDeploymentIdle();
});

test('workspace restoration shares the installation auth owner and selected host path mapper', async () => {
  const h = harness({ config: { dockerSandbox: 'codex-userns' } });
  const restored = h.runtime.forkWorkspace('restored-generation');
  await restored.execute(input, hooks());
  const args = h.calls.find(call => call.payload)!.args;
  assert.ok(args.includes('agent-company.workspace=restored-generation'));
  assert.ok(args.includes(`agent-company.credential-owner=${ownerKey}`));
  assert.ok(args.includes('--security-opt=seccomp=/mapped/codex-userns.json'));
  assert.equal(h.events.filter(event => event === 'map').length, 1);
});

test('an unconnected desktop has a setup message and never starts a worker', async () => {
  const h = harness(); h.credentials(false);
  const info = await h.runtime.inspect();
  assert.equal(info.available, true); assert.equal(info.authenticated, false); assert.match(info.message, /앱 설정/);
  await assert.rejects(h.runtime.execute(input, hooks()), /앱 설정/); assert.ok(!h.events.includes('acquire'));
});

test('deployment pause during target preparation is preserved at the final process gate without starting a model', async () => {
  const h = harness(); let held = false, actualStarts = 0;
  const wrapper: Command = async (file, args, options) => {
    if (args[0] === 'run') {
      await Promise.resolve(); held = true;
      // Emulates the production target's awaited validation and fixed error boundary.
      try { options!.beforeSpawn!(); }
      catch { throw new Error('DESKTOP_DOCKER_TARGET_FAILED'); }
      actualStarts++;
    }
    return h.runner(file, args, options);
  };
  const driver = new ContainerRuntime(config, wrapper, { authentication: h.authentication, mapHostPath: h.mapHostPath });
  await assert.rejects(driver.execute(input, hooks({ assertModelStart() {
    if (held) throw Object.assign(new Error('DEPLOYMENT_PAUSED'), { code: 'DEPLOYMENT_PAUSED' });
  } })), { code: 'DEPLOYMENT_PAUSED' });
  assert.equal(actualStarts, 0); assert.equal(h.active(), false);
});

test('real auth coordinator serializes concurrent Runs through actual runtime cleanup and cancels queued work without a model attempt', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-bound-runtime-'));
  t.after(async () => {
    const location = relative(tmpdir(), root);
    assert.ok(location.startsWith('ac-bound-runtime-') && !isAbsolute(location) && !location.includes(sep));
    await rm(root, { recursive: true });
  });
  const credentialsRoot = join(root, 'credentials');
  const home = await openDesktopAccountHome(credentialsRoot, ownerKey);
  await writeFile(join(home.directory, 'auth.json'), '{"fixture":"PUBLIC_TEST_ONLY"}'); await home.release();
  const firstStarted = deferred(), firstMayFinish = deferred(), cleanupStarted = deferred(), cleanupMayFinish = deferred();
  const queuedSecond = deferred(), queuedThird = deferred();
  let writer = false, models = 0, requests = 0, queuedAttempts = 0;
  const runner: Command = async (_file, args, options = {}) => {
    if (args[0] === 'version') return { code: 0, stdout: '29.1.3', stderr: '' };
    if (args[0] === 'image') return { code: 0, stdout: config.image, stderr: '' };
    if (args[0] === 'ps') return { code: 0, stdout: writer ? 'a'.repeat(12) : '', stderr: '' };
    if (args[0] === 'volume') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'rm') {
      if (models === 1) { cleanupStarted.resolve(); await cleanupMayFinish.promise; }
      writer = false; return { code: 0, stdout: '', stderr: '' };
    }
    assert.equal(args[0], 'run'); assert.equal(writer, false); writer = true; models++;
    if (models === 1) { firstStarted.resolve(); await firstMayFinish.promise; }
    assert.equal(Object.hasOwn(JSON.parse(options.input!), 'auth'), false);
    await options.onLine?.(JSON.stringify({ type: 'result', result: task }));
    return { code: 0, stdout: '', stderr: '' };
  };
  const target = { command: runner, mapFile: async () => '/fixture/auth.json', mapAuthFile: async () => '/fixture/auth.json' };
  const authentication = new DesktopDockerAuth({ credentialsRoot, workspaceKey: ownerKey, target });
  const binding: RuntimeAuthBinding = { ownerKey,
    hasCredentials: () => authentication.hasCredentials(), assertNoWriters: () => authentication.assertNoWriters(),
    assertIdle: () => authentication.assertIdle(), retryCleanup: () => authentication.retryCleanup(),
    acquire(signal) { requests++; if (requests === 2) queuedSecond.resolve(); if (requests === 3) queuedThird.resolve(); return authentication.acquire(signal); },
  };
  const runtime = new ContainerRuntime(config, runner, { authentication: binding, mapHostPath: target.mapFile });
  const first = runtime.execute(input, hooks());
  await firstStarted.promise;
  const cancelled = new AbortController();
  const second = runtime.execute({ ...input, run: { ...input.run, id: 'run-b' } }, hooks({ signal: cancelled.signal,
    beforeModelStart: async () => { queuedAttempts++; } }));
  const rejected = assert.rejects(second, { code: 'DESKTOP_DOCKER_AUTH_ABORTED' });
  await queuedSecond.promise; cancelled.abort(); await rejected;
  assert.equal(queuedAttempts, 0); assert.equal(models, 1);
  const third = runtime.execute({ ...input, run: { ...input.run, id: 'run-c' } }, hooks());
  await queuedThird.promise;
  firstMayFinish.resolve(); await cleanupStarted.promise;
  assert.equal(models, 1);
  await assert.rejects(openDesktopAccountHome(credentialsRoot, ownerKey), { code: 'ELOCKED' });
  cleanupMayFinish.resolve();
  assert.equal((await first).result, task.result); assert.equal((await third).result, task.result);
  assert.equal(models, 2); await authentication.assertIdle();
});
