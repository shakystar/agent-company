import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { DesktopImageArchiveError, verifyDesktopImageArchive } from '../server/desktop-image-archive.ts';

// Small synthetic records follow the pinned Docker 29.1.3 sources. These are
// format/attack fixtures, not evidence of a Docker daemon save/load round trip.
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const oci = 'application/vnd.oci.image.';
interface Entry { name: string; data?: Buffer; type?: string; link?: string; size?: number; header?: (buffer: Buffer) => void }
function tar(entries: Entry[], tail = Buffer.alloc(1024)) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), data = entry.data ?? Buffer.alloc(0);
    header.write(entry.name, 0, 100, 'utf8'); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    const size = entry.size ?? data.length;
    if (size <= 0o77777777777) header.write(size.toString(8).padStart(11, '0') + '\0', 124);
    else { let number = BigInt(size); for (let i = 135; i >= 124; i--) { header[i] = Number(number & 255n); number >>= 8n; } header[124] |= 128; }
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(entry.type ?? '0', 156);
    if (entry.link) header.write(entry.link, 157, 100, 'utf8'); header.write('ustar\0', 257); header.write('00', 263);
    entry.header?.(header); header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...chunks, tail]);
}
function pax(records: Record<string, string>) {
  return Buffer.concat(Object.entries(records).map(([key, value]) => {
    const text = `${key}=${value}\n`; let length = Buffer.byteLength(text) + 2;
    while (length !== String(length).length + 1 + Buffer.byteLength(text)) length = String(length).length + 1 + Buffer.byteLength(text);
    return Buffer.from(`${length} ${text}`);
  }));
}
interface Options {
  mode?: 'raw' | 'gzip' | 'zstd'; classic?: boolean; indexDepth?: number; layer?: Buffer; configRaw?: Buffer; encoded?: (value: Buffer) => Buffer;
  config?: (value: any) => void; manifest?: (value: any) => void; index?: (value: any) => void; compatibility?: (value: any) => void;
}
function archive(options: Options = {}) {
  const layer = options.layer ?? tar([{ name: 'etc/', type: '5' }, { name: 'etc/message', data: Buffer.from('hello') },
    { name: 'node', type: '2', link: '/usr/bin/node' }, { name: 'copy', type: '1', link: 'etc/message' },
    { name: '.wh.removed', type: '3' }]);
  const mode = options.mode ?? 'raw', compressed = mode === 'gzip' ? gzipSync(layer) : mode === 'zstd' ? zstdCompressSync(layer) : layer;
  const encoded = options.encoded?.(compressed) ?? compressed;
  const config = { architecture: 'amd64', os: 'linux', config: { Cmd: ['fixture'], Labels: { Source: 'format-only' } },
    rootfs: { type: 'layers', diff_ids: [`sha256:${digest(layer)}`] }, history: [{ created_by: 'fixture' }] };
  options.config?.(config); const configBytes = options.configRaw ?? encode(config), configDigest = `sha256:${digest(configBytes)}`;
  const layerDescriptor = { mediaType: `${oci}layer.v1.tar${mode === 'raw' ? '' : '+' + mode}`, digest: `sha256:${digest(encoded)}`, size: encoded.length };
  const manifest = { schemaVersion: 2, mediaType: `${oci}manifest.v1+json`,
    config: { mediaType: `${oci}config.v1+json`, digest: configDigest, size: configBytes.length }, layers: [layerDescriptor] };
  options.manifest?.(manifest); const manifestBytes = encode(manifest), manifestDigest = `sha256:${digest(manifestBytes)}`;
  const entries: Entry[] = [{ name: 'blobs/', type: '5' }, { name: 'blobs/sha256/', type: '5' },
    { name: `blobs/sha256/${digest(configBytes)}`, data: configBytes }, { name: `blobs/sha256/${digest(encoded)}`, data: encoded },
    { name: `blobs/sha256/${digest(manifestBytes)}`, data: manifestBytes }];
  let descriptor = { mediaType: manifest.mediaType, digest: manifestDigest, size: manifestBytes.length };
  for (let depth = 0; depth < (options.indexDepth ?? 0); depth++) {
    const bytes = encode({ schemaVersion: 2, mediaType: `${oci}index.v1+json`, manifests: [descriptor] });
    descriptor = { mediaType: `${oci}index.v1+json`, digest: `sha256:${digest(bytes)}`, size: bytes.length };
    entries.push({ name: `blobs/sha256/${digest(bytes)}`, data: bytes });
  }
  const index = { schemaVersion: 2, mediaType: `${oci}index.v1+json`, manifests: [descriptor] }; options.index?.(index);
  const compatibility: any = { Config: `blobs/sha256/${digest(configBytes)}`, RepoTags: null, Layers: [`blobs/sha256/${digest(encoded)}`] };
  if (options.classic) {
    compatibility.LayerSources = { [`sha256:${digest(layer)}`]: layerDescriptor };
    const legacy = encode({ id: digest('legacy-v1'), created: '1970-01-01T00:00:00Z', os: 'linux', config: { Cmd: ['fixture'] } });
    entries.push({ name: `blobs/sha256/${digest(legacy)}`, data: legacy });
  }
  options.compatibility?.(compatibility);
  entries.push({ name: 'oci-layout', data: encode({ imageLayoutVersion: '1.0.0' }) }, { name: 'index.json', data: encode(index) },
    { name: 'manifest.json', data: encode([compatibility]) });
  const bytes = tar(entries);
  return { entries, bytes, layer, configDigest, manifestDigest, indexDigest: descriptor.digest,
    pin: { image: options.classic ? configDigest : descriptor.digest, bytes: bytes.length, sha256: digest(bytes) } };
}
async function fixture(t: TestContext, contents: Buffer, image: string) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-image-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'image.tar'); await writeFile(path, contents);
  return { directory, path, pin: { image, bytes: contents.length, sha256: digest(contents) } };
}
const denied = (code?: string) => (error: unknown) => error instanceof DesktopImageArchiveError && (!code || error.code === code);
async function invalid(t: TestContext, contents: Buffer, image: string, code?: string) {
  const f = await fixture(t, contents, image);
  await assert.rejects(async () => { const result = await verifyDesktopImageArchive(f.path, f.pin); await result.close(); }, denied(code));
}

