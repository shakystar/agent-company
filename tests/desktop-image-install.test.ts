import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hasUnfinishedDesktopImageInstall, installDesktopRuntimeImages, inspectDesktopImageRecovery, recoverDesktopRuntimeImages } from '../server/desktop-image-install.ts';
import { createDesktopImageJournal } from '../server/desktop-image-journal.ts';
import { resolveDesktopRuntimeSelection, type DesktopRuntimeFactoryDependencies } from '../server/desktop-runtime-factory.ts';
import { desktopPaths } from '../server/desktop-paths.ts';
import { createWorkerReleaseManifest, workerSourceFiles } from '../shared/runtime-releases.ts';
import type { DesktopWorkerProvider } from '../server/desktop-worker-provider.ts';
import type { DesktopRuntimeInstallProgress } from '../shared/desktop-runtime-setup.ts';
import type { VerifiedDesktopImageArchive } from '../server/desktop-image-archive.ts';
import type { DesktopDistributedImage } from '../shared/desktop-worker-images.ts';

const image = `sha256:${'a'.repeat(64)}`, browserImage = `sha256:${'b'.repeat(64)}`;
const manifest = createWorkerReleaseManifest({ image, runtimeBaseHash: 'c'.repeat(64),
  sourceHashes: Object.fromEntries(workerSourceFiles.map(file => [file, 'd'.repeat(64)])) });
const baseProvider: DesktopWorkerProvider = { codexVersion: '0.154.0', engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
  releaseCatalog: { version: 1, active: { image, manifestId: manifest.id }, manifests: [manifest] } };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('registry package pulls missing immutable references and keeps installed images reusable without archive reads', async t => {
  const f = await fixture(t, true, true); f.available.add(image);
  await f.run(); assert.deepEqual(f.verified, []); assert.deepEqual(f.streamed, []);
  assert.equal(f.calls.filter(args => args[1] === 'pull').length, 1);
  assert.match(f.calls.find(args => args[1] === 'pull')![4], /agent-company-browser@sha256:/);
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
  assert.ok(f.progress.some(value => value.stage === 'downloading' && value.completed === 1));
  f.calls.length = 0; await f.run(); assert.equal(f.calls.some(args => args[1] === 'pull'), false);
});

test('registry pull failure retains the journal and same-scope recovery replays and verifies the digest', async t => {
  const f = await fixture(t, false, true); f.loadCode = 1;
  await assert.rejects(f.run(), /DESKTOP_RUNTIME_INSTALL_UNCERTAIN/);
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), true);
  f.loadCode = 0; const info = await f.inspect(); const recovered = await f.recover(info); await recovered.finish();
  assert.equal(f.calls.filter(args => args[1] === 'pull').length, 2);
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
});

test('registry cancellation waits for daemon completion and rejects wrong repository or changed image identity', async t => {
  const f = await fixture(t, false, true), gate = deferred(); f.loadGate = gate.promise;
  const running = f.run(); await f.entered.promise; f.controller.abort();
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), true);
  gate.resolve(); await assert.rejects(running);
  assert.ok(f.available.has(image)); assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
  const wrong = await fixture(t, false, true); wrong.unpackFailure = true;
  await assert.rejects(wrong.run(), /DESKTOP_RUNTIME_INSTALL_UNCERTAIN/);
  assert.equal(await hasUnfinishedDesktopImageInstall(wrong.paths.appDataRoot), true);
});

test('registry installation rejects insufficient capacity and incompatible image stores before pull', async t => {
  const f = await fixture(t, false, true); f.free = 20n * 1024n ** 3n;
  await assert.rejects(f.run(), /DESKTOP_RUNTIME_INSTALL_SPACE/); assert.equal(f.calls.some(args => args[1] === 'pull'), false);
  f.free = 100n * 1024n ** 3n; f.driver = [];
  await assert.rejects(f.run(), /DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE/); assert.equal(f.calls.some(args => args[1] === 'pull'), false);
});

