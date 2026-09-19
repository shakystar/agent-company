import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectDesktopRustNotices } from '../scripts/desktop-rust-notices.ts';

const source = 'registry+https://github.com/rust-lang/crates.io-index';
type FixturePackage = { id: string; name: string; version: string; source: string | null; license: string | null; license_file: string | null; manifest_path: string };
type FixtureNode = { id: string; dependencies: string[]; deps?: Array<{ name: string; pkg: string }> };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-rust-notices-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /ac-rust-notices-[^\\/]+$/); await rm(root, { recursive: true, force: true }); });
  const project: FixturePackage = { id: `path+file://${root}/PRIVATE_PROJECT#project@1.0.0`, name: 'project', version: '1.0.0', source: null,
    license: null, license_file: null, manifest_path: join(root, 'project', 'Cargo.toml') };
  const packages = [project], nodes: FixtureNode[] = [{ id: project.id, dependencies: [] }];
  const metadata = { version: 1, packages, resolve: { root: project.id, nodes }, extraFutureField: true };
  const crate = async (name: string, license: string | null = 'MIT') => {
    const location = join(root, name); await mkdir(location); await writeFile(join(location, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "1.0.0"\n`);
    const pkg: FixturePackage = { id: `${source}#${name}@1.0.0`, name, version: '1.0.0', source, license, license_file: null, manifest_path: join(location, 'Cargo.toml') };
    packages.push(pkg); const node: FixtureNode = { id: pkg.id, dependencies: [] }; nodes.push(node); nodes[0].dependencies.push(pkg.id);
    const file = async (path: string, data: string | Buffer = 'Original license text.\r\n') => {
      const target = join(location, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, data); return target;
    };
    return { pkg, node, location, file };
  };
  return { root, metadata, project, crate };
}

test('Cargo notice collector follows root closure, excludes project and unused packages, and preserves exact nested originals', async t => {
  const f = await fixture(t), a = await f.crate('first'), b = await f.crate('second', 'MIT OR Apache-2.0'), unused = await f.crate('unused');
  f.metadata.resolve.nodes[0].dependencies = [a.pkg.id]; a.node.dependencies = [b.pkg.id]; b.node.dependencies = [a.pkg.id];
  const bytes = Buffer.from('\uFEFFCopyright fixture\r\nExact original text.\n', 'utf8');
  await a.file('LICENSE', bytes); await a.file('src/third-party/notices/vendor-one/terms.txt', 'Vendor original.');
  await a.file('COPYING.txt', 'Copying original.'); await a.file('README.md', 'PRIVATE_UNRELATED_FILE');
  b.pkg.license_file = 'legal/custom.txt'; await b.file('legal/custom.txt', 'Declared original.');
  await b.file('AUTHORS', 'Fixture authors'); await b.file('NOTICE.md', 'Fixture notice'); await b.file('COPYRIGHT', 'Fixture copyright');
  await unused.file('LICENSE', 'MUST_NOT_COLLECT');
  const result = await collectDesktopRustNotices(f.metadata);
  assert.deepEqual(result.components.map(c => c.name), ['first', 'second']);
  assert.deepEqual(result.components[0].files.map(file => file.path), ['COPYING.txt', 'LICENSE', 'src/third-party/notices/vendor-one/terms.txt']);
  assert.deepEqual(result.components[0].files.find(file => file.path === 'LICENSE')!.data, bytes);
  assert.deepEqual(result.components[1].files.map(file => file.path), ['AUTHORS', 'COPYRIGHT', 'NOTICE.md', 'legal/custom.txt']);
  assert.deepEqual(result.components.flatMap(c => c.issues), []);
  assert.ok(result.components.every(c => c.ecosystem === 'cargo' && c.source === source && c.id.startsWith(`cargo:${c.name}@1.0.0#`)));
  assert.deepEqual(result.issues, ['CARGO_SOURCE_AND_LOCK_CHECKSUMS_NOT_VERIFIED', 'CARGO_METADATA_CLOSURE_IS_NOT_A_LINKED_BINARY_INVENTORY']);
  const serialized = JSON.stringify(result); assert.ok(!serialized.includes(f.root)); assert.ok(!serialized.includes('PRIVATE')); assert.ok(!serialized.includes('MUST_NOT_COLLECT'));
  assert.deepEqual(await readFile(join(a.location, 'LICENSE')), bytes);
});

test('Cargo notice collector rejects malformed, duplicate, unknown and missing graph entries with a fixed redacted error', async t => {
  const f = await fixture(t), a = await f.crate('dep'); await a.file('LICENSE');
  const clone = () => structuredClone(f.metadata);
  const missingPackage = clone(); missingPackage.packages.pop();
  const missingNode = clone(); missingNode.resolve.nodes.pop();
  const unknownEdge = clone(); unknownEdge.resolve.nodes[0].dependencies.push('PRIVATE_UNKNOWN_ID');
  const duplicatePackage = clone(); duplicatePackage.packages.push(duplicatePackage.packages[1]);
  const duplicateNode = clone(); duplicateNode.resolve.nodes.push(duplicateNode.resolve.nodes[1]);
  const duplicateEdge = clone(); duplicateEdge.resolve.nodes[0].dependencies.push(a.pkg.id);
  const wrongAlternative = clone(); wrongAlternative.resolve.nodes[0].deps = [{ name: 'dep', pkg: 'PRIVATE_UNKNOWN_ID' }];
  const malformedLicense = clone(); malformedLicense.packages[1].license = 'C:\\PRIVATE\\license.txt';
  const duplicateIdentity = clone(); duplicateIdentity.packages.push({ ...a.pkg, id: 'alternate-id' }); duplicateIdentity.resolve.nodes.push({ id: 'alternate-id', dependencies: [] }); duplicateIdentity.resolve.nodes[0].dependencies.push('alternate-id');
  const throwingInput = { get version(): never { throw new Error('PRIVATE_INPUT_GETTER'); } };
  for (const metadata of [null, [], {}, throwingInput, { ...clone(), version: 2 }, { ...clone(), resolve: null }, { ...clone(), resolve: { ...clone().resolve, root: 'PRIVATE_UNKNOWN_ROOT' } },
    missingPackage, missingNode, unknownEdge, duplicatePackage, duplicateNode, duplicateEdge, wrongAlternative, malformedLicense, duplicateIdentity]) {
    await assert.rejects(collectDesktopRustNotices(metadata), error => {
      assert.equal((error as { code?: string }).code, 'DESKTOP_RUST_NOTICES_METADATA_INVALID'); assert.equal((error as Error).message, 'DESKTOP_RUST_NOTICES_METADATA_INVALID'); return true;
    });
  }
});

test('Cargo notice collector supports renamed deps while rejecting non-registry or credential-bearing sources', async t => {
  const f = await fixture(t), a = await f.crate('dep'); await a.file('LICENSE');
  f.metadata.resolve.nodes[0].deps = [{ name: 'renamed_dep', pkg: a.pkg.id }];
  assert.equal((await collectDesktopRustNotices(f.metadata)).components.length, 1);
  for (const invalidSource of [null, 'git+https://example.test/repository', 'registry+file:///PRIVATE', 'registry+https://user:PRIVATE@example.test/index',
    'registry+https://example.test/index?token=PRIVATE', 'registry+https://example.test/index#PRIVATE']) {
    a.pkg.source = invalidSource;
    await assert.rejects(collectDesktopRustNotices(f.metadata), { code: 'DESKTOP_RUST_NOTICES_SOURCE_UNSUPPORTED' });
  }
  a.pkg.source = 'sparse+https://index.example.test/';
  assert.equal((await collectDesktopRustNotices(f.metadata)).components[0].source, a.pkg.source);
});

test('missing, empty and malformed notices remain explicit issues without inventing license text', async t => {
  const f = await fixture(t), missing = await f.crate('missing', null), damaged = await f.crate('damaged');
  missing.pkg.license_file = 'legal/missing.txt';
  await damaged.file('LICENSE', Buffer.from([0xc3, 0x28])); await damaged.file('NOTICE', ''); await damaged.file('COPYING', 'nul\0binary');
  const result = await collectDesktopRustNotices(f.metadata), first = result.components.find(c => c.name === 'missing')!, second = result.components.find(c => c.name === 'damaged')!;
  assert.deepEqual(first.files, []); assert.deepEqual(first.issues, ['LICENSE_EXPRESSION_MISSING', 'DECLARED_LICENSE_FILE_UNREADABLE', 'NOTICE_FILES_MISSING']);
  assert.deepEqual(second.files, []); assert.ok(second.issues.includes('NOTICE_FILE_UNREADABLE')); assert.ok(second.issues.includes('NOTICE_FILE_EMPTY')); assert.ok(second.issues.includes('NOTICE_FILES_MISSING'));
});

test('declared license paths cannot escape crate root or use absolute paths, aliases, streams or traversal', async t => {
  const f = await fixture(t), a = await f.crate('dep'); await writeFile(join(f.root, 'PRIVATE_LICENSE'), 'MUST_NOT_READ');
  for (const path of ['../PRIVATE_LICENSE', '..\\PRIVATE_LICENSE', '/PRIVATE_LICENSE', 'C:\\PRIVATE_LICENSE', 'C:PRIVATE_LICENSE',
    '\\\\server\\share\\PRIVATE_LICENSE', 'legal/../PRIVATE_LICENSE', 'LICENSE:stream', 'LICENSE.', 'CON', '']) {
    a.pkg.license_file = path; const result = await collectDesktopRustNotices(f.metadata), component = result.components[0];
    assert.deepEqual(component.files, []); assert.ok(component.issues.includes('DECLARED_LICENSE_FILE_UNSAFE')); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  a.pkg.license_file = 'legal\\original.txt'; await a.file('legal/original.txt', 'Original.');
  assert.equal((await collectDesktopRustNotices(f.metadata)).components[0].files[0].path, 'legal/original.txt');
});

test('notice hard links and redirected directory parents are reported without following outside files', async t => {
  const f = await fixture(t), hard = await f.crate('hard'), redirected = await f.crate('redirected');
  const original = await hard.file('LICENSE', 'PUBLIC_LINK_FIXTURE'); await link(original, join(f.root, 'hardlink'));
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'LICENSE'), 'PRIVATE_OUTSIDE');
  await symlink(outside, join(redirected.location, 'licenses'), process.platform === 'win32' ? 'junction' : 'dir');
  redirected.pkg.license_file = 'licenses/LICENSE';
  const result = await collectDesktopRustNotices(f.metadata);
  assert.ok(result.components.find(c => c.name === 'hard')!.issues.includes('NOTICE_FILE_UNREADABLE'));
  const bad = result.components.find(c => c.name === 'redirected')!;
  assert.ok(bad.issues.includes('NOTICE_TREE_LINK_REJECTED')); assert.ok(bad.issues.includes('DECLARED_LICENSE_FILE_UNREADABLE')); assert.deepEqual(bad.files, []);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const real = await f.crate('real'); await real.file('LICENSE');
  await symlink(real.location, join(f.root, 'redirect-root'), process.platform === 'win32' ? 'junction' : 'dir');
  real.pkg.manifest_path = join(f.root, 'redirect-root', 'Cargo.toml');
  assert.ok((await collectDesktopRustNotices(f.metadata)).components.find(c => c.name === 'real')!.issues.includes('CRATE_MANIFEST_OR_ROOT_UNREADABLE'));
});

