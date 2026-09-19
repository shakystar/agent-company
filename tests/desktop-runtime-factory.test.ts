import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { desktopPaths } from '../server/desktop-paths.ts';
import { createDesktopRuntimeContext, probeDesktopRuntimeSelection, type DesktopRuntimeFactoryDependencies } from '../server/desktop-runtime-factory.ts';
import { createWorkerReleaseManifest, workerSourceFiles, legacyWorkerEntrySha256 } from '../shared/runtime-releases.ts';
import type { DesktopWorkerProvider } from '../server/desktop-worker-provider.ts';
import type { CommandOptions } from '../server/process.ts';
import { openDesktopAccountHome } from '../server/desktop-account-home.ts';
import { desktopRuntimeSettings } from '../server/desktop-runtime-settings.ts';

const image = `sha256:${'a'.repeat(64)}`;
const manifest = createWorkerReleaseManifest({ image, runtimeBaseHash: 'b'.repeat(64),
  sourceHashes: Object.fromEntries(workerSourceFiles.map(file => [file, 'c'.repeat(64)])) });
const provider: DesktopWorkerProvider = { codexVersion: '0.154.0', engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
  releaseCatalog: { version: 1, active: { image, manifestId: manifest.id }, manifests: [manifest] } };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-factory-'));
  t.after(async () => { const location = relative(tmpdir(), root);
    assert.ok(location.startsWith('ac-desktop-factory-') && !isAbsolute(location) && !location.includes(sep)); await rm(root, { recursive: true }); });
  const paths = desktopPaths(join(root, 'resources'), join(root, '사용자 데이터'));
  await mkdir(paths.appDataRoot);
  const calls: string[][] = [], targets: Array<{ wslExecutable: string; distro: string; dockerConfigDir: string }> = [];
  const mapped: string[] = [];
  let engine = '29.1.3/amd64', availableImage = image, failTarget = false, writer = false;
  const dependencies: DesktopRuntimeFactoryDependencies = {
    resolveAccount: async () => ({ executable: join(paths.resourceRoot, 'providers/codex/codex.exe'), version: '0.154.0', sha256: 'd'.repeat(64) }),
    resolveWorker: async () => structuredClone(provider),
    createTarget: async targetOptions => {
      targets.push(targetOptions); if (failTarget) throw new Error('PRIVATE_TARGET_FAILURE');
      return { command: async (file: string, args: string[], options?: CommandOptions) => {
        assert.equal(file, 'docker'); calls.push(args); options?.signal?.throwIfAborted();
        if (args[0] === 'version') return { code: 0, stdout: args[2].includes('Arch') ? engine : engine.split('/')[0], stderr: '' };
        if (args[0] === 'image') return { code: 0, stdout: availableImage, stderr: '' };
        if (args[0] === 'ps') return { code: 0, stdout: writer ? `${'a'.repeat(12)}\n` : '', stderr: '' };
        throw new Error('unexpected process');
      }, mapFile: async file => { mapped.push(file); return `/fixture/${file.split(/[\\/]/).at(-1)}`; }, mapAuthFile: async () => '/fixture/auth.json' };
    },
  };
  const options = { paths, ownerKey: randomUUID(), workspaceKey: randomUUID(),
    selection: { kind: 'wsl-docker' as const, wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu-22.04', model: 'selected-model' } };
  return { options, dependencies, calls, targets, mapped, engine: (value: string) => { engine = value; },
    image: (value: string) => { availableImage = value; }, failTarget: (value: boolean) => { failTarget = value; },
    writer: (value: boolean) => { writer = value; } };
}
test('explicit desktop context uses only bundled providers and defers WSL until inspection/probe', async t => {
  const f = await fixture(t), context = await createDesktopRuntimeContext(f.options, f.dependencies);
  assert.equal(f.targets.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(context.runtime.config.workspaceKey, f.options.workspaceKey);
  assert.equal(context.authentication.ownerKey, f.options.ownerKey);
  assert.equal(context.runtime.config.authFile, ''); assert.equal(context.runtime.config.apiKey, undefined);
  assert.equal(context.runtime.config.wslDistro, undefined); assert.equal(context.runtime.config.auth, 'desktop-codex');
  assert.deepEqual(context.runtime.defaultReleasePin, provider.releaseCatalog.active);
  const result = await context.probe(new AbortController().signal);
  assert.equal(result.image, image); assert.equal(result.credentialsPresent, false);
  assert.deepEqual(f.targets, [{ wslExecutable: f.options.selection.wslExecutable, distro: 'Ubuntu-22.04', dockerConfigDir: join(f.options.paths.appDataRoot, 'runtime', 'docker') }]);
  assert.ok(f.calls.every(args => ['version', 'image', 'ps'].includes(args[0])));
  assert.ok(f.calls.some(args => args.includes(`label=agent-company.credential-owner=${f.options.ownerKey}`)));
});
test('missing/invalid providers and altered private paths do not construct an execution target', async t => {
  const f = await fixture(t);
  await assert.rejects(createDesktopRuntimeContext(f.options, { ...f.dependencies, resolveWorker: async () => null }), { code: 'DESKTOP_RUNTIME_PROVIDER_MISSING' });
  await assert.rejects(createDesktopRuntimeContext(f.options, { ...f.dependencies, resolveAccount: async () => { throw new Error('PRIVATE'); } }), { code: 'DESKTOP_RUNTIME_PROVIDER_INVALID' });
  await assert.rejects(createDesktopRuntimeContext({ ...f.options, paths: { ...f.options.paths, credentialsDir: join(tmpdir(), 'unrelated') } }, f.dependencies), { code: 'DESKTOP_RUNTIME_SELECTION_INVALID' });
  assert.equal(f.targets.length, 0);
});

test('trusted history preserves the bundled 0.154 provider, selected target and installation auth owner', async t => {
  const f = await fixture(t);
  const previous = createWorkerReleaseManifest({ image: `sha256:${'e'.repeat(64)}`, runtimeBaseHash: 'f'.repeat(64), sourceHashes: manifest.sourceHashes });
  const history = { version: 1 as const, active: { image: previous.image, manifestId: previous.id }, manifests: [previous] };
  const context = await createDesktopRuntimeContext({ ...f.options, historicalReleaseCatalogs: [history] }, f.dependencies);
  assert.equal(context.accountProvider.version, '0.154.0'); assert.deepEqual(context.runtime.defaultReleasePin, provider.releaseCatalog.active);
  assert.deepEqual(context.runtime.selectReleasePinForEnvironment(previous.image), history.active);
  const fork = context.runtime.forkWorkspace(randomUUID());
  assert.deepEqual(fork.defaultReleasePin, provider.releaseCatalog.active);
  assert.deepEqual(fork.selectReleasePinForEnvironment(previous.image), history.active);
  assert.equal(context.authentication.ownerKey, f.options.ownerKey);
  assert.equal(f.calls.length, 0, 'history validation starts no Docker/auth/model processes');
  history.manifests[0].runtimeBaseHash = '0'.repeat(64);
  assert.deepEqual(context.runtime.selectReleasePinForEnvironment(previous.image), { image: previous.image, manifestId: previous.id }, 'caller mutation cannot alter the validated runtime');
  await assert.rejects(createDesktopRuntimeContext({ ...f.options, historicalReleaseCatalogs: [history] }, f.dependencies), { code: 'DESKTOP_RUNTIME_PROVIDER_INVALID' });
  assert.equal(f.calls.length, 0);
});

test('desktop factory accepts an exact private legacy binding and rejects evidence before opening a target', async t => {
  const f = await fixture(t), entrySha256 = legacyWorkerEntrySha256[1];
  const legacy = createWorkerReleaseManifest({ image: `sha256:${'e'.repeat(64)}`, runtimeBaseHash: 'f'.repeat(64), sourceHashes: { ...manifest.sourceHashes, 'entry.mjs': entrySha256 } });
  const history = { version: 1 as const, active: { image: legacy.image, manifestId: legacy.id }, manifests: [legacy] };
  const binding = { pin: history.active, contract: 'codex-secret-directory-v1' as const, entrySha256 };
  const context = await createDesktopRuntimeContext({ ...f.options, historicalReleaseCatalogs: [history], historicalAuthBindings: [binding] }, f.dependencies);
  assert.deepEqual(context.runtime.config.historicalAuthBindings, [binding]);
  assert.deepEqual(context.runtime.forkWorkspace(randomUUID()).config.historicalAuthBindings, [binding]);
  assert.equal(context.accountProvider.version, '0.154.0');
  await assert.rejects(createDesktopRuntimeContext({ ...f.options, historicalReleaseCatalogs: [history], historicalAuthBindings: [{ ...binding, entrySha256: legacyWorkerEntrySha256[0] }] }, f.dependencies), { code: 'DESKTOP_RUNTIME_PROVIDER_INVALID' });
  await assert.rejects(createDesktopRuntimeContext({ ...f.options, historicalAuthBindings: [binding] }, f.dependencies), { code: 'DESKTOP_RUNTIME_PROVIDER_INVALID' });
  assert.equal(f.targets.length, 0); assert.equal(f.calls.length, 0);
});
test('failed target startup retries the same explicit selection and never falls back to host Docker', async t => {
  const f = await fixture(t), context = await createDesktopRuntimeContext(f.options, f.dependencies);
  f.failTarget(true); await assert.rejects(context.probe(new AbortController().signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  f.failTarget(false); await context.probe(new AbortController().signal);
  assert.equal(f.targets.length, 2); assert.deepEqual(f.targets[0], f.targets[1]);
});
test('changed engine/image and cancellation fail probe without model calls', async t => {
  const f = await fixture(t), context = await createDesktopRuntimeContext(f.options, f.dependencies);
  f.engine('30.0.0/amd64'); await assert.rejects(context.probe(new AbortController().signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  f.engine('29.1.3/arm64'); await assert.rejects(context.probe(new AbortController().signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  f.engine('29.1.3/amd64'); f.image(`sha256:${'e'.repeat(64)}`);
  await assert.rejects(context.probe(new AbortController().signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  const controller = new AbortController(); controller.abort(); const before = f.calls.length;
  await assert.rejects(context.probe(controller.signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' }); assert.equal(f.calls.length, before);
  assert.ok(!f.calls.some(args => ['run', 'pull', 'build', 'rm'].includes(args[0])));
});

test('probe rejects a missing selected browser image, account admission and pending credential cleanup', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const browser = await createDesktopRuntimeContext(f.options, { ...f.dependencies,
    resolveWorker: async () => ({ ...structuredClone(provider), browserImage: `sha256:${'e'.repeat(64)}` }) });
  await assert.rejects(browser.probe(signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  const context = await createDesktopRuntimeContext(f.options, f.dependencies);
  const home = await openDesktopAccountHome(f.options.paths.credentialsDir, f.options.ownerKey);
  await writeFile(join(home.directory, 'auth.json'), '{}'); await home.release();
  assert.equal((await context.probe(signal)).credentialsPresent, true);
  const releaseAccount = context.authentication.admitAccount();
  await assert.rejects(context.probe(signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' }); releaseAccount();
  const lease = await context.authentication.acquire(signal); f.writer(true);
  await assert.rejects(lease.release(), { code: 'DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE' });
  f.writer(false); await assert.rejects(context.probe(signal), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  await context.authentication.retryCleanup(); assert.equal((await context.probe(signal)).credentialsPresent, true);
  assert.ok(!f.calls.some(args => ['run', 'pull', 'build', 'rm'].includes(args[0])));
});

test('runtime and restored generations map the selected package security resource instead of the development repository', async t => {
  const f = await fixture(t), profile = join(f.options.paths.resourceRoot, 'worker', 'security', 'codex-userns.json');
  await mkdir(join(f.options.paths.resourceRoot, 'worker', 'security'), { recursive: true }); await writeFile(profile, '{}');
  const context = await createDesktopRuntimeContext(f.options, f.dependencies);
  for (const runtime of [context.runtime, context.runtime.forkWorkspace(randomUUID())]) {
    const value = await (runtime as unknown as { dockerWorkerConfig(): Promise<{ seccompProfile: string }> }).dockerWorkerConfig();
    assert.equal(value.seccompProfile, '/fixture/codex-userns.json');
  }
  assert.deepEqual(f.mapped, [profile, profile]);
  assert.ok(!f.calls.some(args => args[0] === 'run'));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function installation(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(f.options.paths.appDataRoot, 'desktop-installation.json'), JSON.stringify({
    version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: f.options.ownerKey,
  }));
  return desktopRuntimeSettings(f.options.paths.appDataRoot, f.options.ownerKey);
}
async function unchangedActivePaths(f: Awaited<ReturnType<typeof fixture>>) {
  const names = await readdir(f.options.paths.appDataRoot);
  for (const name of ['runtime', 'desktop-runtime.json', 'desktop-runtime-configured.json']) assert.ok(!names.includes(name), name);
}
function materializedProbeTarget(f: Awaited<ReturnType<typeof fixture>>): DesktopRuntimeFactoryDependencies {
  return { ...f.dependencies, createTarget: async options => {
    await mkdir(options.dockerConfigDir, { recursive: true });
    const identity = JSON.stringify({ wslExecutable: options.wslExecutable, distro: options.distro });
    const marker = join(options.dockerConfigDir, 'fixture-target.json');
    if (!(await readdir(options.dockerConfigDir)).length) await writeFile(marker, identity, { flag: 'wx' });
    else assert.equal(await readFile(marker, 'utf8'), identity);
    return f.dependencies.createTarget(options);
  } };
}

test('standalone probe returns only presence values and reuses a private folder per normalized target', async t => {
  const f = await fixture(t), store = await installation(f), dependencies = materializedProbeTarget(f);
  const result = await probeDesktopRuntimeSelection(f.options, dependencies);
  assert.deepEqual(result, { engine: '29.1.3', arch: 'amd64', image, browserImage: null, model: 'selected-model', credentialsPresent: false });
  assert.ok(Object.values(result).every(value => typeof value !== 'object' || value === null));
  const selected = f.targets[0].dockerConfigDir;
  assert.equal(relative(join(f.options.paths.appDataRoot, 'setup-probes', 'docker'), selected).length, 64);
  assert.match(selected.split(sep).at(-1)!, /^[a-f0-9]{64}$/);
  await probeDesktopRuntimeSelection({ ...f.options, selection: { ...f.options.selection,
    model: 'another-model', wslExecutable: 'c:/Windows/System32/wsl.exe' } }, dependencies);
  assert.equal(f.targets[1].dockerConfigDir, selected);
  await probeDesktopRuntimeSelection({ ...f.options, selection: { ...f.options.selection, distro: 'Other' } }, dependencies);
  await probeDesktopRuntimeSelection({ ...f.options, selection: { ...f.options.selection, wslExecutable: 'C:\\Other\\wsl.exe' } }, dependencies);
  assert.equal(new Set(f.targets.map(item => item.dockerConfigDir)).size, 3);
  await unchangedActivePaths(f); assert.deepEqual(await store.read(), { revision: 0, selection: null });
  assert.ok(f.calls.every(args => ['version', 'image', 'ps'].includes(args[0])));
  assert.ok(f.calls.some(args => args.includes(`label=agent-company.credential-owner=${f.options.ownerKey}`)));
});

test('failed initial target and engine probes leave active configuration fresh and their private metadata reusable', async t => {
  const f = await fixture(t), store = await installation(f), dependencies = materializedProbeTarget(f);
  f.failTarget(true);
  await assert.rejects(probeDesktopRuntimeSelection(f.options, dependencies), { code: 'DESKTOP_RUNTIME_PROBE_FAILED', message: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  const target = f.targets[0].dockerConfigDir; await unchangedActivePaths(f);
  assert.deepEqual(await store.read(), { revision: 0, selection: null });
  f.failTarget(false); f.engine('29.1.3/arm64');
  await assert.rejects(probeDesktopRuntimeSelection(f.options, dependencies), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  assert.equal(f.targets[1].dockerConfigDir, target);
  await unchangedActivePaths(f); assert.deepEqual(await store.read(), { revision: 0, selection: null });
  f.engine('29.1.3/amd64'); await probeDesktopRuntimeSelection(f.options, dependencies);
  assert.equal(f.targets[2].dockerConfigDir, target);
});

test('standalone probe validates private paths, owner and bundled providers before creating its target', async t => {
  const f = await fixture(t);
  for (const options of [{ ...f.options, ownerKey: 'not-a-uuid' }, { ...f.options, workspaceKey: 'not-a-uuid' },
    { ...f.options, paths: { ...f.options.paths, credentialsDir: join(tmpdir(), 'unrelated') } }]) {
    await assert.rejects(probeDesktopRuntimeSelection(options, f.dependencies), { code: 'DESKTOP_RUNTIME_SELECTION_INVALID' });
  }
  await assert.rejects(probeDesktopRuntimeSelection(f.options, { ...f.dependencies, resolveWorker: async () => null }), { code: 'DESKTOP_RUNTIME_PROVIDER_MISSING' });
  await assert.rejects(probeDesktopRuntimeSelection(f.options, { ...f.dependencies, resolveAccount: async () => { throw new Error('PRIVATE_PROVIDER'); } }),
    { code: 'DESKTOP_RUNTIME_PROVIDER_INVALID', message: 'DESKTOP_RUNTIME_PROVIDER_INVALID' });
  assert.equal(f.targets.length, 0); assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.options.paths.appDataRoot), []);
});

test('standalone probe checks selected browser image, actual writer absence and owned credential presence only', async t => {
  const f = await fixture(t), dependencies = materializedProbeTarget(f);
  await assert.rejects(probeDesktopRuntimeSelection(f.options, { ...dependencies,
    resolveWorker: async () => ({ ...structuredClone(provider), browserImage: `sha256:${'e'.repeat(64)}` }) }), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  f.writer(true); await assert.rejects(probeDesktopRuntimeSelection(f.options, dependencies), { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  f.writer(false);
  const home = await openDesktopAccountHome(f.options.paths.credentialsDir, f.options.ownerKey);
  const auth = join(home.directory, 'auth.json'); await writeFile(auth, 'PUBLIC_FIXTURE_NOT_AN_AUTHENTICATED_KEY'); await home.release();
  assert.equal((await probeDesktopRuntimeSelection(f.options, dependencies)).credentialsPresent, true);
  assert.equal(await readFile(auth, 'utf8'), 'PUBLIC_FIXTURE_NOT_AN_AUTHENTICATED_KEY');
  await unchangedActivePaths(f);
  assert.ok(f.calls.every(args => ['version', 'image', 'ps'].includes(args[0])));
});

test('pre-aborted standalone probe starts no provider or target operation', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(new Error('PRIVATE_ABORT'));
  let providerCalls = 0;
  await assert.rejects(probeDesktopRuntimeSelection({ ...f.options, signal: controller.signal }, { ...f.dependencies,
    resolveWorker: async () => { providerCalls++; return provider; } }), { code: 'DESKTOP_RUNTIME_PROBE_FAILED', message: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  assert.equal(providerCalls, 0); assert.equal(f.targets.length, 0); await unchangedActivePaths(f);
});

test('standalone cancellation during target initialization awaits command cleanup and starts no Docker query', { timeout: 3000 }, async t => {
  const f = await fixture(t), controller = new AbortController(), entered = deferred(), aborted = deferred(), cleaned = deferred();
  let settled = false;
  const pending = probeDesktopRuntimeSelection({ ...f.options, signal: controller.signal }, { ...f.dependencies,
    createTarget: async options => {
      assert.ok(options.runner);
      await options.runner('fixture-wsl.exe', ['--list', '--quiet'], { timeoutMs: 15_000 });
      return f.dependencies.createTarget(options);
    }, probeCommand: async (_file, _args, options) => {
      assert.equal(options?.timeoutMs, 15_000); assert.ok(options.signal); options.beforeSpawn?.();
      options.signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve();
      await aborted.promise; await cleaned.promise; throw new Error('PRIVATE_COMMAND_CANCELED');
    },
  }).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, { code: 'DESKTOP_RUNTIME_PROBE_FAILED', message: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  await entered.promise; controller.abort(); await aborted.promise; await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.calls.length, 0);
  cleaned.resolve(); await rejected; assert.equal(settled, true); await unchangedActivePaths(f);
});

test('standalone deadline reaches writer query and settles only after its command cleanup', { timeout: 3000 }, async t => {
  const f = await fixture(t), entered = deferred(), aborted = deferred(), cleaned = deferred();
  // The caller may supply a shorter deadline than the fixed 120-second overall cap.
  const controller = new AbortController(); let settled = false;
  const pending = probeDesktopRuntimeSelection({ ...f.options, signal: controller.signal }, { ...f.dependencies,
    createTarget: async options => {
      const target = await f.dependencies.createTarget(options);
      return { ...target, command: async (file, args, commandOptions) => {
        if (args[0] !== 'ps') { assert.equal(commandOptions?.timeoutMs, 30_000); return target.command(file, args, commandOptions); }
        assert.equal(commandOptions?.timeoutMs, 15_000); assert.ok(commandOptions.signal); commandOptions.beforeSpawn?.();
        commandOptions.signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve();
        await aborted.promise; await cleaned.promise; return { code: 0, stdout: '', stderr: '' };
      } };
    },
  }).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, { code: 'DESKTOP_RUNTIME_PROBE_FAILED' });
  await entered.promise;
  const deadline = setTimeout(() => controller.abort(new DOMException('fixture deadline', 'TimeoutError')), 10);
  await aborted.promise; clearTimeout(deadline); await Promise.resolve(); assert.equal(settled, false);
  cleaned.resolve(); await rejected; await unchangedActivePaths(f);
});
