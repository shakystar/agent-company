import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDesktopProviderDirectory, inspectDesktopFile, readDesktopProviderFile, verifyPinnedDesktopArchive,
  verifyPinnedDesktopFile, verifyPinnedDesktopPayloadFile } from '../scripts/desktop-provider-files.ts';
import { desktopCodexExecutableArgument, stageDesktopCodexPackage } from '../scripts/desktop-codex-package.ts';
import source from '../desktop/providers/codex/0.154.0/source.json' with { type: 'json' };

const pin = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-provider-build-'));
  t.after(async () => {
    const rel = relative(tmpdir(), root);
    assert.ok(rel.startsWith('ac-provider-build-') && !isAbsolute(rel) && !rel.includes(sep));
    await rm(root, { recursive: true });
  });
  const bytes = Buffer.alloc(160 * 1024, 0x12); // Crosses multiple copy chunks; never executable.
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88);
  const input = join(root, '입력 파일.exe'), output = join(root, 'copy.exe');
  await writeFile(input, bytes);
  return { root, input, output, bytes, expected: pin(bytes) };
}

test('provider build copies only the pinned file, verifies all chunks and makes an independent file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'auth.json'), 'PRIVATE_FIXTURE_NOT_AN_INPUT');
  const destination = join(f.root, 'payload'); await mkdir(destination);
  const output = join(destination, 'codex.exe');
  await verifyPinnedDesktopFile(f.input, f.expected, { windowsX64Executable: true, destination: output });
  assert.deepEqual(await readFile(output), f.bytes);
  assert.deepEqual(await readdir(destination), ['codex.exe']);
  const original = await lstat(f.input), copied = await lstat(output);
  assert.equal(copied.nlink, 1); assert.notEqual(original.ino, copied.ino);
  assert.deepEqual(await readFile(f.input), f.bytes);
});

test('provider build rejects truncated, changed and wrong-hash inputs', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyPinnedDesktopFile(f.input, { ...f.expected, bytes: f.expected.bytes + 1 }), /INPUT_INVALID/);
  await assert.rejects(verifyPinnedDesktopFile(f.input, { ...f.expected, sha256: '0'.repeat(64) }), /INPUT_INVALID/);
  f.bytes[100_000] ^= 0xff; await writeFile(f.input, f.bytes);
  await assert.rejects(verifyPinnedDesktopFile(f.input, f.expected), /INPUT_INVALID/);
});

test('provider build rejects x86, malformed and truncated PE headers even if their hashes match', async t => {
  const f = await fixture(t);
  for (const kind of ['x86', 'offset', 'signature', 'short']) {
    const bytes = kind === 'short' ? Buffer.alloc(32) : Buffer.from(f.bytes);
    if (kind === 'x86') bytes.writeUInt16LE(0x14c, 68);
    if (kind === 'offset') bytes.writeUInt32LE(bytes.length - 2, 0x3c);
    if (kind === 'signature') bytes.writeUInt32LE(0, 64);
    await writeFile(f.input, bytes);
    await assert.rejects(verifyPinnedDesktopFile(f.input, pin(bytes), { windowsX64Executable: true }), /INPUT_INVALID/);
  }
});

test('provider build refuses source hard links and parent redirection', async t => {
  const f = await fixture(t);
  const hard = join(f.root, 'hard.exe'); await link(f.input, hard);
  await assert.rejects(verifyPinnedDesktopFile(f.input, f.expected), /INPUT_INVALID/);
  await rm(hard);
  const parent = join(f.root, 'real'); await mkdir(parent);
  await writeFile(join(parent, 'binary.exe'), f.bytes);
  const redirected = join(f.root, 'redirected'); await symlink(parent, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertDesktopProviderDirectory(redirected), /INPUT_INVALID/);
  await assertDesktopProviderDirectory(parent);
  await assert.rejects(verifyPinnedDesktopFile(join(redirected, 'binary.exe'), f.expected), /INPUT_INVALID/);
});

test('provider build never overwrites an existing destination or follows redirected output parents', async t => {
  const f = await fixture(t);
  await writeFile(f.output, 'PRESERVE');
  await assert.rejects(verifyPinnedDesktopFile(f.input, f.expected, { destination: f.output }), { code: 'EEXIST' });
  assert.equal(await readFile(f.output, 'utf8'), 'PRESERVE');
  const real = join(f.root, 'real'); await mkdir(real);
  const redirected = join(f.root, 'redirected'); await symlink(real, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyPinnedDesktopFile(f.input, f.expected, { destination: join(redirected, 'copy.exe') }), /INPUT_INVALID/);
  assert.deepEqual(await readdir(real), []);
});

test('provider build refuses relative/traversal/Windows alias paths before reading', async t => {
  const f = await fixture(t);
  for (const input of ['codex.exe', `${f.root}${sep}..${sep}codex.exe`, 'invalid\0name',
    ...(process.platform === 'win32' ? ['C:codex.exe', '\\\\localhost\\c$\\codex.exe', `${f.input}:stream`, `${f.input}.`] : [])]) {
    await assert.rejects(verifyPinnedDesktopFile(input, f.expected), /INPUT_INVALID/);
  }
});

