import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { createWorkerReleaseManifest, workerSourceFiles } from '../shared/runtime-releases.ts';
import { DesktopWorkerProviderError, resolveDesktopWorkerProvider } from '../server/desktop-worker-provider.ts';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const image = `sha256:${'a'.repeat(64)}`, browser = `sha256:${'c'.repeat(64)}`;
async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'ac-desktop-worker-provider-'));
  t.after(async () => {
    assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}ac-desktop-worker-provider-`));
    await rm(temporary, { recursive: true, force: true });
  });
  const root = join(temporary, '설치 자원'), directory = join(root, 'runtimes', 'codex'), worker = join(root, 'worker');
  await mkdir(directory, { recursive: true }); await mkdir(join(worker, 'security'), { recursive: true });
  const source = Object.fromEntries(workerSourceFiles.map(name => [name, name === 'entry.mjs'
    ? Buffer.concat([Buffer.alloc(192 * 1024, 0x20), Buffer.from('// entry fixture\n')]) : Buffer.from(`// ${name} fixture\n`)]));
  for (const name of workerSourceFiles) await writeFile(join(worker, name), source[name]);
  for (const name of ['codex-userns.json', 'browser-userns.json']) await writeFile(join(worker, 'security', name), '{"fixture":true}');
  const sourceHashes = Object.fromEntries(workerSourceFiles.map(name => [name, hash(source[name])]));
  const active = createWorkerReleaseManifest({ image, sourceHashes, runtimeBaseHash: 'd'.repeat(64) });
  const previous = createWorkerReleaseManifest({ image: `sha256:${'b'.repeat(64)}`,
    sourceHashes: { ...sourceHashes, 'entry.mjs': 'e'.repeat(64) }, runtimeBaseHash: active.runtimeBaseHash });
  const manifest = { version: 1, provider: 'codex', codexVersion: '0.154.0', target: 'linux-x64',
    engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
    releaseCatalog: { version: 1, active: { image: active.image, manifestId: active.id }, manifests: [previous, active] } };
  const manifestPath = join(directory, 'worker.json');
  const save = async (value: unknown = manifest) => writeFile(manifestPath, JSON.stringify(value));
  await save();
  return { temporary, root, directory, worker, source, sourceHashes, manifest, manifestPath, save };
}
async function invalid(root: string) {
  await assert.rejects(resolveDesktopWorkerProvider(root), error => {
    assert.ok(error instanceof DesktopWorkerProviderError);
    assert.equal(error.code, 'DESKTOP_WORKER_PROVIDER_INVALID');
    assert.equal(error.message, error.code); assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
    if (root) assert.ok(!JSON.stringify(error).includes(root));
    return true;
  });
}

test('the active manifest hashes all nine files across chunks and returns an immutable independent snapshot', async t => {
  const f = await fixture(t), before = await readFile(f.manifestPath);
  const result = await resolveDesktopWorkerProvider(f.root);
  assert.deepEqual(result, { codexVersion: '0.154.0', engine: f.manifest.engine, releaseCatalog: f.manifest.releaseCatalog });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result!.engine)); assert.ok(Object.isFrozen(result!.releaseCatalog));
  assert.ok(Object.isFrozen(result!.releaseCatalog.active)); assert.ok(Object.isFrozen(result!.releaseCatalog.manifests));
  for (const manifest of result!.releaseCatalog.manifests) { assert.ok(Object.isFrozen(manifest)); assert.ok(Object.isFrozen(manifest.sourceHashes)); }
  assert.throws(() => { result!.releaseCatalog.active.image = browser; }, TypeError);
  assert.throws(() => { result!.releaseCatalog.manifests[1].sourceHashes['entry.mjs'] = 'f'.repeat(64); }, TypeError);
  assert.throws(() => { result!.releaseCatalog.manifests.pop(); }, TypeError);
  f.manifest.releaseCatalog.active.image = browser;
  assert.equal(result!.releaseCatalog.active.image, image);
  assert.deepEqual(await readFile(f.manifestPath), before);
  for (const name of workerSourceFiles) assert.deepEqual(await readFile(join(f.worker, name)), f.source[name]);
});

