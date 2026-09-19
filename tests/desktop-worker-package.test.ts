import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createWorkerReleaseManifest, workerSourceFiles } from '../shared/runtime-releases.ts';
import { inspectDesktopWorkerPackage, stageDesktopWorkerPackage } from '../scripts/desktop-worker-package.ts';
import { desktopImagePackageAvailable, readDesktopImagePackage } from '../server/desktop-image-package.ts';

const pin = (value: Uint8Array | string) => ({ bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });
const workerImage = `sha256:${'a'.repeat(64)}`, browserImage = `sha256:${'b'.repeat(64)}`;
async function fixture(t: test.TestContext, browser = false) {
  const root = await mkdtemp(join(tmpdir(), 'ac-worker-package-'));
  t.after(async () => {
    const location = relative(tmpdir(), root);
    assert.ok(location.startsWith('ac-worker-package-') && !isAbsolute(location) && !location.includes(sep));
    await rm(root, { recursive: true });
  });
  const input = join(root, '입력 자원'), destination = join(root, '출력 자원'), directory = join(input, 'runtimes', 'codex');
  await mkdir(directory, { recursive: true });
  for (const resourceRoot of [input, destination]) await mkdir(join(resourceRoot, 'worker', 'security'), { recursive: true });
  const sources = Object.fromEntries(workerSourceFiles.map(file => [file, file === 'npm-empty.npmrc' ? '' : `// ${file} source\n`]));
  const profiles = { 'codex-userns.json': '{"profile":"codex-fixture"}', 'browser-userns.json': '{"profile":"browser-fixture"}' };
  for (const resourceRoot of [input, destination]) {
    for (const file of workerSourceFiles) await writeFile(join(resourceRoot, 'worker', file), sources[file]);
    for (const [file, body] of Object.entries(profiles)) await writeFile(join(resourceRoot, 'worker', 'security', file), body);
  }
  const release = createWorkerReleaseManifest({ image: workerImage, runtimeBaseHash: 'c'.repeat(64),
    sourceHashes: Object.fromEntries(workerSourceFiles.map(file => [file, pin(sources[file]).sha256])) });
  const provider = { version: 1, provider: 'codex', codexVersion: '0.154.0', target: 'linux-x64',
    engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
    releaseCatalog: { version: 1, active: { image: workerImage, manifestId: release.id }, manifests: [release] },
    ...(browser ? { browserImage } : {}) };
  // Deliberately not real tar files: these fixtures verify file integrity, not Docker/tar semantics.
  const worker = Buffer.alloc(192 * 1024, 0x61), browserBytes = Buffer.from('browser archive fixture');
  const images = { version: 1, images: [{ kind: 'worker', image: workerImage, file: 'worker.tar', ...pin(worker) },
    ...(browser ? [{ kind: 'browser', image: browserImage, file: 'browser.tar', ...pin(browserBytes) }] : [])] };
  await writeFile(join(directory, 'worker.tar'), worker);
  if (browser) await writeFile(join(directory, 'browser.tar'), browserBytes);
  await writeFile(join(directory, 'worker.json'), JSON.stringify(provider));
  const saveImages = (value: unknown = images) => writeFile(join(directory, 'images.json'), JSON.stringify(value));
  await saveImages();
  return { root, input, destination, directory, provider, images, worker, browserBytes, sources, profiles, saveImages };
}
async function rejects(operation: Promise<unknown>) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'DESKTOP_WORKER_PACKAGE_INVALID');
    assert.equal((error as Error & { code: string }).code, error.message);
    assert.equal(error.cause, undefined); return true;
  });
}

test('runtime metadata checks exact bundled image scope without presenting archive availability as verification', async t => {
  const f = await fixture(t, true), bundle = await readDesktopImagePackage(f.input);
  assert.equal(await desktopImagePackageAvailable(f.input), true); assert.deepEqual(bundle.images, f.images.images);
  // The runtime's availability query is deliberately cheap; the install operation must
  // separately reject these deliberately non-tar fixture bytes before contacting Docker.
  await bundle.assertUnchanged();
  await writeFile(join(f.input, 'worker', 'security', 'codex-userns.json'), 'changed security resource');
  await assert.rejects(bundle.assertUnchanged());
});

