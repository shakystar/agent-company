import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { buildDesktopWorker, desktopWorkerBuildArguments } from '../scripts/build-desktop-worker.ts';
import { desktopBuildArguments } from '../scripts/desktop-build-options.ts';
import type { DesktopDockerTarget } from '../server/desktop-docker-target.ts';
import { createWorkerReleaseManifest, requireWorkerRelease, workerSourceFiles } from '../shared/runtime-releases.ts';

const image = `sha256:${'a'.repeat(64)}`, browser = `sha256:${'b'.repeat(64)}`;
const wslExecutable = join(process.platform === 'win32' ? 'C:\\Windows' : '/fixture', 'wsl.exe');
const options = { wslExecutable, distro: 'Fixture-Only' };
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-worker-build-'));
  t.after(async () => {
    const part = relative(tmpdir(), root);
    assert.ok(part.startsWith('ac-desktop-worker-build-') && !isAbsolute(part) && !part.includes(sep));
    await rm(root, { recursive: true });
  });
  const paths = { source: join(root, 'worker'), builds: join(root, 'candidates') };
  await mkdir(join(paths.source, 'security'), { recursive: true });
  const sources: Record<string, string> = {};
  for (const file of workerSourceFiles) {
    const data = file === 'npm-empty.npmrc' ? '' : `// public fixture ${file}\n`;
    await writeFile(join(paths.source, file), data); sources[file] = hash(data);
  }
  await writeFile(join(paths.source, 'Dockerfile'), 'FROM fixture-only\nARG CODEX_VERSION\n');
  for (const file of ['codex-userns.json', 'browser-userns.json', 'LICENSE.moby']) await writeFile(join(paths.source, 'security', file), 'public fixture');
  await writeFile(join(paths.source, 'auth.json'), 'PRIVATE_NOT_AN_INPUT');
  await writeFile(join(root, '.env'), 'AGENT_IMAGE=OPERATING_TAG_MUST_NOT_BE_USED');
  const calls: string[][] = [], archive = Buffer.alloc(160 * 1024, 0x61);
  let output = '', targets = 0, savedChunks = 0, free = 100n * 1024n ** 3n;
  let engine = '29.1.3/amd64', version = 'codex-cli 0.154.0', cleanupUncertain = false, buildFailure = false, exportFailure = false, tamper = false;
  let selectedImage = image, archiveInvalid = false, checkedArchives = 0;
  let afterExport: (() => Promise<void>) | undefined;
  const mapped = new Map<string, string>();
  const target: DesktopDockerTarget = {
    async mapFile(path) { const mappedPath = `/fixture/${basename(path)}`; mapped.set(mappedPath, path); return mappedPath; },
    async mapAuthFile() { throw new Error('Authentication must not be accessed'); },
    async command(file, args, config) {
      assert.equal(file, 'docker'); calls.push(args);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (args[0] === 'version') return ok(engine);
      if (args[0] === 'build') {
        if (buildFailure) return { code: 1, stdout: '', stderr: 'build fixture failure' };
        assert.equal(args[args.indexOf('--label') + 1], 'agent-company.desktop-provider=codex-0.154.0');
        const path = mapped.get(args[args.indexOf('--iidfile') + 1])!; output = dirname(path);
        await writeFile(path, image); return ok();
      }
      if (args[0] === 'run' || args[0] === 'create') {
        assert.ok(args.includes('--platform=linux/amd64'));
        assert.ok(args.includes(image), 'Use the original immutable image record to select its platform');
        return ok(args.includes('--entrypoint=codex') ? version
        : workerSourceFiles.map(name => `${sources[name]}  /app/${name}`).join('\n'));
      }
      if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: cleanupUncertain ? 'daemon unavailable' : 'No such container' };
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (args[2] === selectedImage && selectedImage !== image) return { code: 1, stdout: '', stderr: 'No such image: selected child has no independent image record' };
        return ok(JSON.stringify({ Id: args[2] === image && args.includes('--platform=linux/amd64') ? selectedImage : args[2], Os: 'linux', Architecture: 'amd64', Size: archive.length,
        Config: { Labels: { 'agent-company.desktop-provider': 'codex-0.154.0' } } }));
      }
      if (args[0] === 'image' && args[1] === 'save') {
        assert.equal(config?.captureStdout, false);
        for (let offset = 0; offset < archive.length; offset += 64 * 1024) {
          await config!.onStdout!(archive.subarray(offset, offset + 64 * 1024)); savedChunks++;
          if (exportFailure) return { code: 1, stdout: '', stderr: 'incomplete archive fixture' };
        }
        if (tamper) await writeFile(join(output, 'worker', 'entry.mjs'), 'changed after image build');
        await afterExport?.();
        return ok();
      }
      throw new Error(`Unexpected fixture command ${args[0]}`);
    },
  };
  const dependencies = { createTarget: async (value: { dockerConfigDir: string; wslExecutable: string; distro: string }) => {
    targets++; assert.equal(value.wslExecutable, wslExecutable); assert.equal(value.distro, options.distro); return target;
  }, runtimeBase: async (_config: unknown, id: string, _owner: string, runner: typeof target.command = target.command) => {
    const inspected = await runner('docker', ['image', 'inspect', id, '--format', '{{json .}}']);
    assert.equal(inspected.code, 0); assert.equal(JSON.parse(inspected.stdout).Id, id);
    await runner('docker', ['create', '--network=none', '--entrypoint=/bin/true', id]);
    await runner('docker', ['run', '--network=none', '--entrypoint=python3', id, '-B', '-c', 'public fixture only']);
    const parser = calls.at(-1)!; assert.equal(parser[parser.indexOf(image) - 1], '--');
    return 'c'.repeat(64);
  }, freeBytes: async () => free, verifyArchive: async () => {
    // This fixture tests command/publication orchestration. Real tar semantics have separate tests.
    checkedArchives++; if (archiveInvalid) throw new Error('archive semantic fixture failure');
  } };
  const run = (withBrowser = false, previousWorkerPackage?: string) => buildDesktopWorker({ ...options,
    ...(withBrowser ? { browserImage: browser } : {}), ...(previousWorkerPackage ? { previousWorkerPackage } : {}) }, paths, dependencies);
  const unpublished = async () => {
    const candidates = await readdir(paths.builds); assert.equal(candidates.length, 1);
    await assert.rejects(readFile(join(paths.builds, candidates[0], 'runtimes', 'codex', 'worker.json')), { code: 'ENOENT' });
  };
  return { root, paths, calls, archive, sources, run, unpublished, get targets() { return targets; }, get savedChunks() { return savedChunks; },
    set free(value: bigint) { free = value; }, set engine(value: string) { engine = value; }, set version(value: string) { version = value; },
    set cleanupUncertain(value: boolean) { cleanupUncertain = value; }, set buildFailure(value: boolean) { buildFailure = value; },
    set exportFailure(value: boolean) { exportFailure = value; }, set tamper(value: boolean) { tamper = value; },
    set selectedImage(value: string) { selectedImage = value; }, set archiveInvalid(value: boolean) { archiveInvalid = value; },
    set afterExport(value: () => Promise<void>) { afterExport = value; },
    get checkedArchives() { return checkedArchives; } };
}

