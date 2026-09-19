import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { EnvironmentSpec } from '../shared/environment.ts';

const { validateSpec, validateLockfile, npmArguments, assertNpmPolicyDefinitions, installBundle, verifyBundle, contentHash, callMcp } = await import(new URL('../worker/environment.mjs', import.meta.url).href);
const spec: EnvironmentSpec = { packages: [{ name: 'test-mcp', version: '1.2.3' }], servers: [{ name: 'echo', package: 'test-mcp', bin: 'test-mcp', args: [], probe: { tool: 'echo', arguments: { message: 'probe' } } }] };
const lock = () => ({ lockfileVersion: 3, packages: { '': { dependencies: { 'test-mcp': '1.2.3' } }, 'node_modules/test-mcp': { version: '1.2.3', resolved: 'https://registry.npmjs.org/test-mcp/-/test-mcp-1.2.3.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } } });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-company-environment-'));
  t.after(async () => { const target = resolve(root); assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}agent-company-environment-`)); await rm(target, { recursive: true, force: true }); });
  const npm = async (folder: string, command: string) => {
    if (command === 'install') await writeFile(join(folder, 'package-lock.json'), JSON.stringify(lock()));
    else {
      const pkg = join(folder, 'node_modules', 'test-mcp'); await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'test-mcp', version: '1.2.3', type: 'module', bin: { 'test-mcp': 'index.mjs' } }));
      await copyFile(new URL('./fixtures/environment-mcp.mjs', import.meta.url), join(pkg, 'index.mjs'));
    }
  };
  return { root, npm, bundle: join(root, 'environment') };
}

test('environment specifications reject ranges, duplicate names, executable injection and omitted probes', () => {
  assert.deepEqual(validateSpec(spec), spec);
  for (const bad of [
    { ...spec, packages: [{ name: 'test-mcp', version: '^1.2.3' }] },
    { ...spec, packages: [...spec.packages, ...spec.packages] },
    { ...spec, servers: [{ ...spec.servers[0], bin: '../../node' }] },
    { ...spec, servers: [{ ...spec.servers[0], args: ['unsafe\nargument'] }] },
    { ...spec, servers: [{ ...spec.servers[0], command: 'sh' }] },
    { ...spec, servers: [{ ...spec.servers[0], probe: undefined }] },
  ]) assert.throws(() => validateSpec(bad));
});

test('every npm dependency requires exact registry tarball identity and SHA-512 integrity before ci', () => {
  assert.equal(validateLockfile(lock(), spec).lockfileVersion, 3);
  for (const patch of [
    { resolved: 'git+https://github.com/elsewhere/package.git' }, { resolved: 'https://registry.npmjs.org.evil.test/a/-/a.tgz' },
    { resolved: 'https://account:secret@registry.npmjs.org/a/-/a.tgz' }, { resolved: 'https://registry.npmjs.org/a/-/a.tgz?token=secret' },
    { integrity: 'sha1-unsafe' }, { link: true }, { inBundle: true }, { version: 'latest' },
  ]) { const changed = lock(); Object.assign(changed.packages['node_modules/test-mcp'], patch); assert.throws(() => validateLockfile(changed, spec)); }
  const changed = lock(); changed.packages[''].dependencies['test-mcp'] = '1.2.4'; assert.throws(() => validateLockfile(changed, spec));
});

test('npm commands disable scripts, bin links, inherited user configuration, git and audit', () => {
  for (const operation of ['install', 'ci']) {
    const args = npmArguments(operation);
    for (const flag of ['--ignore-scripts', '--bin-links=false', '--audit=false', '--fund=false', '--git=/bin/false', '--userconfig=/dev/null', '--globalconfig=/app/npm-empty.npmrc', '--registry=https://registry.npmjs.org/', '--allow-remote=none', '--allow-git=none', '--allow-file=none', '--allow-directory=none']) assert.ok(args.includes(flag));
    assert.notEqual(args.find((arg: string) => arg.startsWith('--userconfig=')).split('=')[1], args.find((arg: string) => arg.startsWith('--globalconfig=')).split('=')[1]);
    assert.equal(args.includes('--package-lock-only'), operation === 'install');
  }
  assert.throws(() => npmArguments('run'));
});

test('older npm policy definitions fail closed instead of accepting ignored flags', () => {
  const definitions = Object.fromEntries(['allow-remote', 'allow-git', 'allow-file', 'allow-directory'].map(name => [name, { type: ['all', 'none', 'root'] }]));
  assert.doesNotThrow(() => assertNpmPolicyDefinitions(definitions));
  for (const name of Object.keys(definitions)) {
    assert.throws(() => assertNpmPolicyDefinitions({ ...definitions, [name]: undefined }), /does not support/);
    assert.throws(() => assertNpmPolicyDefinitions({ ...definitions, [name]: { type: ['all'] } }), /does not support/);
  }
});

test('completed bundles reuse without npm, verify exact files, and reject content tampering', async t => {
  const { root, bundle, npm } = await fixture(t);
  const first = await installBundle(root, spec, npm); assert.equal(first.reused, false);
  assert.equal((await verifyBundle(bundle, spec, first)).contentHash, first.contentHash);
  assert.equal((await installBundle(root, spec, () => assert.fail('completed bundle reinstalled'))).reused, true);
  await writeFile(join(bundle, 'node_modules', 'test-mcp', 'index.mjs'), 'tampered');
  await assert.rejects(verifyBundle(bundle, spec, first), /modified/);
});

test('database object-key reordering preserves completed bundle identity, including nested probe arguments', async t => {
  const { root, bundle, npm } = await fixture(t);
  const original: EnvironmentSpec = { ...spec, servers: [{ ...spec.servers[0], probe: { tool: 'echo', arguments: { z: { second: 2, first: 1 }, message: 'probe' } } }] };
  const report = await installBundle(root, original, npm);
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  const restored = reorder(original);
  assert.notEqual(JSON.stringify(restored), JSON.stringify(original));
  assert.equal((await verifyBundle(bundle, restored, report)).contentHash, report.contentHash);
  assert.equal((await installBundle(root, restored, () => assert.fail('reordered specification triggered reinstall'))).reused, true);
});

test('installation failure keeps partial files and a retry preserves the partial directory', async t => {
  const { root, bundle, npm } = await fixture(t);
  await assert.rejects(installBundle(root, spec, async (folder: string) => { await writeFile(join(folder, 'partial.txt'), 'evidence'); throw new Error('npm failure'); }), /npm failure/);
  assert.equal(await readFile(join(bundle, 'partial.txt'), 'utf8'), 'evidence');
  await installBundle(root, spec, npm);
  const archived = (await readdir(root)).find(name => name.startsWith('environment-partial-'))!;
  assert.equal(await readFile(join(root, archived, 'partial.txt'), 'utf8'), 'evidence');
});

test('invalid lockfile prevents npm ci and a changed lockfile cannot be marked complete', async t => {
  const { root, npm } = await fixture(t); let calledCi = false;
  await assert.rejects(installBundle(root, spec, async (folder: string, operation: string) => {
    if (operation === 'ci') { calledCi = true; return; }
    const value = lock(); value.packages['node_modules/test-mcp'].resolved = 'https://evil.test/a.tgz';
    await writeFile(join(folder, 'package-lock.json'), JSON.stringify(value));
  }), /registry/);
  assert.equal(calledCi, false);
  await assert.rejects(installBundle(root, spec, async (folder: string, operation: string) => {
    await npm(folder, operation); if (operation === 'ci') await writeFile(join(folder, 'package-lock.json'), `${JSON.stringify(lock())}\n`);
  }), /changed the validated lockfile/);
});

test('bundle hashing rejects links rather than following them outside the bundle', async t => {
  const { root } = await fixture(t); await mkdir(join(root, 'tree')); await writeFile(join(root, 'private'), 'not package data');
  try { await symlink(join(root, 'private'), join(root, 'tree', 'linked')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows symlink privilege is unavailable'); return; } throw error; }
  await assert.rejects(contentHash(join(root, 'tree')), /links/);
});

test('actual local stdio initializes, lists and calls a declared tool without inherited credentials', async t => {
  const { root, bundle, npm } = await fixture(t); await installBundle(root, spec, npm);
  const server = { ...spec.servers[0], args: ['reverse'] };
  const result = await callMcp(bundle, server, { tool: 'echo', arguments: { message: 'actual-local-call' } }, { cwd: root });
  assert.deepEqual(JSON.parse(result.result.content[0].text), { value: 'actual-local-call', reverseDenied: true, authPresent: false, environmentPath: null });
  assert.equal(result.sessionMode, 'stateless-per-call'); assert.equal(result.tools[0].name, 'echo');
});

for (const [mode, message] of [
  ['wrong-id', /Unmatched/], ['spoof', /Invalid MCP JSON-RPC/], ['invalid-result', /Invalid MCP result/],
  ['oversized', /limit exceeded/], ['wrong-version', /unsupported/], ['tool-error', /returned an error/], ['cursor', /Invalid MCP tool|pagination/], ['exit', /exited/],
] as const) test(`actual local stdio rejects ${mode} without interpreting it as a worker event`, async t => {
  const { root, bundle, npm } = await fixture(t); await installBundle(root, spec, npm);
  await assert.rejects(callMcp(bundle, { ...spec.servers[0], args: [mode] }, spec.servers[0].probe, { cwd: root, timeoutMs: 3000 }), message);
});

test('actual local MCP timeout and cancellation terminate the child', async t => {
  const { root, bundle, npm } = await fixture(t); await installBundle(root, spec, npm);
  const server = { ...spec.servers[0], args: ['hang'] };
  await assert.rejects(callMcp(bundle, server, server.probe, { cwd: root, timeoutMs: 100 }), /timed out/);
  await assert.rejects(callMcp(bundle, server, server.probe, { cwd: root, signal: AbortSignal.timeout(100) }), /cancelled/);
});
