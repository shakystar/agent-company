import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

export type PinnedDesktopFile = { bytes: number; sha256: string };
type Directory = { path: string; stat: BigIntStats };
const invalid = () => new Error('DESKTOP_PROVIDER_INPUT_INVALID');

function localPath(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    || value.split(/[\\/]/).some(part => part === '.' || part === '..')) throw invalid();
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value)) throw invalid();
    if (value.slice(3).split(/[\\/]/).some(part => /[<>:"|?*]|[. ]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) throw invalid();
  }
  const path = resolve(value);
  if (path === parse(path).root) throw invalid();
  return path;
}
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats) => identity(a, b) && b.isFile() && b.nlink === 1n
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function parentDirectories(path: string): Promise<Directory[]> {
  const entries: Directory[] = [];
  let cursor = parse(path).root;
  const parts = relative(cursor, path).split(/[\\/]/); parts.pop();
  for (const part of ['', ...parts]) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw invalid();
    entries.push({ path: cursor, stat });
  }
  return entries;
}
async function recheck(entries: Directory[]) {
  for (const entry of entries) {
    const now = await lstat(entry.path, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || !identity(entry.stat, now)
      || relative(entry.path, await realpath(entry.path))) throw invalid();
  }
}

export async function assertDesktopProviderDirectory(directory: string): Promise<void> {
  const path = localPath(directory);
  const entries = await parentDirectories(join(path, '__provider_path_probe__'));
  await recheck(entries);
}

/** Hash an explicit payload member without loading a large file into memory. Empty members are allowed. */
export async function inspectDesktopFile(input: string, maximumBytes = 8 * 1024 ** 3): Promise<PinnedDesktopFile> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 8 * 1024 ** 3) throw invalid();
  const path = localPath(input), parents = await parentDirectories(path), before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximumBytes)
    || relative(path, await realpath(path))) throw invalid();
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, await source.stat({ bigint: true }))) throw invalid();
    const buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256'), size = Number(before.size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw invalid();
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (!sameFile(before, await source.stat({ bigint: true }))) throw invalid();
    await recheck(parents);
    if (!sameFile(before, await lstat(path, { bigint: true })) || relative(path, await realpath(path))) throw invalid();
    return { bytes: size, sha256: hash.digest('hex') };
  } finally { await source.close(); }
}

/** Small manifests/source files only; the caller parses this checked byte snapshot. */
export async function readDesktopProviderFile(input: string, maximumBytes: number): Promise<{ data: Buffer; pin: PinnedDesktopFile }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2 * 1024 * 1024) throw invalid();
  const path = localPath(input), parents = await parentDirectories(path), before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximumBytes)
    || relative(path, await realpath(path))) throw invalid();
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, await source.stat({ bigint: true }))) throw invalid();
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) {
      const part = await source.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (BigInt(length) !== before.size || !sameFile(before, await source.stat({ bigint: true }))) throw invalid();
    await recheck(parents);
    if (!sameFile(before, await lstat(path, { bigint: true })) || relative(path, await realpath(path))) throw invalid();
    const data = bytes.subarray(0, length);
    return { data, pin: { bytes: length, sha256: createHash('sha256').update(data).digest('hex') } };
  } finally { await source.close(); }
}

/** Build-time local inputs only. Never execute the binary or load adjacent configuration. */
export async function verifyPinnedDesktopFile(input: string, pin: PinnedDesktopFile, options: {
  windowsX64Executable?: boolean; destination?: string;
} = {}): Promise<void> {
  return verifyFile(input, pin, options, 512 * 1024 * 1024);
}

/** Docker save archives only. Tar semantics and actual image loading are separate verification gates. */
export async function verifyPinnedDesktopArchive(input: string, pin: PinnedDesktopFile,
  options: { destination?: string } = {}): Promise<void> {
  return verifyFile(input, pin, options, 8 * 1024 ** 3);
}

/** Only explicit manifest members. Size admission and manifest scope remain the caller's responsibility. */
export async function verifyPinnedDesktopPayloadFile(input: string, pin: PinnedDesktopFile,
  options: { destination?: string } = {}): Promise<void> {
  return verifyFile(input, pin, options, 8 * 1024 ** 3, 0);
}

async function verifyFile(input: string, pin: PinnedDesktopFile, options: {
  windowsX64Executable?: boolean; destination?: string;
}, maximumBytes: number, minimumBytes = 1): Promise<void> {
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < minimumBytes || pin.bytes > maximumBytes
    || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw invalid();
  const path = localPath(input), parents = await parentDirectories(path);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(pin.bytes)
    || relative(path, await realpath(path))) throw invalid();
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let destination: string | undefined, outputParents: Directory[] = [];
  try {
    if (!sameFile(before, await source.stat({ bigint: true }))) throw invalid();
    if (options.windowsX64Executable) {
      const header = Buffer.alloc(64);
      if ((await source.read(header, 0, header.length, 0)).bytesRead !== header.length
        || header.readUInt16LE(0) !== 0x5a4d) throw invalid();
      const offset = header.readUInt32LE(0x3c), pe = Buffer.alloc(26);
      if (offset < 64 || offset > pin.bytes - pe.length
        || (await source.read(pe, 0, pe.length, offset)).bytesRead !== pe.length
        || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664 || pe.readUInt16LE(24) !== 0x20b) throw invalid();
    }
    if (options.destination) {
      destination = localPath(options.destination);
      outputParents = await parentDirectories(destination);
      output = await open(destination, 'wx', 0o600);
    }
    const buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256');
    let offset = 0;
    while (offset < pin.bytes) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, pin.bytes - offset), offset);
      if (!bytesRead) throw invalid();
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset + written);
          if (!bytesWritten) throw invalid();
          written += bytesWritten;
        }
      }
      offset += bytesRead;
    }
    if (hash.digest('hex') !== pin.sha256 || !sameFile(before, await source.stat({ bigint: true }))) throw invalid();
    await recheck(parents);
    if (!sameFile(before, await lstat(path, { bigint: true })) || relative(path, await realpath(path))) throw invalid();
    if (output && destination) {
      await output.sync();
      const actual = await output.stat({ bigint: true });
      if (!actual.isFile() || actual.nlink !== 1n || actual.size !== BigInt(pin.bytes)
        || !sameFile(actual, await lstat(destination, { bigint: true }))
        || relative(destination, await realpath(destination))) throw invalid();
      await recheck(outputParents);
    }
  } finally {
    // Partial files remain in the new, unpublished candidate for diagnosis. No overwrite or cleanup of other candidates.
    try { await output?.close(); } finally { await source.close(); }
  }
}
