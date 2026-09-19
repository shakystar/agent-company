import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { createServer } from 'node:net';
import { DesktopCodexProviderError, resolveDesktopCodexProvider } from '../server/desktop-codex-provider.ts';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: test.TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'ac-desktop-provider-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, '설치 자원'), directory = join(root, 'providers', 'codex');
  await mkdir(directory, { recursive: true });
  const binary = Buffer.alloc(192 * 1024 + 37, 0x5a), license = 'Small license fixture\n';
  binary[65_537] = 0x01; binary[binary.length - 1] = 0xab;
  const manifest = { schemaVersion: 1, provider: 'codex', version: '0.154.0', target: 'x86_64-pc-windows-msvc',
    executable: { file: 'codex.exe', bytes: binary.length, sha256: hash(binary) },
    license: { file: 'LICENSE', bytes: Buffer.byteLength(license), sha256: hash(license) } };
  const manifestPath = join(directory, 'provider.json');
  const save = async (value: unknown = manifest) => writeFile(manifestPath, JSON.stringify(value));
  await writeFile(join(directory, 'codex.exe'), binary);
  await writeFile(join(directory, 'LICENSE'), license);
  await save();
  return { temporary, root, directory, binary, license, manifest, manifestPath, save };
}
async function invalid(root: string): Promise<void> {
  await assert.rejects(resolveDesktopCodexProvider(root), error => {
    assert.ok(error instanceof DesktopCodexProviderError);
    assert.equal(error.code, 'CODEX_PROVIDER_INVALID');
    assert.equal(error.message, 'CODEX_PROVIDER_INVALID');
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
    if (root) assert.ok(!JSON.stringify(error).includes(root));
    return true;
  });
}

test('bundled provider validates multi-chunk bytes and license, preserving installation files across resolution', async t => {
  const f = await fixture(t);
  const before = await Promise.all(['provider.json', 'codex.exe', 'LICENSE'].map(name => readFile(join(f.directory, name))));
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await resolveDesktopCodexProvider(f.root), {
      executable: join(f.directory, 'codex.exe'), version: '0.154.0', sha256: hash(f.binary),
    });
  }
  assert.deepEqual(await Promise.all(['provider.json', 'codex.exe', 'LICENSE'].map(name => readFile(join(f.directory, name)))), before);
  assert.deepEqual((await readdir(f.directory)).sort(), ['LICENSE', 'codex.exe', 'provider.json']);
  const upper = structuredClone(f.manifest); upper.executable.sha256 = upper.executable.sha256.toUpperCase();
  upper.license.sha256 = upper.license.sha256.toUpperCase(); await f.save(upper);
  assert.equal((await resolveDesktopCodexProvider(f.root))?.sha256, hash(f.binary));
});

test('absent fixed provider manifest returns null without adopting a neighboring executable or creating files', async t => {
  const f = await fixture(t);
  await rm(f.manifestPath);
  await writeFile(join(f.root, 'provider.json'), JSON.stringify(f.manifest));
  await writeFile(join(f.root, 'codex.exe'), f.binary);
  assert.equal(await resolveDesktopCodexProvider(f.root), null);
  await rm(f.directory, { recursive: true });
  assert.equal(await resolveDesktopCodexProvider(f.root), null);
  await rm(join(f.root, 'providers'), { recursive: true });
  assert.equal(await resolveDesktopCodexProvider(f.root), null);
  assert.deepEqual((await readdir(f.root)).sort(), ['codex.exe', 'provider.json']);
  await invalid(join(f.root, 'absent-resource-root'));
});