test('only the fixed manifest is discovered; absence neither adopts neighbors nor requires unused worker files', async t => {
  const f = await fixture(t); await rm(f.manifestPath);
  await writeFile(join(f.root, 'worker.json'), JSON.stringify(f.manifest));
  await rm(f.worker, { recursive: true });
  assert.equal(await resolveDesktopWorkerProvider(f.root), null);
  await rm(f.directory, { recursive: true }); assert.equal(await resolveDesktopWorkerProvider(f.root), null);
  await rm(join(f.root, 'runtimes'), { recursive: true }); assert.equal(await resolveDesktopWorkerProvider(f.root), null);
  assert.deepEqual(await readdir(f.root), ['worker.json']);
  await invalid(join(f.root, 'absent'));
});

test('strict identity and engine requirements reject other versions, architectures, mutable images and unknown fields', async t => {
  const f = await fixture(t);
  const cases: unknown[] = [null, [], { ...f.manifest, version: 2 }, { ...f.manifest, provider: 'other' },
    { ...f.manifest, codexVersion: '0.153.4' }, { ...f.manifest, target: 'linux-arm64' }, { ...f.manifest, privatePath: f.root },
    { ...f.manifest, engine: undefined }, { ...f.manifest, releaseCatalog: undefined }, { ...f.manifest, browserImage: 'worker:latest' }];
  for (const patch of [{ version: '29.1.4' }, { arch: 'arm64' }, { sandbox: 'default' }, { extra: true }]) {
    cases.push({ ...f.manifest, engine: { ...f.manifest.engine, ...patch } });
  }
  for (const value of cases) { await f.save(value); await invalid(f.root); }
});

test('catalog identity, complete source sets, active pin and historical compatibility use the existing release contract', async t => {
  const f = await fixture(t), catalog = f.manifest.releaseCatalog, active = catalog.manifests[1];
  const changedBase = createWorkerReleaseManifest({ image: `sha256:${'f'.repeat(64)}`, sourceHashes: active.sourceHashes, runtimeBaseHash: 'f'.repeat(64) });
  const changedHelper = createWorkerReleaseManifest({ image: `sha256:${'f'.repeat(64)}`,
    sourceHashes: { ...active.sourceHashes, 'storage.mjs': 'f'.repeat(64) }, runtimeBaseHash: active.runtimeBaseHash });
  for (const value of [{ ...catalog, extra: true }, { ...catalog, active: { ...catalog.active, image: 'worker:latest' } },
    { ...catalog, active: { ...catalog.active, manifestId: 'f'.repeat(64) } },
    { ...catalog, manifests: [] }, { ...catalog, manifests: [active, active] },
    { ...catalog, manifests: [changedBase, active] }, { ...catalog, manifests: [changedHelper, active] },
    { ...catalog, manifests: [{ ...active, id: 'f'.repeat(64) }] },
    { ...catalog, manifests: [{ ...active, sourceHashes: { ...active.sourceHashes, 'extra.mjs': 'f'.repeat(64) } }] },
    { ...catalog, manifests: [{ ...active, sourceHashes: { 'entry.mjs': active.sourceHashes['entry.mjs'] } }] }]) {
    await f.save({ ...f.manifest, releaseCatalog: value }); await invalid(f.root);
  }
});

test('any one of the nine source files being changed, absent or a directory fails rather than falling back', async t => {
  const f = await fixture(t);
  for (const name of workerSourceFiles) {
    const path = join(f.worker, name), changed = Buffer.from(f.source[name]); changed[changed.length - 1] ^= 1;
    await writeFile(path, changed); await invalid(f.root);
    await rm(path); await invalid(f.root);
    await mkdir(path); await invalid(f.root);
    await rm(path, { recursive: true }); await writeFile(path, f.source[name]);
  }
});

test('browser seccomp is required only with an immutable browser image; worker seccomp is always required', async t => {
  const f = await fixture(t), workerProfile = join(f.worker, 'security', 'codex-userns.json'), browserProfile = join(f.worker, 'security', 'browser-userns.json');
  await rm(browserProfile); assert.ok(await resolveDesktopWorkerProvider(f.root));
  await f.save({ ...f.manifest, browserImage: browser }); await invalid(f.root);
  await writeFile(browserProfile, '{}'); assert.equal((await resolveDesktopWorkerProvider(f.root))!.browserImage, browser);
  await rm(workerProfile); await invalid(f.root);
  await mkdir(workerProfile); await invalid(f.root);
  await rm(workerProfile, { recursive: true }); await writeFile(workerProfile, ''); await invalid(f.root);
});

