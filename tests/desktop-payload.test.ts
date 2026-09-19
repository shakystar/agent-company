import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertDesktopPayloadCopySpace, copyDesktopPayload, desktopPayloadFreeSpaceFloor, desktopPayloadMaximumFileBytes,
  desktopPayloadSpaceSufficient, parseDesktopPayloadManifest, readDesktopPayload, runDesktopPayloadCopyWorkers } from '../scripts/desktop-payload.ts';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exec = promisify(execFile);
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-payload-'));
  t.after(async () => {
    const rel = relative(tmpdir(), root);
    assert.ok(rel.startsWith('ac-payload-') && !isAbsolute(rel) && !rel.includes(sep));
    await rm(root, { recursive: true });
  });
  const source = join(root, '동봉 원본'), destination = join(root, '설치 복사');
  await mkdir(source); await mkdir(destination);
  const members = new Map<string, Buffer>([
    ['resources/server/desktop-entry.js', Buffer.from('fixture only; never execute')],
    ['resources/dist/index.html', Buffer.from('<div id="root"></div>')],
    ['binaries/node-x86_64-pc-windows-msvc.exe', Buffer.from('fixture only; never execute')],
    ['resources/providers/worker/image.tar', Buffer.alloc(160 * 1024 + 13, 0x63)],
    ['resources/worker/empty', Buffer.alloc(0)],
  ]);
  for (const [path, bytes] of members) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), bytes); }
  const manifest = { version: 1, target: 'x86_64-pc-windows-msvc', protocol: 1, entry: 'resources/server/desktop-entry.js',
    distributionReady: false, node: '24.11.1', files: [...members].map(([path, data]) => ({ path, bytes: data.length, sha256: digest(data) })) };
  const save = () => writeFile(join(source, 'payload-manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, source, destination, members, manifest, save };
}
async function filesUnder(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(root, path));
    else result.push(relative(root, path).replaceAll('\\', '/'));
  }
  return result.sort();
}

test('payload copy streams pinned multi-chunk and empty members while excluding every unlisted file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'resources', '.env'), 'PRIVATE_FIXTURE_NOT_A_MEMBER');
  await writeFile(join(f.source, 'arbitrary-private.json'), 'PRIVATE_FIXTURE_NOT_A_MEMBER');
  const payload = await readDesktopPayload(f.source);
  assert.equal(payload.copyBytes, [...f.members.values()].reduce((sum, data) => sum + BigInt(data.length), BigInt(payload.manifestBytes.length)));
  await copyDesktopPayload(payload, f.destination);
  assert.deepEqual(await filesUnder(f.destination), [...f.members.keys(), 'payload-manifest.json'].sort());
  for (const [path, bytes] of f.members) {
    assert.deepEqual(await readFile(join(f.destination, path)), bytes);
    const original = await lstat(join(f.source, path)), copied = await lstat(join(f.destination, path));
    assert.equal(copied.nlink, 1); assert.notEqual(copied.ino, original.ino);
  }
  assert.deepEqual(await readFile(join(f.destination, 'payload-manifest.json')), payload.manifestBytes);
});

test('payload copying admits at most four members and completes each exactly once', async () => {
  const files = Array.from({ length: 11 }, (_, index) => ({ path: `resources/shared/${index}`, bytes: 0, sha256: digest(Buffer.alloc(0)) }));
  const entered = deferred(), release = deferred();
  const seen: string[] = []; let active = 0, maximum = 0;
  const completion = runDesktopPayloadCopyWorkers(files, async file => {
    seen.push(file.path); maximum = Math.max(maximum, ++active);
    if (seen.length === 4) entered.resolve();
    try { await release.promise; } finally { active--; }
  });
  await entered.promise;
  assert.equal(seen.length, 4); assert.equal(active, 4);
  release.resolve(); await completion;
  assert.equal(maximum, 4); assert.equal(active, 0);
  assert.deepEqual(seen, files.map(file => file.path));
});