test('registry packages stage only metadata and preserve existing worker release IDs', async t => {
  const f = await fixture(t, true);
  const images = f.images.images.map(item => ({ kind: item.kind, image: item.image,
    reference: `docker.io/fixture/agent-company-${item.kind}@${item.image}`, imageIdentity: 'manifest', downloadBytes: 500, layerBytes: 1000 }));
  await f.saveImages({ version: 2, images });
  const source = await inspectDesktopWorkerPackage(f.input);
  const result = await stageDesktopWorkerPackage(f.input, f.destination, source);
  assert.deepEqual(result.provider, source.provider); assert.deepEqual(result.images, images);
  const output = join(f.destination, 'runtimes', 'codex');
  assert.deepEqual((await readdir(output)).sort(), ['images.json', 'worker.json']);
  assert.equal(result.bytes, (await readFile(join(output, 'images.json'))).length + (await readFile(join(output, 'worker.json'))).length);
  assert.deepEqual((await readDesktopImagePackage(f.destination)).images, images);
  assert.deepEqual(await readFile(join(f.directory, 'worker.tar')), f.worker);
});

test('runtime package metadata rejects changed image scope and source files before installation is offered', async t => {
  for (const kind of ['duplicate', 'foreign', 'source']) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind === 'duplicate') await f.saveImages({ version: 1, images: [f.images.images[0], f.images.images[0]] });
    if (kind === 'foreign') await f.saveImages({ version: 1, images: [{ ...f.images.images[0], image: browserImage }] });
    if (kind === 'source') await writeFile(join(f.input, 'worker', 'entry.mjs'), 'changed source');
    assert.equal(await desktopImagePackageAvailable(f.input), false); await assert.rejects(readDesktopImagePackage(f.input));
  });
});

test('inspection checks immutable refs and all archive chunks and returns an independent frozen receipt', async t => {
  const f = await fixture(t, true), names = await readdir(f.directory);
  const receipt = await inspectDesktopWorkerPackage(f.input);
  assert.deepEqual(receipt.images, f.images.images);
  assert.equal(receipt.provider.releaseCatalog.active.image, workerImage);
  assert.equal(receipt.bytes, f.worker.length + f.browserBytes.length + (await readFile(join(f.directory, 'images.json'))).length
    + (await readFile(join(f.directory, 'worker.json'))).length);
  assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.images)); assert.ok(Object.isFrozen(receipt.images[0]));
  assert.throws(() => { receipt.images[0].image = `sha256:${'f'.repeat(64)}`; }, TypeError);
  assert.deepEqual(await readdir(f.directory), names); assert.deepEqual(await readFile(join(f.directory, 'worker.tar')), f.worker);
});

test('staging copies only archives and manifests into a new tree and preserves independent source resources', async t => {
  const f = await fixture(t, true);
  await writeFile(join(f.directory, 'auth.json'), 'PRIVATE_NOT_AN_INPUT');
  await mkdir(join(f.destination, 'runtimes')); await writeFile(join(f.destination, 'runtimes', 'unrelated'), 'PRESERVE');
  const receipt = await stageDesktopWorkerPackage(f.input, f.destination), output = join(f.destination, 'runtimes', 'codex');
  assert.deepEqual((await readdir(output)).sort(), ['browser.tar', 'images.json', 'worker.json', 'worker.tar']);
  assert.deepEqual(await inspectDesktopWorkerPackage(f.destination), receipt);
  for (const file of ['worker.tar', 'browser.tar', 'images.json', 'worker.json']) {
    assert.deepEqual(await readFile(join(output, file)), await readFile(join(f.directory, file)));
    const source = await lstat(join(f.directory, file)), copied = await lstat(join(output, file));
    assert.equal(copied.nlink, 1); assert.notEqual(copied.ino, source.ino);
  }
  for (const file of workerSourceFiles) assert.equal(await readFile(join(f.destination, 'worker', file), 'utf8'), f.sources[file]);
  assert.equal(await readFile(join(f.destination, 'runtimes', 'unrelated'), 'utf8'), 'PRESERVE');
  assert.equal(await readFile(join(f.directory, 'auth.json'), 'utf8'), 'PRIVATE_NOT_AN_INPUT');
});