async function fixture(t: test.TestContext, browser = false, registry = false) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-image-install-'));
  t.after(async () => { const part = relative(tmpdir(), root);
    assert.ok(part.startsWith('ac-desktop-image-install-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true }); });
  const paths = desktopPaths(join(root, 'resources'), join(root, 'appdata'));
  await mkdir(paths.resourceRoot); await mkdir(paths.appDataRoot);
  const controller = new AbortController(), progress: DesktopRuntimeInstallProgress[] = [];
  const options = { paths, ownerKey: randomUUID(), workspaceKey: randomUUID(), signal: controller.signal,
    selection: { kind: 'wsl-docker' as const, wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Fixture-Distro', model: 'fixture-model' },
    onProgress: (value: DesktopRuntimeInstallProgress) => { progress.push(value); } };
  const provider = { ...structuredClone(baseProvider), ...(browser ? { browserImage } : {}) };
  const archiveImages = [{ kind: 'worker' as const, file: 'worker.tar' as const, image, bytes: 4096, sha256: 'e'.repeat(64) },
    ...(browser ? [{ kind: 'browser' as const, file: 'browser.tar' as const, image: browserImage, bytes: 4096, sha256: 'f'.repeat(64) }] : [])];
  const images: DesktopDistributedImage[] = registry ? archiveImages.map(item => ({ kind: item.kind, image: item.image,
    reference: `docker.io/fixture/agent-company-${item.kind}@${item.image}`, imageIdentity: 'manifest', downloadBytes: 4096, layerBytes: 2048 })) : archiveImages;
  const calls: string[][] = [], verified: string[] = [], closed: string[] = [], streamed: string[] = [];
  const available = new Set<string>(), capacities: string[] = [];
  let engine = '29.1.3/amd64', driver: unknown = registry ? [['driver-type', 'io.containerd.snapshotter.v1']] : [], identity: VerifiedDesktopImageArchive['imageIdentity'] = 'config';
  let archiveFailure = '', inspectFailure = '', targetCount = 0, changing = false, checks = 0, closeFailure = false;
  let free = 100n * 1024n ** 3n, loadCode = 0, loadTransport = false, postInspectFailure = false, unpackFailure = false;
  let loadGate: Promise<void> | undefined, verifyHook = async () => {}, beforeLoad = () => {};
  const entered = deferred();
  const runtimeDependencies: DesktopRuntimeFactoryDependencies = {
    resolveAccount: async () => ({ executable: join(paths.resourceRoot, 'providers/codex/codex.exe'), version: '0.154.0', sha256: '0'.repeat(64) }),
    resolveWorker: async () => provider,
    createTarget: async targetOptions => {
      targetCount++; assert.equal(targetOptions.distro, options.selection.distro);
      assert.equal(targetOptions.wslExecutable, options.selection.wslExecutable);
      assert.ok(targetOptions.dockerConfigDir.startsWith(join(paths.appDataRoot, 'setup-images', 'docker')));
      return { mapFile: async () => { throw new Error('Installer must stream the checked descriptor'); },
        mapAuthFile: async () => { throw new Error('Installer must not read credentials'); },
        command: async (file, args, config = {}) => {
          assert.equal(file, 'docker'); calls.push(args); config.signal?.throwIfAborted();
          const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
          if (args[0] === 'version') return ok(engine);
          if (args[0] === 'info') return ok(JSON.stringify(driver));
          if (args[0] === 'image' && args[1] === 'inspect') {
            if (inspectFailure) return { code: 1, stdout: '', stderr: inspectFailure };
            const entry = images.find(item => 'reference' in item && item.reference === args[2]);
            if (entry && 'reference' in entry && available.has(entry.image)) return ok(JSON.stringify({
              Id: postInspectFailure ? browserImage : entry.image, Os: 'linux', Architecture: 'amd64',
              RepoDigests: [unpackFailure ? `fixture/wrong@${entry.image}` : entry.reference.replace('docker.io/', '')] }));
            if (available.has(args[2])) return ok(JSON.stringify({ Id: postInspectFailure ? browserImage : args[2], Os: 'linux', Architecture: 'amd64' }));
            return { code: 1, stdout: '', stderr: `Error response from daemon: No such image: ${args[2]}\n` };
          }
          if (args[0] === 'image' && args[1] === 'pull') {
            const entry = images.find(item => 'reference' in item && item.reference === args[4]);
            assert.ok(entry && 'reference' in entry);
            assert.deepEqual(args, ['image', 'pull', '--platform=linux/amd64', '--quiet', entry.reference]);
            assert.equal(await hasUnfinishedDesktopImageInstall(paths.appDataRoot), true);
            beforeLoad(); config.beforeSpawn?.(); assert.equal(config.signal, undefined); assert.equal(config.inputStream, undefined);
            entered.resolve(); await loadGate;
            if (loadTransport) throw new Error('PRIVATE_REGISTRY_TRANSPORT');
            if (loadCode === 0) available.add(entry.image);
            return { code: loadCode, stdout: entry.image, stderr: loadCode ? 'PRIVATE_REGISTRY_ERROR' : '' };
          }
          assert.deepEqual(args, ['image', 'load', '--platform=linux/amd64', '--quiet']);
          assert.equal(await hasUnfinishedDesktopImageInstall(paths.appDataRoot), true);
          beforeLoad(); config.beforeSpawn?.();
          assert.equal(config.signal, undefined, 'A submitted daemon operation must not be detached by user cancellation');
          assert.ok(config.inputStream); assert.equal(config.captureStdout, false);
          for await (const chunk of config.inputStream!) {
            const current = Buffer.from(chunk).toString(); streamed.push(current);
          }
          entered.resolve(); await loadGate;
          if (loadTransport) throw new Error('PRIVATE_TRANSPORT_DETAIL');
          if (loadCode === 0) available.add(streamed.at(-1)!);
          await config.onLine?.(`Loaded image ID: ${streamed.at(-1)}`);
          if (unpackFailure) await config.onLine?.('Error unpacking image: PRIVATE_DISK_FAILURE');
          return { code: loadCode, stdout: '', stderr: loadCode ? 'PRIVATE_LOAD_DETAIL' : '' };
        } };
    },
  };
  const dependencies: NonNullable<Parameters<typeof installDesktopRuntimeImages>[1]> = {
    resolveRuntime: value => resolveDesktopRuntimeSelection(value, runtimeDependencies),
    readPackage: async () => ({ provider, directory: join(paths.resourceRoot, 'runtimes', 'codex'), images,
      assertUnchanged: async () => { checks++; if (changing) throw new Error('PRIVATE_CHANGED_RESOURCE'); } }),
    verifyArchive: async (_path, pin, signal) => {
      signal?.throwIfAborted(); await verifyHook(); signal?.throwIfAborted();
      if (archiveFailure === pin.image) throw new Error('PRIVATE_ARCHIVE_DETAIL');
      verified.push(pin.image);
      return { image: pin.image, imageIdentity: identity, configDigest: image, manifestDigest: browserImage,
        format: identity === 'config' ? 'docker29-classic' : 'docker29-oci', archiveBytes: 4096, layerBytes: 2048, layerFileBytes: 100, layerCount: 1,
        async *chunks() { yield Buffer.from(pin.image); },
        async close() { closed.push(pin.image); if (closeFailure) throw new Error('PRIVATE_CLOSE_DETAIL'); } };
    },
    freeBytes: async path => { capacities.push(path); return free; },
  };
  return { paths, controller, progress, options, dependencies, calls, verified, closed, streamed, available, entered, capacities,
    pending: (images: string[] = [image]) => createDesktopImageJournal(paths.appDataRoot, options.ownerKey, options.selection, images),
    inspect: () => inspectDesktopImageRecovery(options, dependencies),
    recover: (info: Parameters<typeof recoverDesktopRuntimeImages>[0]['info']) => recoverDesktopRuntimeImages({ ...options, info }, dependencies),
    run: () => installDesktopRuntimeImages(options, dependencies), get targetCount() { return targetCount; }, get checks() { return checks; },
    set engine(value: string) { engine = value; }, set driver(value: unknown) { driver = value; }, set identity(value: typeof identity) { identity = value; },
    set archiveFailure(value: string) { archiveFailure = value; }, set inspectFailure(value: string) { inspectFailure = value; },
    set free(value: bigint) { free = value; }, set loadCode(value: number) { loadCode = value; }, set loadTransport(value: boolean) { loadTransport = value; },
    set loadGate(value: Promise<void>) { loadGate = value; }, set verifyHook(value: typeof verifyHook) { verifyHook = value; },
    set changing(value: boolean) { changing = value; }, set beforeLoad(value: typeof beforeLoad) { beforeLoad = value; },
    set postInspectFailure(value: boolean) { postInspectFailure = value; }, set closeFailure(value: boolean) { closeFailure = value; },
    set unpackFailure(value: boolean) { unpackFailure = value; } };
}

test('installer verifies every archive before mutation, streams exact descriptors and preserves existing immutable images', async t => {
  const f = await fixture(t, true); f.available.add(browserImage); await f.run();
  assert.deepEqual(f.verified, [image, browserImage]); assert.deepEqual(f.closed, [image, browserImage]);
  assert.deepEqual(f.streamed, [image]); assert.equal(f.available.size, 2);
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
  assert.ok(f.calls.every(args => ['version', 'info', 'image'].includes(args[0])));
  assert.ok(f.calls.every(args => !args.some(value => ['pull', 'tag', 'rm', 'run', 'login', 'system', 'prune'].includes(value))));
  assert.equal(f.checks, 3); assert.ok(f.capacities.includes('C:\\'));
  assert.deepEqual(f.progress.at(-1), { stage: 'loading', completed: 1, total: 1 });
});

test('corrupt secondary archives prevent all Docker discovery and release earlier descriptors', async t => {
  const f = await fixture(t, true); f.archiveFailure = browserImage;
  await assert.rejects(f.run(), { code: 'DESKTOP_RUNTIME_INSTALL_FAILED' });
  assert.equal(f.targetCount, 0); assert.deepEqual(f.closed, [image]); assert.equal(f.streamed.length, 0);
});

test('cancelled verification stops without acquiring a target or publishing a marker', async t => {
  const f = await fixture(t); f.verifyHook = async () => { f.controller.abort(); };
  await assert.rejects(f.run()); assert.equal(f.targetCount, 0);
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
});

test('wrong engine, daemon errors and limited host capacity stop before any import', async t => {
  for (const scenario of ['engine', 'daemon', 'capacity']) await t.test(scenario, async sub => {
    const f = await fixture(sub);
    if (scenario === 'engine') f.engine = '29.1.3/arm64';
    if (scenario === 'daemon') f.inspectFailure = 'PRIVATE_DAEMON_UNAVAILABLE';
    if (scenario === 'capacity') f.free = 20n * 1024n ** 3n;
    await assert.rejects(f.run(), { code: scenario === 'capacity' ? 'DESKTOP_RUNTIME_INSTALL_SPACE' : 'DESKTOP_RUNTIME_INSTALL_FAILED' });
    assert.equal(f.streamed.length, 0); assert.deepEqual(f.closed, [image]);
    assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
  });
});

test('already-installed exact images can be confirmed without import space or mutation', async t => {
  const f = await fixture(t); f.available.add(image); f.free = 1n; await f.run();
  assert.equal(f.capacities.length, 0); assert.equal(f.streamed.length, 0); assert.deepEqual(f.closed, [image]);
});

test('image identities must match the Docker storage backend before load', async t => {
  for (const kind of ['classic-to-containerd', 'containerd-to-classic', 'containerd-match']) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind !== 'containerd-to-classic') f.driver = [['driver-type', 'io.containerd.snapshotter.v1']];
    if (kind !== 'classic-to-containerd') f.identity = 'manifest';
    if (kind === 'containerd-match') { await f.run(); assert.deepEqual(f.streamed, [image]); }
    else { await assert.rejects(f.run(), { code: 'DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE' }); assert.equal(f.streamed.length, 0); }
  });
});

test('cancel during submitted load waits for response and inspection, then skips later images and removes the owned marker', async t => {
  const f = await fixture(t, true), gate = deferred(); f.loadGate = gate.promise;
  let settled = false; const pending = f.run().then(() => { assert.fail('Cancellation must not succeed'); }, error => { settled = true; return error; });
  await f.entered.promise; f.controller.abort(); await delay(30);
  assert.equal(settled, false); assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), true);
  gate.resolve(); await pending;
  assert.equal(settled, true); assert.deepEqual(f.streamed, [image]); assert.ok(f.available.has(image)); assert.ok(!f.available.has(browserImage));
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false); assert.equal(f.closed.length, 2);
});

