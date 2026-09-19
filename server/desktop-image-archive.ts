import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants as zlibConstants, createGunzip, createZstdDecompress } from 'node:zlib';

// Docker 29.1.3: daemon/internal/image/tarexport/save.go and the vendored
// containerd/core/images/archive/{exporter,importer}.go both emit OCI layouts.
const maximum = 8 * 1024 ** 3, blockSize = 64 * 1024, metadataMaximum = 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/, hexPattern = /^[a-f0-9]{64}$/;
const oci = 'application/vnd.oci.image.', docker = 'application/vnd.docker.';
const manifestTypes = new Set([`${oci}manifest.v1+json`, `${docker}distribution.manifest.v2+json`]);
const indexTypes = new Set([`${oci}index.v1+json`, `${docker}distribution.manifest.list.v2+json`]);
const configTypes = new Set([`${oci}config.v1+json`, `${docker}container.image.v1+json`]);
const layerTypes = new Map<string, 'raw' | 'gzip' | 'zstd'>([
  [`${oci}layer.v1.tar`, 'raw'], [`${oci}layer.v1.tar+gzip`, 'gzip'], [`${oci}layer.v1.tar+zstd`, 'zstd'],
  [`${docker}image.rootfs.diff.tar`, 'raw'], [`${docker}image.rootfs.diff.tar.gzip`, 'gzip'],
]);
type ErrorCode = 'DESKTOP_IMAGE_ARCHIVE_INVALID' | 'DESKTOP_IMAGE_ARCHIVE_CHANGED' | 'DESKTOP_IMAGE_ARCHIVE_LIMIT'
  | 'DESKTOP_IMAGE_ARCHIVE_ABORTED' | 'DESKTOP_IMAGE_ARCHIVE_CLOSED';