test('strict image manifest rejects unknown owner fields, paths, hashes, sizes and mismatched active images', async t => {
  const f = await fixture(t), row = f.images.images[0];
  const badRows = [{ ...row, ownerKey: 'PRIVATE_OWNER' }, { ...row, file: '../worker.tar' }, { ...row, file: 'C:\\worker.tar' },
    { ...row, file: 'browser.tar' }, { ...row, kind: 'other' }, { ...row, image: browserImage }, { ...row, image: 'worker:latest' },
    { ...row, bytes: 0 }, { ...row, bytes: 1.5 }, { ...row, bytes: 8 * 1024 ** 3 + 1 },
    { ...row, sha256: 'F'.repeat(64) }, { ...row, sha256: 'wrong' }];
  for (const value of [null, [], { ...f.images, version: 2 }, { ...f.images, extra: true },
    { ...f.images, images: [] }, ...badRows.map(item => ({ version: 1, images: [item] }))]) {
    await f.saveImages(value); await rejects(inspectDesktopWorkerPackage(f.input));
  }
  for (const raw of ['', '{', 'x'.repeat(16_385), Buffer.from([0xff])]) {
    await writeFile(join(f.directory, 'images.json'), raw); await rejects(inspectDesktopWorkerPackage(f.input));
  }
});

test('worker is required and browser must occur exactly once only when the provider specifies it', async t => {
  const f = await fixture(t, true), [worker, browser] = f.images.images;
  for (const images of [[worker], [browser], [worker, worker], [browser, browser], [worker, browser, browser],
    [worker, { ...browser, image: workerImage }]]) {
    await f.saveImages({ version: 1, images }); await rejects(inspectDesktopWorkerPackage(f.input));
  }
  await f.saveImages();
  const { browserImage: _browser, ...withoutBrowser } = f.provider;
  await writeFile(join(f.directory, 'worker.json'), JSON.stringify(withoutBrowser));
  await rejects(inspectDesktopWorkerPackage(f.input));
});

test('missing, changed, truncated, hard-linked and non-file archives never pass inspection', async t => {
  const f = await fixture(t), archive = join(f.directory, 'worker.tar');
  const changed = Buffer.from(f.worker); changed[100_000] ^= 1; await writeFile(archive, changed);
  await rejects(inspectDesktopWorkerPackage(f.input));
  await writeFile(archive, f.worker.subarray(0, f.worker.length - 1)); await rejects(inspectDesktopWorkerPackage(f.input));
  await rm(archive); await rejects(inspectDesktopWorkerPackage(f.input));
  await mkdir(archive); await rejects(inspectDesktopWorkerPackage(f.input));
  await rm(archive, { recursive: true }); await writeFile(archive, f.worker);
  await link(archive, join(f.root, 'archive-alias')); await rejects(inspectDesktopWorkerPackage(f.input));
});

test('linked manifest or redirected source/destination parent is rejected without touching the other directory', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'images-alias'); await link(join(f.directory, 'images.json'), alias);
  await rejects(inspectDesktopWorkerPackage(f.input)); await rm(alias);
  const inputAlias = join(f.root, 'input-alias'), outputAlias = join(f.root, 'output-alias');
  await symlink(f.input, inputAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(f.destination, outputAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(inspectDesktopWorkerPackage(inputAlias)); await rejects(stageDesktopWorkerPackage(f.input, outputAlias));
  assert.deepEqual(await readdir(f.destination), ['worker']);
});