test('cancel immediately before spawn removes the owned marker without importing anything', async t => {
  const f = await fixture(t); f.beforeLoad = () => f.controller.abort();
  await assert.rejects(f.run()); assert.equal(f.streamed.length, 0);
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
});

test('uncertain load, transport and post-inspection keep a durable marker and refuse another attempt', async t => {
  for (const scenario of ['nonzero', 'transport', 'identity', 'cancelled-transport', 'unpack-exit-zero']) await t.test(scenario, async sub => {
    const f = await fixture(sub), gate = deferred();
    if (scenario === 'nonzero') f.loadCode = 1;
    if (scenario === 'transport' || scenario === 'cancelled-transport') f.loadTransport = true;
    if (scenario === 'identity') f.postInspectFailure = true;
    if (scenario === 'unpack-exit-zero') f.unpackFailure = true;
    if (scenario === 'cancelled-transport') f.loadGate = gate.promise;
    const pending = assert.rejects(f.run(), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
    if (scenario === 'cancelled-transport') { await f.entered.promise; f.controller.abort(); gate.resolve(); }
    await pending;
    const file = join(f.paths.appDataRoot, 'desktop-image-install.pending.json'), raw = await readFile(file, 'utf8');
    assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), true); assert.equal(raw.includes('PRIVATE'), false);
    assert.deepEqual(JSON.parse(raw).images, [image]);
    const calls = f.calls.length;
    await assert.rejects(installDesktopRuntimeImages({ ...f.options, signal: new AbortController().signal }, f.dependencies), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
    assert.equal(f.calls.length, calls); assert.equal(await readFile(file, 'utf8'), raw);
  });
});