for (const mode of ['raw', 'gzip', 'zstd'] as const) test(`Docker29 OCI ${mode} verifies exact graph/diff IDs and replays the same archive bytes`, async t => {
  const a = archive({ mode }), f = await fixture(t, a.bytes, a.pin.image), verified = await verifyDesktopImageArchive(f.path, f.pin);
  try {
    assert.equal(verified.image, a.pin.image); assert.equal(verified.imageIdentity, 'manifest'); assert.equal(verified.configDigest, a.configDigest);
    assert.equal(verified.manifestDigest, a.manifestDigest); assert.equal(verified.layerBytes, a.layer.length); assert.equal(verified.layerFileBytes, 5);
    assert.equal(verified.layerCount, 1); assert.equal(verified.format, 'docker29-oci');
    const chunks: Buffer[] = []; for await (const chunk of verified.chunks()) { assert.ok(chunk.length <= 64 * 1024); chunks.push(chunk); }
    assert.deepEqual(Buffer.concat(chunks), a.bytes);
  } finally { await verified.close(); }
});

test('Docker29 classic accepts its hash-addressed legacy V1 configs and LayerSources without treating them as extra images', async t => {
  const a = archive({ classic: true }), f = await fixture(t, a.bytes, a.pin.image), verified = await verifyDesktopImageArchive(f.path, f.pin);
  assert.equal(verified.format, 'docker29-classic'); assert.equal(verified.imageIdentity, 'config'); await verified.close();
});

test('an included original single-platform index is hashed and linked; a stripped index identity is refused', async t => {
  const a = archive({ indexDepth: 2 }), f = await fixture(t, a.bytes, a.pin.image), verified = await verifyDesktopImageArchive(f.path, f.pin);
  assert.equal(verified.imageIdentity, 'index'); assert.equal(verified.manifestDigest, a.manifestDigest); await verified.close();
  await assert.rejects(verifyDesktopImageArchive(f.path, { ...f.pin, image: `sha256:${digest('stripped original index')}` }), denied());
});