export class DesktopImageArchiveError extends Error { constructor(readonly code: ErrorCode) { super(code); } }
const fail = (code: ErrorCode = 'DESKTOP_IMAGE_ARCHIVE_INVALID'): never => { throw new DesktopImageArchiveError(code); };
const checkSignal = (signal?: AbortSignal) => { if (signal?.aborted) fail('DESKTOP_IMAGE_ARCHIVE_ABORTED'); };
export interface DesktopImageArchivePin { image: string; bytes: number; sha256: string }
export interface VerifiedDesktopImageArchive {
  readonly image: string;
  readonly imageIdentity: 'config' | 'manifest' | 'index';
  readonly configDigest: string;
  readonly manifestDigest: string;
  readonly format: 'docker29-classic' | 'docker29-oci';
  readonly archiveBytes: number;
  /** Sum of uncompressed layer tar bytes, including each occurrence in rootfs. */
  readonly layerBytes: number;
  readonly layerFileBytes: number;
  readonly layerCount: number;
  /** One reader at a time; each chunk is checked against the original verified bytes. */
  chunks(signal?: AbortSignal): AsyncGenerator<Buffer>;
  close(): Promise<void>;
}
type Directory = { path: string; stat: BigIntStats };
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats) => identity(a, b) && b.isFile() && b.nlink === 1n
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function filename(input: string) {
  if (!isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input) || input.split(/[\\/]/).some(part => part === '.' || part === '..')) fail();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(input)
    || input.slice(3).split(/[\\/]/).some(part => /[<>:"|?*]|[. ]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) fail();
  const path = resolve(input); if (path === parse(path).root) fail(); return path;
}
async function directories(path: string) {
  const entries: Directory[] = []; let cursor = parse(path).root;
  const parts = relative(cursor, path).split(/[\\/]/); parts.pop();
  for (const part of ['', ...parts]) {
    cursor = join(cursor, part); const stat = await lstat(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(cursor, await realpath(cursor))) fail();
    entries.push({ path: cursor, stat });
  }
  return entries;
}
async function unchanged(path: string, file: FileHandle, before: BigIntStats, parents: Directory[]) {
  if (!sameFile(before, await file.stat({ bigint: true })) || !sameFile(before, await lstat(path, { bigint: true }))
    || relative(path, await realpath(path))) fail('DESKTOP_IMAGE_ARCHIVE_CHANGED');
  for (const parent of parents) {
    const stat = await lstat(parent.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !identity(parent.stat, stat)
      || relative(parent.path, await realpath(parent.path))) fail('DESKTOP_IMAGE_ARCHIVE_CHANGED');
  }
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
async function block(file: FileHandle, position: number, size: number, signal?: AbortSignal) {
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) {
    checkSignal(signal); const next = await file.read(bytes, offset, size - offset, position + offset);
    if (!next.bytesRead) fail('DESKTOP_IMAGE_ARCHIVE_CHANGED'); offset += next.bytesRead;
  }
  return bytes;
}

/** Bounded UTF-8 JSON parser: duplicate keys are rejected instead of selecting one. */
function json(bytes: Buffer): any {
  if (bytes.length > metadataMaximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); let at = 0, nodes = 0;
  const white = () => { while (/[\t\r\n ]/.test(source[at] ?? '') && at < source.length) at++; };
  const string = (): string => {
    const start = at++; if (source[start] !== '"') return fail();
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at));
    }
    return fail();
  };
  const value = (depth: number): any => {
    if (depth > 64 || ++nodes > 100_000) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT'); white();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; white(); const result: Record<string, unknown> = Object.create(null);
      if (source[at] === '}') { at++; return result; }
      while (true) {
        white(); const key = string(); if (Object.hasOwn(result, key)) fail(); white();
        if (source[at++] !== ':') fail(); result[key] = value(depth + 1); white();
        if (source[at] === '}') { at++; return result; } if (source[at++] !== ',') fail();
      }
    }
    if (source[at] === '[') {
      at++; white(); const result: unknown[] = [];
      if (source[at] === ']') { at++; return result; }
      while (true) { result.push(value(depth + 1)); white(); if (source[at] === ']') { at++; return result; } if (source[at++] !== ',') fail(); }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, at)) { at += token.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    if (!number || !Number.isFinite(Number(number[0]))) return fail(); at += number[0].length; return Number(number[0]);
  };
  const result = value(0); white(); if (at !== source.length) fail(); return result;
}
function object(value: any, allowed?: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) fail(); return value as Record<string, any>;
}
function annotations(input: unknown) {
  if (input === undefined) return;
  const values = object(input);
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || ['io.containerd.image.name', 'org.opencontainers.image.ref.name',
      'containerd.io/manifest-subject', 'vnd.docker.reference.type', 'vnd.docker.reference.digest'].includes(key)) fail();
  }
}
function platform(input: unknown) {
  if (input === undefined) return;
  const value = object(input, ['os', 'architecture', 'variant', 'os.version', 'os.features']);
  if (value.os !== 'linux' || value.architecture !== 'amd64' || ![undefined, '', 'v1'].includes(value.variant)
    || ![undefined, ''].includes(value['os.version'])
    || value['os.features'] !== undefined && (!Array.isArray(value['os.features']) || value['os.features'].length)) fail();
}
interface Descriptor { mediaType: string; digest: string; size: number; annotations?: Record<string, string> }
function descriptor(input: unknown): Descriptor {
  const value = object(input, ['mediaType', 'digest', 'size', 'annotations', 'platform', 'urls', 'data', 'artifactType']);
  if (typeof value.mediaType !== 'string' || !digestPattern.test(value.digest) || !Number.isSafeInteger(value.size)
    || value.size < 0 || value.size > maximum || value.urls !== undefined && (!Array.isArray(value.urls) || value.urls.length)
    || value.data !== undefined || value.artifactType !== undefined) fail();
  annotations(value.annotations); platform(value.platform); return value as Descriptor;
}