test('bounded manifests and files reject invalid UTF-8, malformed data and oversize before adoption', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.from('{PRIVATE_BROKEN_JSON'), Buffer.from([0xff, 0xfe]), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)]) {
    await writeFile(f.manifestPath, bytes); await invalid(f.root); assert.deepEqual(await readFile(f.manifestPath), bytes);
  }
  await f.save();
  for (const path of [join(f.worker, 'entry.mjs'), join(f.worker, 'security', 'codex-userns.json')]) {
    const original = await readFile(path); await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
    await invalid(f.root); await writeFile(path, original);
  }
});

test('manifest, source and both enabled profiles reject hard links without changing their outside targets', async t => {
  const f = await fixture(t); await f.save({ ...f.manifest, browserImage: browser });
  for (const [index, path] of [f.manifestPath, join(f.worker, 'entry.mjs'), join(f.worker, 'security', 'codex-userns.json'),
    join(f.worker, 'security', 'browser-userns.json')].entries()) {
    const original = await readFile(path), outside = join(f.temporary, `private-${index}`);
    await writeFile(outside, original); await rm(path); await link(outside, path);
    await invalid(f.root); assert.deepEqual(await readFile(outside), original); assert.equal((await lstat(path)).nlink, 2);
    await rm(path); await writeFile(path, original);
  }
});

test('resource, runtime, worker, security and file paths reject redirects before following an outside path', async t => {
  const f = await fixture(t), kind = process.platform === 'win32' ? 'junction' : 'dir', alias = join(f.temporary, 'alias');
  await symlink(f.root, alias, kind); await invalid(alias); await invalid(join(alias, 'worker')); await rm(alias);
  const outside = join(f.temporary, 'outside'); await mkdir(outside);
  for (const path of [f.manifestPath, join(f.worker, 'entry.mjs'), join(f.worker, 'security', 'codex-userns.json')]) {
    const bytes = await readFile(path); await rm(path); await symlink(outside, path, kind);
    await invalid(f.root); await rm(path); await writeFile(path, bytes);
  }
  for (const path of [join(f.worker, 'security'), f.worker, f.directory, join(f.root, 'runtimes')]) {
    await rm(path, { recursive: true }); await symlink(outside, path, kind); await invalid(f.root); await rm(path);
    // Recreate only the directory needed to reach the next ancestor check.
    if (path === join(f.worker, 'security') || path === f.directory) await mkdir(path);
  }
  assert.deepEqual(await readdir(outside), []);
});

test('ordinary absolute resource roots are required, excluding Windows aliases and special path syntax', async t => {
  const f = await fixture(t);
  for (const value of ['', 'relative', parse(f.root).root, `${f.root}\0`, `${f.root}${sep}..`, `${f.root}${sep}.`]) await invalid(value);
  if (process.platform === 'win32') for (const value of ['C:relative', '\\root-relative', '\\\\host\\share\\resources', '\\\\?\\C:\\resources',
    `${f.root}\\config:stream`, `${f.root}\\NUL`, `${f.root}\\COM1.txt`, `${f.root}\\name.`, `${f.root}\\name `]) await invalid(value);
});

test('the installed worker layout matches the current build payload nine-file list plus security resources', async t => {
  const f = await fixture(t), hashes: Record<string, string> = {};
  assert.equal(workerSourceFiles.length, 9);
  for (const name of workerSourceFiles) {
    const bytes = await readFile(new URL(`../worker/${name}`, import.meta.url));
    hashes[name] = hash(bytes); await writeFile(join(f.worker, name), bytes);
  }
  for (const name of ['codex-userns.json', 'browser-userns.json']) {
    await writeFile(join(f.worker, 'security', name), await readFile(new URL(`../worker/security/${name}`, import.meta.url)));
  }
  const release = createWorkerReleaseManifest({ image, sourceHashes: hashes, runtimeBaseHash: 'd'.repeat(64) });
  await f.save({ ...f.manifest, browserImage: browser,
    releaseCatalog: { version: 1, active: { image: release.image, manifestId: release.id }, manifests: [release] } });
  const result = await resolveDesktopWorkerProvider(f.root);
  assert.deepEqual(result!.releaseCatalog.manifests[0].sourceHashes, hashes);
  // The fake image ID is merely manifest data; this test makes no Docker/engine assertion.
});