async function previousPackage(f: Awaited<ReturnType<typeof fixture>>, changes: {
  sameImage?: boolean; identical?: boolean; duplicate?: boolean; helper?: boolean; base?: boolean;
} = {}) {
  const path = join(f.root, 'previous-resources'), runtime = join(path, 'runtimes', 'codex');
  await mkdir(runtime, { recursive: true }); await mkdir(join(path, 'worker', 'security'), { recursive: true });
  const sources: Record<string, string> = {};
  for (const file of workerSourceFiles) {
    const data = file === 'entry.mjs' && !changes.identical ? 'public prior entry'
      : file === 'growth.mjs' && changes.helper ? 'public incompatible helper' : await readFile(join(f.paths.source, file));
    await writeFile(join(path, 'worker', file), data); sources[file] = hash(data);
  }
  await writeFile(join(path, 'worker', 'security', 'codex-userns.json'), 'public fixture');
  await writeFile(join(path, 'auth.json'), 'PRIVATE_OLD_AUTH_NOT_AN_INPUT');
  const manifest = createWorkerReleaseManifest({ image: changes.sameImage || changes.identical ? image : `sha256:${'e'.repeat(64)}`,
    sourceHashes: sources, runtimeBaseHash: (changes.base ? 'd' : 'c').repeat(64) });
  const provider = { version: 1, provider: 'codex', codexVersion: '0.154.0', target: 'linux-x64',
    engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
    releaseCatalog: { version: 1, active: { image: manifest.image, manifestId: manifest.id },
      manifests: changes.duplicate ? [manifest, manifest] : [manifest] } };
  await writeFile(join(runtime, 'worker.json'), JSON.stringify(provider, null, 2));
  await writeFile(join(runtime, 'worker.tar'), f.archive);
  await writeFile(join(runtime, 'images.json'), JSON.stringify({ version: 1,
    images: [{ kind: 'worker', image: manifest.image, file: 'worker.tar', bytes: f.archive.length, sha256: hash(f.archive) }] }));
  return { path, runtime, manifest, provider };
}