test('nested index and leaf digests cannot stand in for the top-level containerd image record', async t => {
  const a = archive({ indexDepth: 2 }), f = await fixture(t, a.bytes, a.pin.image);
  const topLevel = a.entries.find(entry => entry.name === `blobs/sha256/${a.indexDigest.slice(7)}`)!;
  const innerIndexDigest = JSON.parse(topLevel.data!.toString('utf8')).manifests[0].digest as string;
  assert.notEqual(innerIndexDigest, a.indexDigest); assert.notEqual(innerIndexDigest, a.manifestDigest);
  for (const image of [innerIndexDigest, a.manifestDigest]) {
    await assert.rejects(verifyDesktopImageArchive(f.path, { ...f.pin, image }), denied('DESKTOP_IMAGE_ARCHIVE_INVALID'));
  }
});

test('tag or additional image/referrer names are refused in both representations', async t => {
  for (const options of [
    { compatibility: (m: any) => { m.RepoTags = ['other:latest']; } },
    { index: (i: any) => { i.manifests.push(i.manifests[0]); } },
    { index: (i: any) => { i.manifests[0].annotations = { 'io.containerd.image.name': 'other:latest' }; } },
    { manifest: (m: any) => { m.annotations = { 'org.opencontainers.image.ref.name': 'latest' }; } },
    { manifest: (m: any) => { m.subject = { digest: `sha256:${digest('extra')}` }; } },
    { manifest: (m: any) => { m.layers[0].urls = ['https://registry.invalid/foreign']; } },
  ]) { const a = archive(options); await invalid(t, a.bytes, a.pin.image); }
  const a = archive();
  await invalid(t, tar([...a.entries, { name: 'repositories', data: encode({ unwanted: { latest: digest('x') } }) }]), a.pin.image);
  const extra = encode({ os: 'linux', architecture: 'amd64', rootfs: { type: 'layers', diff_ids: [] } });
  await invalid(t, tar([...a.entries, { name: `blobs/sha256/${digest(extra)}`, data: extra }]), a.pin.image);
});

test('wrong platform, layer order/hash, config digest, descriptor size and dual manifest mismatch are refused', async t => {
  for (const options of [
    { config: (c: any) => { c.architecture = 'arm64'; } }, { config: (c: any) => { c.os = 'windows'; } },
    { config: (c: any) => { c.rootfs.diff_ids[0] = `sha256:${digest('wrong diff')}`; } },
    { manifest: (m: any) => { m.config.digest = `sha256:${digest('absent config')}`; } },
    { manifest: (m: any) => { m.layers[0].size++; } },
    { manifest: (m: any) => { m.layers[0].urls = {}; } },
    { config: (c: any) => { c.variant = 0; } },
    { compatibility: (c: any) => { c.Layers = []; } },
    { compatibility: (c: any) => { c.Parent = `sha256:${digest('extra parent')}`; } },
    { manifest: (m: any) => { m.layers[0].mediaType = `${oci}layer.nondistributable.v1.tar+gzip`; } },
  ]) { const a = archive(options); await invalid(t, a.bytes, a.pin.image); }
});

test('outer tar traversal, aliases, special files, links, duplicates and sparse metadata are refused', async t => {
  const a = archive();
  for (const entry of [
    { name: '../outside', data: Buffer.from('x') }, { name: '/absolute', data: Buffer.from('x') },
    { name: 'blobs\\sha256\\bad', data: Buffer.from('x') }, { name: 'blobs//sha256', type: '5' },
    { name: 'blobs', data: Buffer.alloc(0) }, { name: 'manifest.json', type: '1', link: 'index.json' },
    { name: 'manifest.json', type: '2', link: 'index.json' }, { name: 'manifest.json', type: 'S' },
    { name: 'manifest.json', type: '3' }, { name: 'manifest.json', data: Buffer.from('[]') },
    { name: 'PaxHeaders/x', type: 'x', data: pax({ 'GNU.sparse.realsize': '999999999999' }) },
  ] satisfies Entry[]) await invalid(t, tar([...a.entries, entry]), a.pin.image);
});