test('Codex packaging pins official bytes and rejects substitute executable without creating a provider directory', async t => {
  const f = await fixture(t), resources = join(f.root, 'resources'); await mkdir(resources);
  await assert.rejects(stageDesktopCodexPackage(f.input, resources), /INPUT_INVALID/);
  assert.deepEqual(await readdir(resources), []);
  assert.equal(source.executable.sha256, 'be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde');
  assert.equal(source.executable.bytes, 298169136);
  assert.equal(source.commit, '6b9826e3aa83b1a5947db50f4332cb9c65f1b340');
  for (const notice of source.notices) {
    await verifyPinnedDesktopFile(fileURLToPath(new URL(`../desktop/providers/codex/0.154.0/${notice.file}`, import.meta.url)), notice);
  }
  assert.deepEqual(source.notices.map(notice => notice.file), ['LICENSE', 'NOTICE', 'LICENSE.wezterm',
    'LICENSE.imagegen', 'LICENSE.openai-docs', 'LICENSE.skill-creator', 'LICENSE.skill-installer',
    'LICENSE.ratatui', 'LICENSE.syntect', 'LICENSE.onig', 'LICENSE.onig-sys', 'LICENSE.oniguruma',
    'LICENSE.aws-lc-rs', 'LICENSE.aws-lc-sys', 'LICENSE.aws-lc', 'LICENSE.aws-lc-fiat',
    'LICENSE.aws-lc-s2n-bignum', 'LICENSE.aws-lc-jitterentropy', 'LICENSE.aws-lc-jitterentropy-bsd',
    'LICENSE.sqlx-apache', 'LICENSE.sqlx-mit', 'LICENSE.libsqlite3-sys', 'LICENSE.zstd',
    'LICENSE.zstd-safe-apache', 'LICENSE.zstd-safe-mit', 'LICENSE.zstd-sys-apache',
    'LICENSE.zstd-sys-mit', 'LICENSE.zstd-sys-bsd', 'LICENSE.zstd-native', 'LICENSE.zstd-native-gpl-2.0',
    'NOTICE.sqlite-source', 'NOTICE.zstd-xxhash']);
});

test('Codex build option is explicit and rejects unknown, repeated or missing arguments', () => {
  assert.equal(desktopCodexExecutableArgument([]), null);
  assert.equal(desktopCodexExecutableArgument(['--codex-executable', 'C:/explicit/codex.exe']), 'C:/explicit/codex.exe');
  for (const args of [['--codex-executable'], ['--codex-executable', ''], ['--codex-package', 'host'],
    ['--codex-executable', 'a', '--codex-executable', 'b']]) assert.throws(() => desktopCodexExecutableArgument(args));
});

test('bounded provider reads return checked bytes, including empty source files, and reject hard links', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readDesktopProviderFile(f.input, 2 * 1024 * 1024), { data: f.bytes, pin: f.expected });
  await assert.rejects(readDesktopProviderFile(f.input, f.bytes.length - 1), /INPUT_INVALID/);
  await assert.rejects(readDesktopProviderFile(f.input, 2 * 1024 * 1024 + 1), /INPUT_INVALID/);
  await link(f.input, f.output); await assert.rejects(readDesktopProviderFile(f.input, 2 * 1024 * 1024), /INPUT_INVALID/);
  await rm(f.output); await writeFile(f.input, '');
  assert.deepEqual(await readDesktopProviderFile(f.input, 1), { data: Buffer.alloc(0), pin: pin(Buffer.alloc(0)) });
});

test('archive copy streams independently while preserving the executable cap and its separate archive ceiling', async t => {
  const f = await fixture(t);
  await verifyPinnedDesktopArchive(f.input, f.expected, { destination: f.output });
  assert.deepEqual(await readFile(f.output), f.bytes); assert.equal((await lstat(f.output)).nlink, 1);
  await assert.rejects(verifyPinnedDesktopFile(f.input, { ...f.expected, bytes: 512 * 1024 * 1024 + 1 }), /INPUT_INVALID/);
  for (const bytes of [0, 1.5, 8 * 1024 ** 3 + 1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(verifyPinnedDesktopArchive(f.input, { ...f.expected, bytes }), /INPUT_INVALID/);
  }
  await assert.rejects(verifyPinnedDesktopArchive(f.input, { ...f.expected, sha256: '0'.repeat(64) }), /INPUT_INVALID/);
});

test('payload inventory hashes every chunk, permits an empty file and rejects bounds and links', async t => {
  const f = await fixture(t);
  assert.deepEqual(await inspectDesktopFile(f.input), f.expected);
  await assert.rejects(inspectDesktopFile(f.input, f.expected.bytes - 1), /INPUT_INVALID/);
  await assert.rejects(inspectDesktopFile(f.input, 8 * 1024 ** 3 + 1), /INPUT_INVALID/);
  await link(f.input, f.output); await assert.rejects(inspectDesktopFile(f.input), /INPUT_INVALID/); await rm(f.output);
  await writeFile(f.input, ''); assert.deepEqual(await inspectDesktopFile(f.input, 0), pin(Buffer.alloc(0)));
});

test('payload copy supports an independent empty member without weakening archive or executable requirements', async t => {
  const f = await fixture(t); await writeFile(f.input, '');
  const empty = pin(Buffer.alloc(0));
  await verifyPinnedDesktopPayloadFile(f.input, empty, { destination: f.output });
  assert.equal((await lstat(f.output)).nlink, 1); assert.equal((await readFile(f.output)).length, 0);
  await assert.rejects(verifyPinnedDesktopPayloadFile(f.input, empty, { destination: f.output }), { code: 'EEXIST' });
  await assert.rejects(verifyPinnedDesktopArchive(f.input, empty), /INPUT_INVALID/);
  await assert.rejects(verifyPinnedDesktopFile(f.input, empty), /INPUT_INVALID/);
  for (const bytes of [-1, 1.5, 8 * 1024 ** 3 + 1]) {
    await assert.rejects(verifyPinnedDesktopPayloadFile(f.input, { ...empty, bytes }), /INPUT_INVALID/);
  }
  await assert.rejects(verifyPinnedDesktopPayloadFile(f.input, { ...empty, sha256: '0'.repeat(64) }), /INPUT_INVALID/);
});