test('desktop package arguments require explicit paired providers and reject ambiguity', () => {
  assert.deepEqual(desktopBuildArguments([]), {});
  assert.deepEqual(desktopBuildArguments(['--codex-executable', wslExecutable, '--worker-package', dirname(wslExecutable)]),
    { codexExecutable: wslExecutable, workerPackage: dirname(wslExecutable) });
  for (const args of [['--worker-package', dirname(wslExecutable)], ['--codex-executable', 'relative'], ['--auto'],
    ['--codex-executable', wslExecutable, '--codex-executable', wslExecutable]]) assert.throws(() => desktopBuildArguments(args));
  assert.deepEqual(desktopWorkerBuildArguments(['--distro', options.distro, '--wsl-executable', wslExecutable]), options);
  for (const args of [[], ['--wsl-executable', wslExecutable], ['--wsl-executable', 'wsl.exe', '--distro', 'x'],
    ['--wsl-executable', wslExecutable, '--distro', 'x', '--browser-image', 'mutable:latest']]) assert.throws(() => desktopWorkerBuildArguments(args));
  const base = ['--wsl-executable', wslExecutable, '--distro', options.distro];
  assert.deepEqual(desktopWorkerBuildArguments([...base, '--previous-worker-package', dirname(wslExecutable)]),
    { ...options, previousWorkerPackage: dirname(wslExecutable) });
  for (const extra of [['--previous-worker-package', 'relative'], ['--previous-worker-package'],
    ['--previous-worker-package', `${dirname(wslExecutable)}/../other`],
    ['--previous-worker-package', dirname(wslExecutable), '--previous-worker-package', dirname(wslExecutable)]]) {
    assert.throws(() => desktopWorkerBuildArguments([...base, ...extra]));
  }
});

test('explicit prior package retains exact compatible Run pins while exporting only new active images', async t => {
  const f = await fixture(t), previous = await previousPackage(f);
  const before = await readFile(join(previous.runtime, 'worker.json'));
  const built = await f.run(true, previous.path);
  assert.equal(built.provider.releaseCatalog.active.image, image);
  assert.equal(built.provider.releaseCatalog.manifests.length, 2);
  assert.deepEqual(requireWorkerRelease(built.provider.releaseCatalog, previous.provider.releaseCatalog.active), previous.manifest);
  assert.deepEqual(built.images.map(item => item.image), [image, browser]);
  assert.ok(!f.calls.some(call => call.includes(previous.manifest.image)));
  assert.deepEqual(await readFile(join(previous.runtime, 'worker.json')), before);
  const receipt = JSON.parse(await readFile(join(built.output, 'build-receipt.json'), 'utf8'));
  assert.equal(receipt.previousWorkerPackage.files.find((item: { file: string }) => item.file === 'runtimes/codex/worker.json').pin.sha256, hash(before));
  assert.ok(!receipt.previousWorkerPackage.files.some((item: { file: string }) => item.file.includes('auth')));
  await assert.rejects(readFile(join(built.output, 'auth.json')), { code: 'ENOENT' });
});

test('identical prior active evidence is retained once without changing its pin', async t => {
  const f = await fixture(t), previous = await previousPackage(f, { identical: true });
  const built = await f.run(false, previous.path);
  assert.deepEqual(built.provider.releaseCatalog.manifests, [previous.manifest]);
});

test('prior duplicate catalog or corrupt archive fails before Docker discovery', async t => {
  for (const kind of ['duplicate', 'archive']) await t.test(kind, async sub => {
    const f = await fixture(sub), previous = await previousPackage(f, { duplicate: kind === 'duplicate' });
    if (kind === 'archive') await writeFile(join(previous.runtime, 'worker.tar'), 'changed old archive');
    await assert.rejects(f.run(false, previous.path));
    assert.equal(f.targets, 0); assert.equal(f.calls.length, 0);
    await assert.rejects(readdir(f.paths.builds), { code: 'ENOENT' });
  });
});

test('incompatible prior helpers, runtime base, or conflicting image evidence cannot publish', async t => {
  for (const kind of ['helper', 'base', 'conflict']) await t.test(kind, async sub => {
    const f = await fixture(sub), previous = await previousPackage(f,
      { helper: kind === 'helper', base: kind === 'base', sameImage: kind === 'conflict' });
    await assert.rejects(f.run(false, previous.path), kind === 'conflict' ? /충돌/ : /helper 계약 또는 실행 기반/);
    await f.unpublished(); assert.ok(!f.calls.some(call => call[1] === 'save'));
  });
});

test('changes to prior JSON bytes, archive, helper or profile during export prevent publication', async t => {
  for (const kind of ['json', 'images-json', 'archive', 'helper', 'profile']) await t.test(kind, async sub => {
    const f = await fixture(sub), previous = await previousPackage(f);
    f.afterExport = async () => {
      if (kind === 'json') await writeFile(join(previous.runtime, 'worker.json'), JSON.stringify(previous.provider));
      if (kind === 'images-json') await writeFile(join(previous.runtime, 'images.json'), `${await readFile(join(previous.runtime, 'images.json'), 'utf8')}\n`);
      if (kind === 'archive') await writeFile(join(previous.runtime, 'worker.tar'), 'changed old archive');
      if (kind === 'helper') await writeFile(join(previous.path, 'worker', 'growth.mjs'), 'changed old helper');
      if (kind === 'profile') await writeFile(join(previous.path, 'worker', 'security', 'codex-userns.json'), 'changed old profile');
    };
    await assert.rejects(f.run(false, previous.path)); await f.unpublished();
  });
});