test('a damaged pending marker is preserved without interpreting it as a clean first installation', async t => {
  const f = await fixture(t), path = join(f.paths.appDataRoot, 'desktop-image-install.pending.json');
  await writeFile(path, 'partial'); await assert.rejects(f.run(), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
  assert.equal(f.targetCount, 0); assert.equal(await readFile(path, 'utf8'), 'partial');
});

test('resource changes and descriptor cleanup failures cannot report a successful installation', async t => {
  const changed = await fixture(t); changed.changing = true;
  await assert.rejects(changed.run(), { code: 'DESKTOP_RUNTIME_INSTALL_FAILED' }); assert.equal(changed.streamed.length, 0);
  const closing = await fixture(t); closing.closeFailure = true;
  await assert.rejects(closing.run(), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
  assert.equal(await hasUnfinishedDesktopImageInstall(closing.paths.appDataRoot), true);
});

test('recovery diagnosis reads the owned target and presence without archive reads, loads or marker changes', async t => {
  const f = await fixture(t, true), journal = await f.pending([image, browserImage]); f.available.add(image);
  const info = await f.inspect();
  assert.equal(info.fingerprint, journal.fingerprint); assert.deepEqual(info.selection, f.options.selection);
  assert.deepEqual(info.images, [{ kind: 'worker', status: 'present' }, { kind: 'browser', status: 'missing' }]);
  assert.equal(f.verified.length, 0); assert.equal(f.streamed.length, 0); assert.equal(f.capacities.length, 0);
  assert.ok(f.calls.every(args => args[0] === 'version' || args[1] === 'inspect')); await journal.assertUnchanged();
});

test('recovery replays every pending immutable image including present ones and leaves completion to the settings commit', async t => {
  const f = await fixture(t, true), journal = await f.pending([image, browserImage]); f.available.add(image); f.available.add(browserImage);
  const info = await f.inspect(), result = await f.recover(info);
  assert.equal(result.fingerprint, journal.fingerprint); assert.deepEqual(result.selection, f.options.selection);
  assert.deepEqual(f.streamed, [image, browserImage]); assert.deepEqual(f.closed, [image, browserImage]);
  assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), true); await journal.assertUnchanged();
  await result.finish(); assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), false);
  await assert.rejects(result.finish(), { code: 'DESKTOP_IMAGE_JOURNAL_CHANGED' });
});