test('file-size bounds are reported and total notice bounds fail without large fixture storage', async t => {
  const f = await fixture(t), a = await f.crate('large'); await a.file('LICENSE', Buffer.alloc(1024 * 1024 + 1, 0x41));
  const oversized = await collectDesktopRustNotices(f.metadata); assert.ok(oversized.components[0].issues.includes('NOTICE_FILE_UNREADABLE')); assert.deepEqual(oversized.components[0].files, []);
  await a.file('LICENSE', Buffer.alloc(1024 * 1024, 0x41));
  // Distinct metadata components share one read-only fixture source directory. Metadata alone is not source authentication.
  for (let index = 1; index <= 32; index++) {
    const name = `dep${index}`, id = `${source}#${name}@1.0.0`; f.metadata.packages.push({ ...a.pkg, name, id });
    f.metadata.resolve.nodes.push({ id, dependencies: [] }); f.metadata.resolve.nodes[0].dependencies.push(id);
  }
  await assert.rejects(collectDesktopRustNotices(f.metadata), { code: 'DESKTOP_RUST_NOTICES_LIMIT' });
});

test('bounded recursive traversal reports a skipped deep notice subtree and keeps other originals', async t => {
  const f = await fixture(t), a = await f.crate('dep'); await a.file('LICENSE', 'Root license');
  await a.file(`${Array.from({ length: 25 }, () => 'd').join('/')}/NOTICE`, 'Deep notice');
  const component = (await collectDesktopRustNotices(f.metadata)).components[0];
  assert.deepEqual(component.files.map(file => file.path), ['LICENSE']); assert.ok(component.issues.includes('NOTICE_SCAN_DEPTH_LIMIT'));
});