test('worker build preserves operating inputs, snapshots only public files and publishes verified multi-chunk archives last', async t => {
  const f = await fixture(t), built = await f.run(true);
  assert.equal(built.distributionReady, false); assert.equal(built.images.length, 2); assert.equal(f.savedChunks, 6);
  assert.equal(f.checkedArchives, 2);
  assert.deepEqual(built.provider.releaseCatalog.manifests[0].sourceHashes, f.sources);
  assert.deepEqual(await readFile(join(built.output, 'runtimes', 'codex', 'worker.tar')), f.archive);
  const build = f.calls.find(call => call[0] === 'build')!;
  assert.ok(build.includes('CODEX_VERSION=0.154.0')); assert.ok(!build.includes('-t')); assert.ok(!build.some(value => value.includes('OPERATING')));
  assert.ok(f.calls.filter(call => call[0] === 'image' && call[1] === 'save').every(call => call.includes('--platform=linux/amd64')));
  assert.ok(f.calls.filter(call => call[0] === 'run').every(call => call.includes('--network=none') && !call.includes('--mount')));
  await assert.rejects(readFile(join(built.output, 'worker', 'auth.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.root, '.env'), 'utf8'), 'AGENT_IMAGE=OPERATING_TAG_MUST_NOT_BE_USED');
  const evidence = JSON.parse(await readFile(join(built.output, 'build-receipt.json'), 'utf8'));
  assert.equal(evidence.archiveLoadVerified, false); assert.equal(evidence.modelVerified, false);
});

test('insufficient build capacity stops before candidate creation or Docker discovery', async t => {
  const f = await fixture(t); f.free = 21n * 1024n ** 3n;
  await assert.rejects(f.run(), /20GiB/); assert.equal(f.targets, 0); assert.equal(f.calls.length, 0);
  await assert.rejects(readdir(f.paths.builds), { code: 'ENOENT' });
});

test('platform-filtered builds export the original index and pin its child even without a child image-store record', async t => {
  const f = await fixture(t), selected = `sha256:${'d'.repeat(64)}`; f.selectedImage = selected;
  const built = await f.run();
  assert.equal(built.provider.releaseCatalog.active.image, selected);
  assert.equal(built.images[0].image, selected);
  assert.ok(f.calls.filter(call => call[0] === 'image' && call[1] === 'inspect').every(call => call[2] !== selected));
  assert.ok(f.calls.filter(call => call[1] === 'save').every(call => call.at(-1) === image && call.includes('--platform=linux/amd64')));
  const receipt = JSON.parse(await readFile(join(built.output, 'build-receipt.json'), 'utf8'));
  assert.equal(receipt.buildImage, image); assert.equal(receipt.image, selected);
});

test('invalid archive semantics stop provider publication after export', async t => {
  const f = await fixture(t); f.archiveInvalid = true;
  await assert.rejects(f.run(), /archive semantic/); assert.equal(f.checkedArchives, 1); await f.unpublished();
});

test('wrong engine and failed builds never publish a provider or export an image', async t => {
  for (const kind of ['engine', 'build']) await t.test(kind, async sub => {
    const f = await fixture(sub); if (kind === 'engine') f.engine = '30.0.0/amd64'; else f.buildFailure = true;
    await assert.rejects(f.run()); await f.unpublished(); assert.ok(!f.calls.some(call => call[1] === 'save'));
  });
});

test('wrong actual Codex version and uncertain cleanup prevent archive publication', async t => {
  for (const kind of ['version', 'cleanup']) await t.test(kind, async sub => {
    const f = await fixture(sub); if (kind === 'version') f.version = 'codex-cli 0.153.4'; else f.cleanupUncertain = true;
    await assert.rejects(f.run()); await f.unpublished(); assert.ok(f.calls.some(call => call[0] === 'inspect'));
    assert.ok(!f.calls.some(call => call[1] === 'save'));
  });
});

test('partial archive export and snapshot tampering retain an unpublished candidate', async t => {
  for (const kind of ['partial', 'tamper']) await t.test(kind, async sub => {
    const f = await fixture(sub); if (kind === 'partial') f.exportFailure = true; else f.tamper = true;
    await assert.rejects(f.run()); await f.unpublished();
    assert.equal(await readFile(join(f.paths.source, 'entry.mjs'), 'utf8'), '// public fixture entry.mjs\n');
  });
});