test('payload failure stops new members and awaits all active cleanup while preserving the first failure', async () => {
  const files = Array.from({ length: 9 }, (_, index) => ({ path: `resources/shared/${index}`, bytes: 0, sha256: digest(Buffer.alloc(0)) }));
  const entered = deferred(), gates = Array.from({ length: 4 }, deferred);
  const seen: string[] = [], cleaned: string[] = []; let returned = false;
  const first = new Error('FIRST_MEMBER_FAILED'), later = new Error('LATER_MEMBER_FAILED');
  const completion = runDesktopPayloadCopyWorkers(files, async file => {
    const index = seen.push(file.path) - 1;
    if (seen.length === 4) entered.resolve();
    try { await gates[index].promise; } finally { cleaned.push(file.path); }
  }).then(() => { returned = true; return null; }, error => { returned = true; return error; });
  await entered.promise;
  gates[0].reject(first);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(seen.length, 4); assert.equal(returned, false); assert.equal(cleaned.length, 1);
  gates[1].resolve(); gates[2].reject(later);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(seen.length, 4); assert.equal(returned, false); assert.equal(cleaned.length, 3);
  gates[3].resolve();
  assert.equal(await completion, first); assert.equal(cleaned.length, 4); assert.equal(seen.length, 4);
});

test('concurrent payload members safely share newly created parents without skipping file verification', async t => {
  const f = await fixture(t), extra = [];
  for (let index = 0; index < 12; index++) {
    const path = `resources/shared/new/branch/member-${index}.txt`, bytes = Buffer.from(`concurrent member ${index}`);
    await mkdir(dirname(join(f.source, path)), { recursive: true }); await writeFile(join(f.source, path), bytes);
    f.members.set(path, bytes); extra.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  f.manifest.files.unshift(...extra); await f.save();
  const payload = await readDesktopPayload(f.source); await copyDesktopPayload(payload, f.destination);
  assert.deepEqual(await filesUnder(f.destination), [...f.members.keys(), 'payload-manifest.json'].sort());
  for (const [path, bytes] of f.members) {
    assert.deepEqual(await readFile(join(f.destination, path)), bytes);
    const original = await lstat(join(f.source, path)), copied = await lstat(join(f.destination, path));
    assert.equal(copied.nlink, 1); assert.notEqual(copied.ino, original.ino);
  }
  assert.deepEqual(await readFile(join(f.destination, 'payload-manifest.json')), payload.manifestBytes);
});

test('payload manifest rejects ambiguous paths, duplicate and file-parent collisions before copying', async t => {
  const f = await fixture(t), bytes = () => Buffer.from(JSON.stringify(f.manifest));
  for (const path of ['resources/../secret', 'resources\\private', '/resources/private', 'resources//private', 'binaries',
    'resources/.ENV.secret', 'resources/credentials/token', 'resources/CON.txt', 'resources/folder./data', 'resources/file:stream',
    'resources/data ', 'resources/file.map', 'resources/a\0b', 'resources/server/DESKTOP-ENTRY.JS', 'resources/server']) {
    f.manifest.files.push({ path, bytes: 0, sha256: digest(Buffer.alloc(0)) });
    assert.throws(() => parseDesktopPayloadManifest(bytes()), /허용되지 않은 경로/);
    f.manifest.files.pop();
  }
  f.manifest.files = f.manifest.files.filter(file => file.path !== 'resources/dist/index.html');
  assert.throws(() => parseDesktopPayloadManifest(bytes()), /필요한 동봉 자원/);
  assert.deepEqual(await readdir(f.destination), []);
});

test('payload sizes are safe bounded integers, include empty files, and plan large archives without allocation', async t => {
  const f = await fixture(t), file = f.manifest.files.find(file => file.path.endsWith('.tar'))!;
  file.bytes = desktopPayloadMaximumFileBytes;
  const parsed = parseDesktopPayloadManifest(Buffer.from(JSON.stringify(f.manifest)));
  assert.equal(parsed.files.find(member => member.path.endsWith('.tar'))!.bytes, 8 * 1024 ** 3);
  for (const bytes of [-1, 0.5, desktopPayloadMaximumFileBytes + 1, Number.MAX_SAFE_INTEGER + 1]) {
    file.bytes = bytes;
    assert.throws(() => parseDesktopPayloadManifest(Buffer.from(JSON.stringify(f.manifest))));
  }
  assert.throws(() => parseDesktopPayloadManifest(Buffer.alloc(2 * 1024 * 1024 + 1)), /크기 한도/);
  assert.throws(() => parseDesktopPayloadManifest(Buffer.from([0xff])));
});

test('payload copy rejects changed, truncated and non-regular members and never publishes their manifest', async t => {
  for (const kind of ['hash', 'size', 'directory']) await t.test(kind, async t => {
    const f = await fixture(t), payload = await readDesktopPayload(f.source), path = join(f.source, 'resources/providers/worker/image.tar');
    if (kind === 'directory') { await rm(path); await mkdir(path); }
    else if (kind === 'size') await writeFile(path, 'truncated');
    else { const bytes = Buffer.from(f.members.get('resources/providers/worker/image.tar')!); bytes[100_000] ^= 0xff; await writeFile(path, bytes); }
    await assert.rejects(copyDesktopPayload(payload, f.destination), /INPUT_INVALID/);
    await assert.rejects(lstat(join(f.destination, 'payload-manifest.json')), { code: 'ENOENT' });
  });
});

test('payload manifests and members reject hard links and redirected source parents', async t => {
  const f = await fixture(t), payload = await readDesktopPayload(f.source);
  const manifestLink = join(f.root, 'manifest-link.json'); await link(join(f.source, 'payload-manifest.json'), manifestLink);
  await assert.rejects(readDesktopPayload(f.source), /INPUT_INVALID/); await rm(manifestLink);
  const memberLink = join(f.root, 'member-link.tar'); await link(join(f.source, 'resources/providers/worker/image.tar'), memberLink);
  await assert.rejects(copyDesktopPayload(payload, f.destination), /INPUT_INVALID/);
  const actual = join(f.root, 'outside'); await mkdir(actual); await writeFile(join(actual, 'item'), 'outside');
  const redirected = join(f.source, 'resources/redirected'); await symlink(actual, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  f.manifest.files.unshift({ path: 'resources/redirected/item', bytes: 7, sha256: digest(Buffer.from('outside')) }); await f.save();
  const fresh = join(f.root, 'fresh'); await mkdir(fresh);
  await assert.rejects(copyDesktopPayload(await readDesktopPayload(f.source), fresh), /INPUT_INVALID/);
  assert.deepEqual(await readdir(actual), ['item']);
  const sourceAlias = join(f.root, 'source-alias'); await symlink(f.source, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readDesktopPayload(sourceAlias), /INPUT_INVALID/);
});

test('payload copying requires a separate empty destination and uses the original manifest snapshot', async t => {
  const f = await fixture(t), payload = await readDesktopPayload(f.source);
  payload.manifest.files.push({ path: 'resources/unlisted', bytes: 1, sha256: digest(Buffer.from('x')) });
  await writeFile(join(f.source, 'resources/unlisted'), 'x');
  await copyDesktopPayload(payload, f.destination);
  await assert.rejects(lstat(join(f.destination, 'resources/unlisted')), { code: 'ENOENT' });
  await assert.rejects(copyDesktopPayload(payload, f.destination), /새 빈 폴더/);
  const nested = join(f.source, 'nested'); await mkdir(nested);
  await assert.rejects(copyDesktopPayload(payload, nested), /새 빈 폴더/);
  const alias = join(f.root, 'target-alias'); await symlink(f.destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyDesktopPayload(payload, alias), /INPUT_INVALID/);
});

test('payload copy space guard preserves 20 GiB plus the complete planned copy', async t => {
  const f = await fixture(t), floor = desktopPayloadFreeSpaceFloor;
  assert.equal(desktopPayloadSpaceSufficient(floor + 123n, 123n), true);
  assert.equal(desktopPayloadSpaceSufficient(floor + 123n, 124n), false);
  assert.equal(desktopPayloadSpaceSufficient(floor - 1n, 0n), false);
  assert.equal(desktopPayloadSpaceSufficient(floor, -1n), false);
  const disk = await statfs(f.root, { bigint: true });
  await assert.rejects(assertDesktopPayloadCopySpace(f.root, disk.bavail * disk.bsize), /최소 20GiB/);
});

test('packaged runtime verifier checks copy capacity before creating its isolated installation or launching a child', async t => {
  const f = await fixture(t), temporary = join(f.root, 'temporary'); await mkdir(temporary);
  const disk = await statfs(temporary, { bigint: true });
  const needed = Number((disk.bavail * disk.bsize) / BigInt(desktopPayloadMaximumFileBytes)) + 1;
  assert.ok(needed < 1000, 'Use a bounded manifest fixture, never a real disk-filling copy.');
  for (let index = 0; index < needed; index++) {
    f.manifest.files.push({ path: `resources/providers/worker/fake-${index}.tar`, bytes: desktopPayloadMaximumFileBytes, sha256: digest(Buffer.alloc(0)) });
  }
  await f.save();
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', join(project, 'scripts/verify-desktop-payload.ts'), f.source], {
    cwd: project, windowsHide: true, env: { ...process.env, TMP: temporary, TEMP: temporary, TMPDIR: temporary },
  }), /최소 20GiB/);
  assert.deepEqual((await readdir(temporary)).filter(name => name.startsWith('agent-company-packaged-')), []);
});