class Cursor {
  private readonly iterator: AsyncIterator<Buffer>; private current: Buffer = Buffer.alloc(0); private offset = 0;
  position = 0;
  constructor(source: AsyncIterable<Buffer>, private signal?: AbortSignal) { this.iterator = source[Symbol.asyncIterator](); }
  private async available() {
    checkSignal(this.signal);
    while (this.offset === this.current.length) {
      const next = await this.iterator.next(); if (next.done) return false;
      this.current = next.value; this.offset = 0;
    }
    return true;
  }
  async consume(count: number, visit?: (bytes: Buffer) => void) {
    if (!Number.isSafeInteger(count) || count < 0 || count > maximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
    while (count) {
      if (!await this.available()) fail(); const size = Math.min(count, this.current.length - this.offset);
      visit?.(this.current.subarray(this.offset, this.offset + size)); this.offset += size; this.position += size; count -= size;
    }
  }
  async read(count: number) {
    if (count > metadataMaximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
    const bytes = Buffer.alloc(count); let offset = 0;
    await this.consume(count, part => { part.copy(bytes, offset); offset += part.length; }); return bytes;
  }
  async zeroTail() {
    while (await this.available()) {
      const count = this.current.length - this.offset;
      await this.consume(count, bytes => { if (bytes.some(byte => byte !== 0)) fail(); });
    }
    if (this.position % 512) fail();
  }
}
function textField(bytes: Buffer) {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some(byte => byte !== 0)) fail();
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function numeric(bytes: Buffer, signed = false) {
  if (bytes[0] & 0x80) {
    const negative = Boolean(bytes[0] & 0x40); if (negative && !signed) fail(); let result = BigInt(bytes[0] & 0x7f);
    for (const byte of bytes.subarray(1)) result = result * 256n + BigInt(byte);
    if (negative) result -= 1n << BigInt(bytes.length * 8 - 1);
    if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT'); return Number(result);
  }
  if (bytes.some(byte => byte >= 128)) fail();
  const raw = bytes.toString('ascii').replace(/^[ \0]+|[ \0]+$/g, '');
  if (raw && !(signed ? /^-?[0-7]+$/ : /^[0-7]+$/).test(raw)) fail(); const result = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(result)) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT'); return result;
}
function tarPath(name: string, directory = false, inner = false) {
  if (inner) while (name.startsWith('./')) name = name.slice(2);
  if (directory && name.endsWith('/')) name = name.slice(0, -1);
  if (inner && directory && (name === '' || name === '.')) return '.';
  if (!name || Buffer.byteLength(name) > 4096 || /[\x00-\x1f\x7f\\]/.test(name) || name.startsWith('/')
    || name.split('/').some(part => !part || part === '.' || part === '..')) fail();
  if (!inner && !/^(?:manifest\.json|index\.json|oci-layout|repositories|blobs(?:\/sha256(?:\/[a-f0-9]{64})?)?)$/.test(name)) fail();
  return name;
}
function pax(bytes: Buffer, inner: boolean) {
  const result: Record<string, string> = Object.create(null); let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset); if (space < 0 || space - offset > 10) fail();
    const raw = bytes.subarray(offset, space).toString('ascii'); if (!/^[1-9][0-9]*$/.test(raw)) fail();
    const size = Number(raw), end = offset + size; if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) fail();
    const record = bytes.subarray(space + 1, end - 1), equal = record.indexOf(61); if (equal < 1) fail();
    const key = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.subarray(0, equal));
    // Linux xattrs (notably security.capability) are binary PAX values. They do
    // not alter paths/sizes; validate the record framing without interpreting them.
    const value = inner && key.startsWith('SCHILY.xattr.') ? ''
      : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.subarray(equal + 1));
    if (Object.hasOwn(result, key) || /sparse|realsize/i.test(key) || /[\x00-\x1f\x7f]/.test(key)) fail();
    result[key] = value; offset = end;
  }
  return result;
}
interface Member { name: string; size: number; offset: number; hash: string }
async function scanTar(source: AsyncIterable<Buffer>, inner: boolean, signal?: AbortSignal) {
  const reader = new Cursor(source, signal), members = new Map<string, Member>();
  let pending: Record<string, string> | undefined, global: Record<string, string> = Object.create(null);
  let longName: string | undefined, longLink: string | undefined, count = 0, fileBytes = 0;
  while (true) {
    const header = await reader.read(512);
    if (header.every(byte => byte === 0)) {
      if (pending || longName || longLink || (await reader.read(512)).some(byte => byte !== 0)) fail();
      await reader.zeroTail(); break;
    }
    if (++count > (inner ? 1_000_000 : 4096)) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== numeric(header.subarray(148, 156))) fail();
    const magic = header.subarray(257, 263).toString('latin1');
    if (magic !== 'ustar\0' && magic !== 'ustar ' && header.subarray(257, 265).some(byte => byte !== 0)) fail();
    if (magic === 'ustar\0' && header.subarray(263, 265).toString('latin1') !== '00'
      || magic === 'ustar ' && header.subarray(263, 265).toString('latin1') !== ' \0') fail();
    const type = String.fromCharCode(header[156] || 48);
    let name = textField(header.subarray(0, 100)), size = numeric(header.subarray(124, 136));
    let link = textField(header.subarray(157, 257));
    if (magic === 'ustar\0') { const prefix = textField(header.subarray(345, 500)); if (prefix) name = `${prefix}/${name}`; }
    textField(header.subarray(265, 297)); textField(header.subarray(297, 329));
    numeric(header.subarray(100, 108)); numeric(header.subarray(108, 116)); numeric(header.subarray(116, 124)); numeric(header.subarray(136, 148), true);
    if (magic.startsWith('ustar')) { numeric(header.subarray(329, 337)); numeric(header.subarray(337, 345)); }
    if (size > maximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
    if (type === 'x' || inner && ['g', 'L', 'K'].includes(type)) {
      if (pending || size > 64 * 1024 || !size || link) fail();
      if (name.startsWith('/') || name.split('/').includes('..') || /[\x00-\x1f\x7f\\]/.test(name)) fail();
      const data = await reader.read(size);
      if (type === 'x') pending = pax(data, inner);
      else if (type === 'g') {
        const records = pax(data, inner);
        if (Object.keys(records).some(key => !['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment'].includes(key))) fail();
        global = { ...global, ...records };
      }
      else if (type === 'L' && !longName) longName = textField(data);
      else if (type === 'K' && !longLink) longLink = textField(data);
      else fail();
      await reader.consume((512 - size % 512) % 512, bytes => { if (bytes.some(byte => byte !== 0)) fail(); }); continue;
    }
    const attributes = { ...global, ...pending };
    if (Object.keys(attributes).length) {
      for (const key of Object.keys(attributes)) {
        if (!['path', 'linkpath', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment'].includes(key)
          && !(inner && key.startsWith('SCHILY.xattr.'))) fail();
        if (['mtime', 'atime', 'ctime'].includes(key) && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(attributes[key])) fail();
        if (['uid', 'gid'].includes(key) && (!/^[0-9]+$/.test(attributes[key]) || !Number.isSafeInteger(Number(attributes[key])))) fail();
      }
      name = attributes.path ?? name; link = attributes.linkpath ?? link;
      if (attributes.size !== undefined) { if (!/^(?:0|[1-9][0-9]*)$/.test(attributes.size)) fail(); size = Number(attributes.size); }
    }
    if (longName) name = longName; if (longLink) link = longLink;
    pending = undefined; longName = undefined; longLink = undefined;
    if (!Number.isSafeInteger(size) || size > maximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
    const directory = type === '5'; name = tarPath(name, directory, inner);
    if ((!inner && !['0', '5'].includes(type)) || inner && !['0', '1', '2', '3', '4', '5', '6'].includes(type)) fail();
    if (type !== '0' && size || !['1', '2'].includes(type) && link) fail();
    if (inner && type === '1') tarPath(link, false, true);
    if (!inner && (members.has(name) || directory && !['blobs', 'blobs/sha256'].includes(name))) fail();
    if (!inner && !directory && (name === 'blobs' || name === 'blobs/sha256')) fail();
    fileBytes += size; if (fileBytes > maximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
    const offset = reader.position, hash = createHash('sha256');
    await reader.consume(size, inner ? undefined : bytes => hash.update(bytes));
    await reader.consume((512 - size % 512) % 512, bytes => { if (bytes.some(byte => byte !== 0)) fail(); });
    if (!inner) members.set(name, { name, size, offset, hash: directory ? '' : hash.digest('hex') });
  }
  return { members, fileBytes };
}

/** Verify before Docker load. No extraction, Docker command, authentication or path reopen occurs. */
export async function verifyDesktopImageArchive(input: string, expected: DesktopImageArchivePin, signal?: AbortSignal): Promise<VerifiedDesktopImageArchive> {
  let file: FileHandle | undefined;
  try {
    const pin = { image: expected.image, bytes: expected.bytes, sha256: expected.sha256 };
    checkSignal(signal);
    if (!digestPattern.test(pin.image) || !hexPattern.test(pin.sha256) || !Number.isSafeInteger(pin.bytes)
      || pin.bytes < 1024 || pin.bytes > maximum || pin.bytes % 512) fail();
    const path = filename(input), parents = await directories(path), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(pin.bytes)
      || relative(path, await realpath(path))) fail();
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const source = file; await unchanged(path, source, before, parents);
    // At most 4 MiB of chunk digests for an 8 GiB archive; no archive-sized buffer.
    const pins = Buffer.alloc(Math.ceil(pin.bytes / blockSize) * 32), archiveHash = createHash('sha256');
    async function* firstPass() {
      for (let offset = 0; offset < pin.bytes; offset += blockSize) {
        const bytes = await block(source, offset, Math.min(blockSize, pin.bytes - offset), signal);
        sha(bytes).copy(pins, offset / blockSize * 32); archiveHash.update(bytes); yield bytes;
      }
    }
    const { members } = await scanTar(firstPass(), false, signal);
    if (archiveHash.digest('hex') !== pin.sha256) fail(); await unchanged(path, source, before, parents);
    async function* range(start: number, length: number, readSignal?: AbortSignal) {
      for (let offset = Math.floor(start / blockSize) * blockSize; offset < start + length; offset += blockSize) {
        checkSignal(readSignal);
        const bytes = await block(source, offset, Math.min(blockSize, pin.bytes - offset), readSignal);
        if (!sha(bytes).equals(pins.subarray(offset / blockSize * 32, offset / blockSize * 32 + 32))) fail('DESKTOP_IMAGE_ARCHIVE_CHANGED');
        yield bytes.subarray(Math.max(start - offset, 0), Math.min(bytes.length, start + length - offset));
      }
    }
    const read = async (member: Member) => {
      if (member.size > metadataMaximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
      const chunks: Buffer[] = []; for await (const chunk of range(member.offset, member.size, signal)) chunks.push(chunk); return json(Buffer.concat(chunks));
    };
    const required = (name: string) => { const member = members.get(name); if (!member?.hash) return fail(); return member; };
    const used = new Set(['oci-layout', 'index.json', 'manifest.json', 'blobs', 'blobs/sha256']);
    const layout = object(await read(required('oci-layout')), ['imageLayoutVersion']); if (layout.imageLayoutVersion !== '1.0.0') fail();
    if (members.has('repositories') && Object.keys(object(await read(required('repositories')))).length) fail(); used.add('repositories');
    for (const member of members.values()) if (member.name.startsWith('blobs/sha256/') && member.hash !== member.name.slice(13)) fail();
    const blob = (desc: Descriptor) => {
      const name = `blobs/sha256/${desc.digest.slice(7)}`, entry = required(name);
      if (entry.size !== desc.size || entry.hash !== desc.digest.slice(7)) fail(); used.add(name); return entry;
    };
    const graphIds = new Set<string>(); let manifest: Record<string, any> | undefined, manifestDigest = '', manifestType = '', topLevelDigest = '';
    let current = object(await read(required('index.json'))), depth = 0, indexType = `${oci}index.v1+json`;
    while (true) {
      object(current, ['schemaVersion', 'mediaType', 'manifests', 'annotations']); annotations(current.annotations);
      if (current.schemaVersion !== 2 || current.mediaType !== undefined && current.mediaType !== indexType
        || !Array.isArray(current.manifests) || current.manifests.length !== 1 || ++depth > 8) fail();
      const desc = descriptor(current.manifests[0]); if (graphIds.has(desc.digest)) fail(); graphIds.add(desc.digest);
      if (depth === 1) topLevelDigest = desc.digest;
      const body = object(await read(blob(desc)));
      if (manifestTypes.has(desc.mediaType)) { manifest = body; manifestDigest = desc.digest; manifestType = desc.mediaType; break; }
      if (!indexTypes.has(desc.mediaType)) fail(); current = body; indexType = desc.mediaType;
    }
    object(manifest, ['schemaVersion', 'mediaType', 'config', 'layers', 'annotations']); annotations(manifest!.annotations);
    if (manifest!.schemaVersion !== 2 || manifest!.mediaType !== undefined && manifest!.mediaType !== manifestType
      || !Array.isArray(manifest!.layers) || manifest!.layers.length > 512) fail();
    const config = descriptor(manifest!.config); if (!configTypes.has(config.mediaType)) fail();
    const configBody = object(await read(blob(config)));
    for (const key of Object.keys(configBody)) if (['os', 'architecture', 'variant', 'rootfs'].includes(key.toLowerCase()) && key !== key.toLowerCase()) fail();
    platform({ os: configBody.os, architecture: configBody.architecture, variant: configBody.variant });
    const rootfs = object(configBody.rootfs, ['type', 'diff_ids']);
    if (rootfs.type !== 'layers' || !Array.isArray(rootfs.diff_ids) || rootfs.diff_ids.length !== manifest!.layers.length
      || rootfs.diff_ids.some((id: unknown) => typeof id !== 'string' || !digestPattern.test(id))) fail();
    const layers = manifest!.layers.map(descriptor) as Descriptor[];
    const compatibility = await read(required('manifest.json'));
    if (!Array.isArray(compatibility) || compatibility.length !== 1) fail();
    const legacy = object(compatibility[0], ['Config', 'RepoTags', 'Layers', 'LayerSources', 'Parent']);
    if (legacy.Config !== `blobs/sha256/${config.digest.slice(7)}` || legacy.Parent
      || legacy.RepoTags !== null && legacy.RepoTags !== undefined && (!Array.isArray(legacy.RepoTags) || legacy.RepoTags.length)
      || !Array.isArray(legacy.Layers) || legacy.Layers.length !== layers.length
      || legacy.Layers.some((name: unknown, index: number) => name !== `blobs/sha256/${layers[index].digest.slice(7)}`)) fail();
    if (legacy.LayerSources !== undefined) {
      const sources = object(legacy.LayerSources);
      if (Object.keys(sources).some(id => !rootfs.diff_ids.includes(id))) fail();
      for (let index = 0; index < layers.length; index++) {
        const sourceDescriptor = descriptor(sources[rootfs.diff_ids[index]]), expected = layers[index];
        if (sourceDescriptor.digest !== expected.digest || sourceDescriptor.size !== expected.size || sourceDescriptor.mediaType !== expected.mediaType) fail();
      }
    }
    // containerd Import creates image records only for the outer index's direct
    // descriptors; nested content digests are not independently addressable images.
    // Classic Docker instead creates the image identified by its config digest.
    const identityKind = pin.image === config.digest ? 'config' : pin.image === topLevelDigest
      ? topLevelDigest === manifestDigest ? 'manifest' : 'index' : undefined;
    if (!identityKind) fail();
    let layerBytes = 0, layerFileBytes = 0;
    const checkedLayers = new Map<string, { hash: string; bytes: number; fileBytes: number }>();
    for (let index = 0; index < layers.length; index++) {
      checkSignal(signal); const layer = layers[index], mode = layerTypes.get(layer.mediaType); if (!mode) fail();
      const entry = blob(layer); let checked = checkedLayers.get(layer.digest);
      if (!checked) {
        const hash = createHash('sha256'); let bytes = 0, fileBytes = 0;
        const inputStream = Readable.from(range(entry.offset, entry.size, signal));
        const inspect = async (stream: AsyncIterable<Buffer>) => {
          async function* counted() {
            for await (const chunk of stream) { checkSignal(signal); bytes += chunk.length;
              if (bytes + layerBytes > maximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT'); hash.update(chunk); yield chunk; }
          }
          fileBytes = (await scanTar(counted(), true, signal)).fileBytes;
        };
        if (mode === 'raw') await pipeline(inputStream, inspect, { signal });
        else {
          const decoder = mode === 'gzip' ? createGunzip({ chunkSize: blockSize })
            : createZstdDecompress({ chunkSize: blockSize, params: { [zlibConstants.ZSTD_d_windowLogMax]: 27 } });
          await pipeline(inputStream, decoder, inspect, { signal });
        }
        checked = { hash: `sha256:${hash.digest('hex')}`, bytes, fileBytes }; checkedLayers.set(layer.digest, checked);
      }
      if (checked.hash !== rootfs.diff_ids[index]) fail(); layerBytes += checked.bytes; layerFileBytes += checked.fileBytes;
      if (layerBytes > maximum || layerFileBytes > maximum) fail('DESKTOP_IMAGE_ARCHIVE_LIMIT');
    }
    // Classic Docker 29 also writes one unreferenced legacy V1 config per layer.
    const v1 = new Map<string, string | undefined>();
    for (const entry of members.values()) {
      if (used.has(entry.name)) continue;
      if (!legacy.LayerSources || !entry.name.startsWith('blobs/sha256/') || v1.size >= layers.length) fail();
      const value = object(await read(entry));
      if (!hexPattern.test(value.id) || value.parent !== undefined && !hexPattern.test(value.parent)
        || value.os !== undefined && value.os !== 'linux' || value.rootfs !== undefined || value.manifests !== undefined
        || value.schemaVersion !== undefined || value.layers !== undefined || v1.has(value.id)) fail();
      v1.set(value.id, value.parent);
    }
    if (v1.size) {
      if (v1.size !== layers.length) fail();
      const heads = [...v1.keys()].filter(id => ![...v1.values()].includes(id)); if (heads.length !== 1) fail();
      const seen = new Set<string>(); let id: string | undefined = heads[0];
      while (id) { if (seen.has(id) || !v1.has(id)) fail(); seen.add(id); id = v1.get(id); }
      if (seen.size !== v1.size) fail();
    }
    await unchanged(path, source, before, parents); checkSignal(signal);
    let closed = false, reading = false, closing: Promise<void> | undefined;
    const result: VerifiedDesktopImageArchive = {
      image: pin.image, imageIdentity: identityKind!, configDigest: config.digest, manifestDigest,
      format: legacy.LayerSources ? 'docker29-classic' : 'docker29-oci', archiveBytes: pin.bytes, layerBytes, layerFileBytes, layerCount: layers.length,
      async *chunks(readSignal?: AbortSignal) {
        if (closed) fail('DESKTOP_IMAGE_ARCHIVE_CLOSED'); if (reading) fail(); reading = true;
        try {
          checkSignal(readSignal);
          await unchanged(path, source, before, parents);
          for await (const chunk of range(0, pin.bytes, readSignal)) { if (closed) fail('DESKTOP_IMAGE_ARCHIVE_CLOSED'); checkSignal(readSignal); yield chunk; }
          await unchanged(path, source, before, parents);
        } catch (error) { if (error instanceof DesktopImageArchiveError) throw error; checkSignal(readSignal); fail(); }
        finally { reading = false; }
      },
      close() { closed = true; return closing ??= source.close().catch(() => fail()); },
    };
    file = undefined; return Object.freeze(result);
  } catch (error) {
    try { await file?.close(); } catch { return fail(); }
    if (error instanceof DesktopImageArchiveError) throw error; checkSignal(signal); return fail();
  }
}