test('tar checksum, padding, EOF, appended images, strict JSON UTF8 and duplicate keys are checked', async t => {
  const a = archive();
  const checksum = Buffer.from(a.bytes); checksum[148] ^= 1;
  const invalidUtf8 = a.entries.map(entry => entry.name === 'index.json' ? { ...entry, data: Buffer.from([123, 34, 255, 34, 58, 49, 125]) } : entry);
  const duplicate = a.entries.map(entry => entry.name === 'index.json' ? { ...entry, data: Buffer.from('{"schemaVersion":1,"schemaVersion":2,"manifests":[]}') } : entry);
  const padding = Buffer.from(a.bytes); const firstData = a.entries.findIndex(entry => entry.data?.length); let offset = 0;
  for (let i = 0; i < firstData; i++) offset += 512;
  padding[offset + 512 + a.entries[firstData].data!.length] = 1;
  for (const bytes of [checksum, a.bytes.subarray(0, -512), Buffer.concat([a.bytes, a.bytes]), tar(invalidUtf8), tar(duplicate), padding]) {
    await invalid(t, bytes, a.pin.image);
  }
});

test('safe PAX metadata is supported; sparse or escaping layer entries and declared expansion bombs are refused', async t => {
  const normal = tar([{ name: 'PaxHeaders/message', type: 'x', data: pax({ path: 'very/long/message', mtime: '1.5' }) },
    { name: 'message', data: Buffer.from('hello') }]);
  const a = archive({ layer: normal, mode: 'gzip' }), f = await fixture(t, a.bytes, a.pin.image), verified = await verifyDesktopImageArchive(f.path, f.pin);
  assert.equal(verified.layerFileBytes, 5); await verified.close();
  for (const layer of [
    tar([{ name: '../host-file', data: Buffer.from('x') }]), tar([{ name: 'sparse', type: 'S' }]),
    tar([{ name: 'PaxHeaders/sparse', type: 'x', data: pax({ 'GNU.sparse.size': '999999999999' }) }, { name: 'sparse' }]),
    tar([{ name: 'expansion-bomb', size: 8 * 1024 ** 3 + 1 }]),
    tar([{ name: 'truncated', size: 4096, data: Buffer.from('x') }]),
  ]) { const bad = archive({ layer, mode: 'gzip' }); await invalid(t, bad.bytes, bad.pin.image); }
});

test('layer GNU long names, global timestamps and binary Linux capability xattrs remain valid', async t => {
  const long = 'directory/'.repeat(20) + 'binary';
  const value = Buffer.from([0, 255, 1, 128]), key = Buffer.from('SCHILY.xattr.security.capability=');
  const body = Buffer.concat([key, value, Buffer.from('\n')]); let length = body.length + 2;
  while (length !== String(length).length + 1 + body.length) length = String(length).length + 1 + body.length;
  const xattr = Buffer.concat([Buffer.from(`${length} `), body]);
  const layer = tar([{ name: 'global', type: 'g', data: pax({ mtime: '-1.25', comment: 'standard metadata' }) },
    { name: '././@LongLink', type: 'L', data: Buffer.from(long + '\0') },
    { name: 'PaxHeaders/capability', type: 'x', data: xattr }, { name: 'short', data: Buffer.from('content') }]);
  const a = archive({ mode: 'gzip', layer }), f = await fixture(t, a.bytes, a.pin.image), verified = await verifyDesktopImageArchive(f.path, f.pin);
  assert.equal(verified.layerFileBytes, 7); await verified.close();
});

test('corrupt or incomplete gzip/zstd payloads are refused despite matching archive and compressed blob hashes', async t => {
  for (const mode of ['gzip', 'zstd'] as const) {
    const a = archive({ mode, encoded: value => value.subarray(0, -2) }); await invalid(t, a.bytes, a.pin.image);
  }
});

test('hash corruption, invalid pins and independently linked archive paths fail before returning a descriptor', async t => {
  const a = archive(), f = await fixture(t, a.bytes, a.pin.image);
  for (const pin of [{ ...f.pin, sha256: digest('wrong') }, { ...f.pin, bytes: 8 * 1024 ** 3 + 512 },
    { ...f.pin, bytes: Number.MAX_SAFE_INTEGER + 1 }, { ...f.pin, image: 'fixture:latest' }]) await assert.rejects(verifyDesktopImageArchive(f.path, pin), denied());
  const linked = join(f.directory, 'linked.tar'); await link(f.path, linked);
  await assert.rejects(verifyDesktopImageArchive(f.path, f.pin), denied()); await rm(linked);
  const directory = join(f.directory, 'nested'); await mkdir(directory); const junction = join(f.directory, 'alias');
  await symlink(directory, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(directory, 'image.tar'), a.bytes);
  await assert.rejects(verifyDesktopImageArchive(join(junction, 'image.tar'), f.pin), denied());
});