test('manifest schema rejects changed identity, target, filenames, unknown keys and unsafe sizes before binary use', async t => {
  const f = await fixture(t);
  const cases: unknown[] = [null, [], { ...f.manifest, schemaVersion: 2 }, { ...f.manifest, provider: 'other' },
    { ...f.manifest, version: '0.153.4' }, { ...f.manifest, target: 'aarch64-pc-windows-msvc' },
    { ...f.manifest, privatePath: f.root }, { ...f.manifest, license: undefined }];
  for (const field of ['executable', 'license'] as const) {
    for (const patch of [{ file: '../codex.exe' }, { file: join(f.root, 'other.exe') }, { file: 'CODEX.EXE' },
      { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
      { bytes: field === 'executable' ? 512 * 1024 * 1024 + 1 : 1024 * 1024 + 1 },
      { sha256: 'a'.repeat(63) }, { sha256: 'z'.repeat(64) }, { extra: true }]) {
      cases.push({ ...f.manifest, [field]: { ...f.manifest[field], ...patch } });
    }
  }
  for (const value of cases) { await f.save(value); await invalid(f.root); }
});

test('empty, malformed, invalid UTF-8 and oversized manifests are rejected with fixed errors', async t => {
  const f = await fixture(t);
  for (const value of [Buffer.alloc(0), Buffer.from('{private broken content'), Buffer.from([0xff, 0xfe]), Buffer.alloc(16 * 1024 + 1, 0x20)]) {
    await writeFile(f.manifestPath, value); await invalid(f.root);
    assert.deepEqual(await readFile(f.manifestPath), value);
  }
});

test('both executable and license require exact bytes, hashes and existing independent regular files', async t => {
  const f = await fixture(t);
  for (const [name, original] of [['codex.exe', f.binary], ['LICENSE', Buffer.from(f.license)]] as const) {
    const path = join(f.directory, name), changed = Buffer.from(original);
    changed[changed.length - 1] ^= 0xff;
    for (const value of [changed, original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from('x')]), Buffer.alloc(0)]) {
      await writeFile(path, value); await invalid(f.root);
    }
    await rm(path); await invalid(f.root);
    await mkdir(path); await invalid(f.root);
    await rm(path, { recursive: true }); await writeFile(path, original);
  }
  await writeFile(join(f.directory, 'LICENSE'), Buffer.alloc(1024 * 1024 + 1));
  await invalid(f.root);
  await rm(f.manifestPath); await mkdir(f.manifestPath); await invalid(f.root);
});

test('all three fixed provider files reject hard links without modifying outside targets', async t => {
  const f = await fixture(t);
  for (const name of ['provider.json', 'codex.exe', 'LICENSE']) {
    const path = join(f.directory, name), original = await readFile(path), outside = join(f.temporary, `outside-${name}`);
    await writeFile(outside, original); await rm(path); await link(outside, path);
    await invalid(f.root);
    assert.deepEqual(await readFile(outside), original);
    assert.equal((await lstat(path)).nlink, 2);
    await rm(path); await writeFile(path, original);
  }
});

test('resource ancestors, provider directories and fixed files cannot redirect through links', async t => {
  const f = await fixture(t), type = process.platform === 'win32' ? 'junction' : 'dir';
  const alias = join(f.temporary, 'alias');
  await symlink(f.root, alias, type); await invalid(alias);
  await invalid(join(alias, 'providers'));
  await rm(alias);
  for (const name of ['provider.json', 'codex.exe', 'LICENSE']) {
    const path = join(f.directory, name), original = await readFile(path);
    await rm(path); await symlink(f.temporary, path, type);
    await invalid(f.root);
    assert.ok((await lstat(path)).isSymbolicLink());
    await rm(path); await writeFile(path, original);
  }
  const outside = join(f.temporary, 'outside'); await mkdir(outside);
  await rm(f.directory, { recursive: true }); await symlink(outside, f.directory, type);
  await invalid(f.root); assert.deepEqual(await readdir(outside), []);
  await rm(f.directory); await rmdir(join(f.root, 'providers'));
  await symlink(outside, join(f.root, 'providers'), type); await invalid(f.root);
});

test('unsafe resource inputs fail without filesystem fallback', async t => {
  const f = await fixture(t);
  for (const value of ['', 'relative', parse(f.root).root, `${f.root}\0`, `${f.root}${sep}..`, `${f.root}${sep}.`]) await invalid(value);
  if (process.platform === 'win32') {
    for (const value of ['C:relative', '\\root-relative', '\\\\host\\share\\resource', '\\\\?\\C:\\resource', '\\\\.\\C:\\resource',
      `${f.root}\\file:stream`, `${f.root}\\NUL`, `${f.root}\\COM1.txt`, `${f.root}\\name.`, `${f.root}\\name `]) await invalid(value);
  }
});

test('a special socket file at the manifest path is rejected without reading or connecting', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await rm(f.manifestPath);
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(f.manifestPath, resolve); });
  try { await invalid(f.root); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
