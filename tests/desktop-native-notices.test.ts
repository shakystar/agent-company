import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from '../server/process.ts';
import { copyDesktopPayload, readDesktopPayload } from '../scripts/desktop-payload.ts';
import { stageDesktopNativeNotices } from '../scripts/desktop-native-notices.ts';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-native-notices-')), projectRoot = join(root, 'project'), source = join(root, 'source'), destination = join(root, 'new-native');
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /ac-native-notices-[^\\/]+$/); await rm(root, { recursive: true, force: true }); });
  const cargoDir = join(projectRoot, 'desktop/src-tauri'); await mkdir(cargoDir, { recursive: true });
  const supplementsDir = join(projectRoot, 'desktop/notices/cargo'); await mkdir(supplementsDir, { recursive: true });
  await writeFile(join(supplementsDir, 'supplements.json'), JSON.stringify({ version: 1, supplements: [] }));
  const manifestPath = join(cargoDir, 'Cargo.toml'), lockPath = join(cargoDir, 'Cargo.lock');
  const lockBytes = Buffer.from('version = 4\n# Public fixture only\n');
  await writeFile(manifestPath, '[package]\nname = "native-fixture"\nversion = "1.0.0"\n'); await writeFile(lockPath, lockBytes);
  const crate = join(root, 'registry-crate'); await mkdir(crate); await writeFile(join(crate, 'Cargo.toml'), '[package]\nname = "fixture-crate"\nversion = "1.0.0"\n');
  const originalNotice = Buffer.from('\uFEFFOriginal Rust 고지\r\n', 'utf8'); await writeFile(join(crate, 'LICENSE'), originalNotice);
  const rootId = 'path+file:///PRIVATE/project#native-fixture@1.0.0', registry = 'registry+https://github.com/rust-lang/crates.io-index', dependency = `${registry}#fixture-crate@1.0.0`;
  const metadata = { version: 1, packages: [
    { id: rootId, name: 'native-fixture', version: '1.0.0', source: null, license: null, license_file: null, manifest_path: manifestPath },
    { id: dependency, name: 'fixture-crate', version: '1.0.0', source: registry, license: 'MIT', license_file: null, manifest_path: join(crate, 'Cargo.toml') },
  ], resolve: { root: rootId, nodes: [{ id: rootId, dependencies: [dependency] }, { id: dependency, dependencies: [] }] } };
  const members = new Map([
    ['resources/server/desktop-entry.js', Buffer.from('Fixture only; never execute')],
    ['resources/dist/index.html', Buffer.from('<div>Fixture</div>')],
    ['binaries/node-x86_64-pc-windows-msvc.exe', Buffer.from('Fixture only; never execute')],
    ['resources/notices/server/THIRD-PARTY-NOTICES.txt', Buffer.from('Preserve server original')],
  ]);
  for (const [path, bytes] of members) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), bytes); }
  const manifest = { version: 1, target: 'x86_64-pc-windows-msvc', protocol: 1, entry: 'resources/server/desktop-entry.js', distributionReady: false,
    files: [...members].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
  await writeFile(join(source, 'payload-manifest.json'), JSON.stringify(manifest));
  const payload = await readDesktopPayload(source), events: string[] = [], planned: bigint[] = [];
  const runner: Command = async (file, args, options) => {
    events.push('cargo'); assert.equal(file, 'cargo');
    assert.deepEqual(args, ['metadata', '--format-version', '1', '--offline', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', manifestPath]);
    assert.equal(options?.timeoutMs, 120_000); assert.equal(options?.captureStdout, false); assert.ok(options?.onStdout);
    const bytes = Buffer.from(JSON.stringify(metadata)); await options!.onStdout!(bytes.subarray(0, 29)); await options!.onStdout!(bytes.subarray(29));
    return { code: 0, stdout: '', stderr: '' };
  };
  const assertSpace = async (directory: string, bytes: bigint) => { assert.equal(directory, root); events.push('space'); planned.push(bytes); };
  const input = { projectRoot, payload, destination, additionalBytes: 1024n };
  return { root, projectRoot, source, destination, cargoDir, lockPath, lockBytes, manifestPath, crate, originalNotice, metadata, members, payload, events, planned, runner, assertSpace, input };
}

test('native staging checks capacity before offline Cargo, preserves originals and makes native notices verified payload members', async t => {
  const f = await fixture(t), originalManifest = await readFile(join(f.source, 'payload-manifest.json'));
  const result = await stageDesktopNativeNotices(f.input, { command: f.runner, assertSpace: f.assertSpace });
  assert.deepEqual(f.events, ['space', 'cargo', 'space']); assert.equal(f.planned.length, 2);
  assert.ok(f.planned.every(bytes => bytes > f.payload.copyBytes + f.input.additionalBytes));
  const stagedBytes = await readFile(join(f.destination, 'payload-manifest.json')), staged = await readDesktopPayload(f.destination);
  assert.equal(result.sourcePayloadManifestSha256, hash(originalManifest)); assert.equal(result.payloadManifestSha256, hash(stagedBytes));
  assert.notEqual(result.payloadManifestSha256, result.sourcePayloadManifestSha256); assert.equal(result.cargoLockSha256, hash(f.lockBytes));
  assert.deepEqual(await readFile(join(f.destination, 'native-dependencies.lock')), f.lockBytes); assert.equal((await lstat(join(f.destination, 'native-dependencies.lock'))).nlink, 1);
  assert.equal(result.manifest.distributionReady, false); assert.equal(result.nativeNotices.documentsComplete, false);
  const noticePaths = ['resources/notices/native/THIRD-PARTY-NOTICES.txt', 'resources/notices/native/inventory.json'];
  assert.deepEqual(staged.manifest.files.filter(file => file.path.startsWith('resources/notices/native/')).map(file => file.path).sort(), noticePaths);
  const text = await readFile(join(f.destination, noticePaths[0])); assert.ok(text.includes(f.originalNotice));
  const inventory = JSON.parse(await readFile(join(f.destination, noticePaths[1]), 'utf8'));
  assert.equal(inventory.components.length, 1); assert.equal(inventory.distributionReady, false);
  assert.ok(inventory.issues.includes('CARGO_METADATA_CLOSURE_IS_NOT_A_LINKED_BINARY_INVENTORY'));
  assert.ok(!JSON.stringify(inventory).includes('PRIVATE')); assert.ok(!JSON.stringify(inventory).includes(f.root));
  const copy = join(f.root, 'verified-copy'); await mkdir(copy); await copyDesktopPayload(staged, copy);
  for (const file of staged.manifest.files) assert.deepEqual(await readFile(join(copy, file.path)), await readFile(join(f.destination, file.path)));
  assert.deepEqual(await readFile(join(f.source, 'payload-manifest.json')), originalManifest);
  assert.deepEqual(await readFile(join(f.crate, 'LICENSE')), f.originalNotice);
});

test('either capacity gate refuses work before creating a candidate and the first gate prevents Cargo entirely', async t => {
  for (const blocked of [1, 2]) {
    const f = await fixture(t); let calls = 0;
    await assert.rejects(stageDesktopNativeNotices(f.input, { command: f.runner, assertSpace: async (directory, bytes) => {
      await f.assertSpace(directory, bytes); if (++calls === blocked) throw new Error('SPACE_FIXTURE');
    } }), /SPACE_FIXTURE/);
    assert.deepEqual(f.events, blocked === 1 ? ['space'] : ['space', 'cargo', 'space']);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  }
});

test('Cargo lock or manifest changes during metadata and after collection are rejected instead of copying a new lock', async t => {
  for (const changed of ['lock', 'manifest', 'late-lock'] as const) {
    const f = await fixture(t); let checks = 0;
    const runner: Command = async (...args) => { const result = await f.runner(...args);
      if (changed !== 'late-lock') await writeFile(changed === 'lock' ? f.lockPath : f.manifestPath, 'PRIVATE_CHANGED_INPUT'); return result; };
    await assert.rejects(stageDesktopNativeNotices(f.input, { command: runner, assertSpace: async (directory, bytes) => {
      await f.assertSpace(directory, bytes); if (++checks === 2 && changed === 'late-lock') await writeFile(f.lockPath, 'PRIVATE_CHANGED_INPUT');
    } }), { code: 'DESKTOP_NATIVE_CARGO_INPUT_CHANGED' });
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  }
});

test('Cargo nonzero, malformed output and another project fail with redacted errors before candidate creation', async t => {
  for (const failed of ['exit', 'throw', 'utf8', 'project'] as const) {
    const f = await fixture(t);
    const runner: Command = async (file, args, options) => {
      if (failed === 'throw') throw new Error('PRIVATE_CARGO_STDERR');
      if (failed === 'exit') return { code: 1, stdout: '', stderr: 'PRIVATE_CARGO_STDERR' };
      if (failed === 'utf8') { await options!.onStdout!(Buffer.from([0xff])); return { code: 0, stdout: '', stderr: '' }; }
      f.metadata.packages[0].manifest_path = join(f.root, 'PRIVATE_OTHER/Cargo.toml'); return f.runner(file, args, options);
    };
    await assert.rejects(stageDesktopNativeNotices(f.input, { command: runner, assertSpace: f.assertSpace }), error => {
      assert.equal((error as { code?: string }).code, 'DESKTOP_NATIVE_CARGO_METADATA_FAILED'); assert.ok(!(error as Error).message.includes('PRIVATE')); return true;
    });
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  }
});

test('existing candidates and an existing native notice namespace are never replaced or adopted', async t => {
  const f = await fixture(t); await mkdir(f.destination); await writeFile(join(f.destination, 'preserve'), 'Original candidate');
  await assert.rejects(stageDesktopNativeNotices(f.input, { command: f.runner, assertSpace: f.assertSpace }), { code: 'DESKTOP_NATIVE_NOTICES_INVALID' });
  assert.deepEqual(f.events, []); assert.equal(await readFile(join(f.destination, 'preserve'), 'utf8'), 'Original candidate');
  const next = await fixture(t);
  const manifest = JSON.parse(next.payload.manifestBytes.toString('utf8'));
  manifest.files.push({ path: 'resources/notices/native/old.txt', bytes: 0, sha256: hash(Buffer.alloc(0)) });
  next.input.payload = { ...next.payload, manifestBytes: Buffer.from(JSON.stringify(manifest)) };
  await assert.rejects(stageDesktopNativeNotices(next.input, { command: next.runner, assertSpace: next.assertSpace }), { code: 'DESKTOP_NATIVE_NOTICES_INVALID' });
  assert.deepEqual(next.events, []); await assert.rejects(lstat(next.destination), { code: 'ENOENT' });
});

test('missing Rust originals remain component issues in the newly packaged inventory', async t => {
  const f = await fixture(t); await rm(join(f.crate, 'LICENSE'));
  const result = await stageDesktopNativeNotices(f.input, { command: f.runner, assertSpace: f.assertSpace });
  assert.equal(result.nativeNotices.documentsComplete, false);
  const inventory = JSON.parse(await readFile(join(f.destination, 'resources/notices/native/inventory.json'), 'utf8'));
  assert.deepEqual(inventory.components[0].files, []); assert.ok(inventory.components[0].issues.includes('NOTICE_FILES_MISSING'));
  assert.deepEqual((await readdir(f.source)).sort(), ['binaries', 'payload-manifest.json', 'resources']);
});

test('native staging includes pinned supplemental originals and rejects a changed supplement before any candidate copy', async t => {
  for (const changed of [false, true]) {
    const f = await fixture(t); await rm(join(f.crate, 'LICENSE'));
    const directory = join(f.projectRoot, 'desktop/notices/cargo'), path = join(directory, 'UPSTREAM-LICENSE');
    await writeFile(path, f.originalNotice);
    const pkg = f.metadata.packages[1];
    await writeFile(join(directory, 'supplements.json'), JSON.stringify({ version: 1, supplements: [{
      ecosystem: 'cargo', name: pkg.name, version: pkg.version, source: pkg.source, basis: 'Public fixture upstream source',
      documents: [{ file: 'UPSTREAM-LICENSE', bytes: f.originalNotice.length, sha256: hash(f.originalNotice), url: 'https://example.org/LICENSE' }],
    }] }));
    let checks = 0;
    const pending = stageDesktopNativeNotices(f.input, { command: f.runner, assertSpace: async (directory, bytes) => {
      await f.assertSpace(directory, bytes); if (++checks === 2 && changed) await writeFile(path, 'Changed notice');
    } });
    if (changed) { await assert.rejects(pending); await assert.rejects(lstat(f.destination), { code: 'ENOENT' }); continue; }
    const result = await pending; assert.equal(result.nativeNotices.supplements.applied, 1);
    const inventory = JSON.parse(await readFile(join(f.destination, 'resources/notices/native/inventory.json'), 'utf8'));
    assert.equal(inventory.components[0].files.length, 1); assert.deepEqual(inventory.components[0].issues, []);
    assert.equal(inventory.components[0].supplementalSources[0].documents[0].sha256, hash(f.originalNotice));
    assert.equal(inventory.distributionReady, false); assert.equal(inventory.documentsComplete, false);
  }
});