test('verified handle detects replacement and content changes, observes cancellation and closes idempotently', async t => {
  const a = archive(), f = await fixture(t, a.bytes, a.pin.image);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifyDesktopImageArchive(f.path, f.pin, controller.signal), denied('DESKTOP_IMAGE_ARCHIVE_ABORTED'));
  const verified = await verifyDesktopImageArchive(f.path, f.pin);
  const canceled = verified.chunks(controller.signal); await assert.rejects(canceled.next(), denied('DESKTOP_IMAGE_ARCHIVE_ABORTED'));
  const backup = join(f.directory, 'old.tar'); await rename(f.path, backup); await writeFile(f.path, a.bytes);
  await assert.rejects(verified.chunks().next(), denied('DESKTOP_IMAGE_ARCHIVE_CHANGED'));
  await verified.close(); await verified.close(); await assert.rejects(verified.chunks().next(), denied('DESKTOP_IMAGE_ARCHIVE_CLOSED'));
  const current = await verifyDesktopImageArchive(f.path, f.pin); const writer = await open(f.path, 'r+');
  try { await writer.write(Buffer.from('X'), 0, 1, 1024); } finally { await writer.close(); }
  await assert.rejects(current.chunks().next(), denied('DESKTOP_IMAGE_ARCHIVE_CHANGED')); await current.close();
});

test('a changed later chunk is never yielded to the image loader and simultaneous consumers are refused', async t => {
  const layer = tar([{ name: 'large-fixture', data: Buffer.alloc(160 * 1024, 120) }]), a = archive({ layer }), f = await fixture(t, a.bytes, a.pin.image);
  const verified = await verifyDesktopImageArchive(f.path, f.pin), chunks = verified.chunks();
  try {
    assert.equal((await chunks.next()).value?.length, 64 * 1024);
    await assert.rejects(verified.chunks().next(), denied());
    const writer = await open(f.path, 'r+');
    try { await writer.write(Buffer.from('Z'), 0, 1, 64 * 1024 + 100); } finally { await writer.close(); }
    await assert.rejects(chunks.next(), denied('DESKTOP_IMAGE_ARCHIVE_CHANGED'));
  } finally { await chunks.return(undefined); await verified.close(); }
});

test('load replay is independent of the completed verification signal; explicit replay cancellation still stops it', async t => {
  const a = archive({ layer: tar([{ name: 'large-fixture', data: Buffer.alloc(160 * 1024, 120) }]) });
  const f = await fixture(t, a.bytes, a.pin.image), verification = new AbortController();
  const verified = await verifyDesktopImageArchive(f.path, f.pin, verification.signal);
  try {
    const replay = verified.chunks(), chunks: Buffer[] = [(await replay.next()).value!]; verification.abort();
    for await (const chunk of replay) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), a.bytes);
    const cancellation = new AbortController(), cancelable = verified.chunks(cancellation.signal);
    assert.equal((await cancelable.next()).done, false); cancellation.abort();
    await assert.rejects(cancelable.next(), denied('DESKTOP_IMAGE_ARCHIVE_ABORTED'));
  } finally { await verified.close(); }
});

test('failed verification releases its file handle and errors contain no source path or metadata', async t => {
  const a = archive({ compatibility: c => { c.RepoTags = ['PRIVATE_CREDENTIAL_TOKEN']; } }), f = await fixture(t, a.bytes, a.pin.image);
  await assert.rejects(verifyDesktopImageArchive(f.path, f.pin), error => denied()(error) && !String(error).includes(f.directory) && !String(error).includes('PRIVATE_CREDENTIAL_TOKEN'));
  const renamed = join(f.directory, randomUUID()); await rename(f.path, renamed); assert.equal((await readFile(renamed)).length, a.bytes.length);
});