test('recovery never imports a missing image outside the original pending scope', async t => {
  const f = await fixture(t, true), journal = await f.pending();
  await assert.rejects(f.recover(await f.inspect()), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
  assert.equal(f.streamed.length, 0); await journal.assertUnchanged();
  f.available.add(browserImage); const result = await f.recover(await f.inspect());
  assert.deepEqual(f.streamed, [image]); await result.finish();
});

test('damaged, foreign and out-of-package recovery records fail before target discovery', async t => {
  for (const scenario of ['partial', 'owner', 'image', 'absent']) await t.test(scenario, async sub => {
    const f = await fixture(sub), path = join(f.paths.appDataRoot, 'desktop-image-install.pending.json');
    if (scenario === 'partial') await writeFile(path, 'PRIVATE_PARTIAL');
    if (scenario === 'owner') await createDesktopImageJournal(f.paths.appDataRoot, randomUUID(), f.options.selection, [image]);
    if (scenario === 'image') await f.pending([browserImage]);
    const previous = scenario === 'absent' ? null : await readFile(path, 'utf8');
    await assert.rejects(f.inspect(), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
    assert.equal(f.targetCount, 0); assert.equal(f.verified.length, 0);
    if (previous !== null) assert.equal(await readFile(path, 'utf8'), previous);
  });
});

test('recovery rejects a stale diagnosis or edited target before reading archives or opening Docker', async t => {
  for (const scenario of ['fingerprint', 'selection', 'replaced-record']) await t.test(scenario, async sub => {
    const f = await fixture(sub); await f.pending(); const info = await f.inspect(), targets = f.targetCount;
    if (scenario === 'fingerprint') info.fingerprint = '0'.repeat(64);
    if (scenario === 'selection') info.selection.distro = 'Other-Distro';
    if (scenario === 'replaced-record') {
      const path = join(f.paths.appDataRoot, 'desktop-image-install.pending.json');
      await writeFile(path, `${await readFile(path, 'utf8')}\n`);
    }
    await assert.rejects(f.recover(info), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
    assert.equal(f.targetCount, targets); assert.equal(f.verified.length, 0);
    assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), true);
  });
});

test('recovery failures preserve the same journal and never grant a completion capability', async t => {
  for (const scenario of ['archive', 'space', 'transport', 'unpack', 'post-inspection', 'close']) await t.test(scenario, async sub => {
    const f = await fixture(sub), journal = await f.pending(), info = await f.inspect();
    if (scenario === 'archive') f.archiveFailure = image;
    if (scenario === 'space') f.free = 20n * 1024n ** 3n;
    if (scenario === 'transport') f.loadTransport = true;
    if (scenario === 'unpack') f.unpackFailure = true;
    if (scenario === 'post-inspection') f.postInspectFailure = true;
    if (scenario === 'close') f.closeFailure = true;
    await assert.rejects(f.recover(info), { code: scenario === 'space' ? 'DESKTOP_RUNTIME_INSTALL_SPACE'
      : scenario === 'archive' ? 'DESKTOP_RUNTIME_INSTALL_FAILED' : 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
    await journal.assertUnchanged();
  });
});

test('recovery cancellation waits for the submitted load and preserves the record for explicit retry', async t => {
  const f = await fixture(t, true), journal = await f.pending([image, browserImage]), info = await f.inspect(), gate = deferred();
  f.loadGate = gate.promise; let settled = false;
  const pending = f.recover(info).then(() => assert.fail('Canceled recovery must not finish'), () => { settled = true; });
  await f.entered.promise; f.controller.abort(); await delay(30); assert.equal(settled, false); await journal.assertUnchanged();
  gate.resolve(); await pending; assert.deepEqual(f.streamed, [image]); assert.deepEqual(f.closed, [image, browserImage]);
  await journal.assertUnchanged();
});

test('completion rechecks the package and journal after the caller commits settings', async t => {
  for (const scenario of ['package', 'journal']) await t.test(scenario, async sub => {
    const f = await fixture(sub); await f.pending(); const result = await f.recover(await f.inspect());
    const path = join(f.paths.appDataRoot, 'desktop-image-install.pending.json');
    if (scenario === 'package') f.changing = true;
    else await writeFile(path, 'PRIVATE_REPLACEMENT');
    await assert.rejects(result.finish()); assert.equal(await hasUnfinishedDesktopImageInstall(f.paths.appDataRoot), true);
    if (scenario === 'journal') assert.equal(await readFile(path, 'utf8'), 'PRIVATE_REPLACEMENT');
  });
});
