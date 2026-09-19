import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, lstat, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = join(root, 'scripts/stage-desktop-native.ts');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const run = (source: string, native: string) => exec(process.execPath, ['--import', 'tsx', script, source, native], { cwd: root, windowsHide: true });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ac-staging-'));
  const source = join(directory, '서버 후보');
  const files = [];
  for (const path of ['resources/server/desktop-entry.js', 'resources/dist/index.html', 'binaries/node-x86_64-pc-windows-msvc.exe']) {
    const bytes = Buffer.from(`fixture: ${path}`);
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = { version: 1, target: 'x86_64-pc-windows-msvc', protocol: 1,
    entry: 'resources/server/desktop-entry.js', distributionReady: false, files };
  const save = () => writeFile(join(source, 'payload-manifest.json'), JSON.stringify(manifest));
  await save();
  // A structural PE fixture only. It must never be executed.
  const executable = Buffer.alloc(128); executable.writeUInt16LE(0x5a4d); executable.writeUInt32LE(64, 0x3c);
  executable.writeUInt32LE(0x00004550, 64); executable.writeUInt16LE(0x8664, 68); executable.writeUInt16LE(0x20b, 88);
  const native = join(directory, 'native.exe'); await writeFile(native, executable);
  return { directory, source, native, executable, manifest, save };
}

test('native staging copies only authenticated manifest members and breaks Cargo hard links', async t => {
  const disk = await statfs(root, { bigint: true });
  if (disk.bavail * disk.bsize < 20n * 1024n ** 3n + 1024n ** 2n) {
    t.skip('The real build filesystem is below the 20 GiB staging floor.'); return;
  }
  const f = await fixture(); let output: string | undefined;
  try {
    await link(f.native, join(f.directory, 'cargo-deps.exe'));
    assert.equal((await lstat(f.native)).nlink, 2);
    await writeFile(join(f.source, 'resources', '.env'), 'PRIVATE_FIXTURE_DO_NOT_PACKAGE');
    const result = JSON.parse((await run(f.source, f.native)).stdout.trim());
    output = result.output;
    assert.ok(output);
    const rel = relative(join(root, 'desktop/builds'), output);
    assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && rel.startsWith('native-'));
    const receipt = JSON.parse(await readFile(join(output, 'native-manifest.json'), 'utf8'));
    assert.equal(receipt.distributionReady, false);
    assert.equal(receipt.executable.sha256, hash(f.executable));
    assert.equal((await lstat(join(output, 'agent-company-beta.exe'))).nlink, 1);
    assert.deepEqual(await readFile(join(output, 'agent-company-beta.exe')), f.executable);
    await assert.rejects(lstat(join(output, 'resources/.env')), { code: 'ENOENT' });
  } finally {
    // Only the unique fixture and the validated output from this invocation are owned.
    if (output) {
      const rel = relative(join(root, 'desktop/builds'), output);
      assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && rel.startsWith('native-'));
      await rm(output, { recursive: true });
    }
    assert.ok(f.directory.startsWith(join(tmpdir(), 'ac-staging-')));
    await rm(f.directory, { recursive: true });
  }
});

test('native staging refuses to copy on a filesystem below the operating floor', async t => {
  const disk = await statfs(root, { bigint: true });
  if (disk.bavail * disk.bsize >= 20n * 1024n ** 3n) {
    t.skip('The real build filesystem has enough free space; no disk-filling fixture is used.'); return;
  }
  const f = await fixture();
  try {
    await assert.rejects(run(f.source, f.native), /최소 20GiB/);
  } finally {
    assert.ok(f.directory.startsWith(join(tmpdir(), 'ac-staging-')));
    await rm(f.directory, { recursive: true });
  }
});

test('native staging rejects manifest traversal and an incorrect executable architecture', async () => {
  const f = await fixture();
  try {
    f.manifest.files.push({ path: 'resources/../../private', bytes: 0, sha256: hash(Buffer.alloc(0)) });
    await f.save();
    await assert.rejects(run(f.source, f.native), /허용되지 않은 경로/);
    f.manifest.files.pop(); await f.save();
    f.executable.writeUInt16LE(0x14c, 68); await writeFile(f.native, f.executable);
    await assert.rejects(run(f.source, f.native), /Windows x64 실행파일/);
  } finally {
    assert.ok(f.directory.startsWith(join(tmpdir(), 'ac-staging-')));
    await rm(f.directory, { recursive: true });
  }
});