test('existing targets and overlapping resource roots are preserved rather than adopted or overwritten', async t => {
  const f = await fixture(t), output = join(f.destination, 'runtimes', 'codex');
  await mkdir(output, { recursive: true });
  await rejects(stageDesktopWorkerPackage(f.input, f.destination)); assert.deepEqual(await readdir(output), []);
  await writeFile(join(output, 'worker.json'), 'PRESERVE_EXISTING');
  await rejects(stageDesktopWorkerPackage(f.input, f.destination));
  assert.equal(await readFile(join(output, 'worker.json'), 'utf8'), 'PRESERVE_EXISTING');
  await rejects(stageDesktopWorkerPackage(f.input, f.input));
  await rejects(stageDesktopWorkerPackage(f.input, f.root));
  assert.deepEqual(await readFile(join(f.directory, 'worker.tar')), f.worker);
});

test('every destination worker source and required security profile must match before a runtime tree is created', async t => {
  const f = await fixture(t, true);
  for (const file of workerSourceFiles) {
    const path = join(f.destination, 'worker', file); await writeFile(path, `${f.sources[file]}different`);
    await rejects(stageDesktopWorkerPackage(f.input, f.destination));
    assert.deepEqual(await readdir(f.destination), ['worker']); await writeFile(path, f.sources[file]);
  }
  for (const [file, original] of Object.entries(f.profiles)) {
    const path = join(f.destination, 'worker', 'security', file); await writeFile(path, '{}');
    await rejects(stageDesktopWorkerPackage(f.input, f.destination));
    assert.deepEqual(await readdir(f.destination), ['worker']); await writeFile(path, original);
  }
});

test('package provider ownership/identity and source hashes are validated rather than trusting images.json', async t => {
  const f = await fixture(t);
  await writeFile(join(f.input, 'worker', 'entry.mjs'), '// changed source');
  await rejects(inspectDesktopWorkerPackage(f.input));
  await rejects(stageDesktopWorkerPackage(f.input, f.destination)); assert.deepEqual(await readdir(f.destination), ['worker']);
  await writeFile(join(f.input, 'worker', 'entry.mjs'), f.sources['entry.mjs']);
  await writeFile(join(f.directory, 'worker.json'), JSON.stringify({ ...f.provider, workspaceKey: 'FOREIGN_OWNER' }));
  await rejects(inspectDesktopWorkerPackage(f.input));
  await rm(join(f.directory, 'worker.json')); await rejects(inspectDesktopWorkerPackage(f.input));
});

test('package entry points reject relative and Windows alias paths without creating output', async t => {
  const f = await fixture(t);
  for (const input of ['resources', `${f.input}${sep}..${sep}resources`, 'bad\0path',
    ...(process.platform === 'win32' ? ['C:resources', '\\\\localhost\\c$\\resources', `${f.input}.`] : [])]) {
    await rejects(inspectDesktopWorkerPackage(input)); await rejects(stageDesktopWorkerPackage(input, f.destination));
  }
  assert.deepEqual(await readdir(f.destination), ['worker']);
});

test('staging rejects package changes after capacity preflight before creating the runtime tree', async t => {
  const f = await fixture(t), expected = await inspectDesktopWorkerPackage(f.input);
  const changed = Buffer.concat([f.worker, Buffer.from('extra bytes after preflight')]);
  await writeFile(join(f.directory, 'worker.tar'), changed);
  await f.saveImages({ version: 1, images: [{ ...f.images.images[0], ...pin(changed) }] });
  assert.ok((await inspectDesktopWorkerPackage(f.input)).bytes > expected.bytes);
  await rejects(stageDesktopWorkerPackage(f.input, f.destination, expected));
  assert.deepEqual(await readdir(f.destination), ['worker']);
});
