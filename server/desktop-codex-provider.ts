import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';

const version = '0.154.0' as const;
const maximumExecutable = 512 * 1024 * 1024, maximumLicense = 1024 * 1024, maximumManifest = 16 * 1024;
const fileSchema = (file: string, maximum: number) => z.object({
  file: z.literal(file), bytes: z.number().int().min(1).max(maximum),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), provider: z.literal('codex'), version: z.literal(version),
  target: z.literal('x86_64-pc-windows-msvc'),
  executable: fileSchema('codex.exe', maximumExecutable), license: fileSchema('LICENSE', maximumLicense),
}).strict();

/** Never expose a filesystem path, upstream error, or untrusted manifest content. */
export class DesktopCodexProviderError extends Error {
  readonly code = 'CODEX_PROVIDER_INVALID';
  constructor() { super('CODEX_PROVIDER_INVALID'); this.name = 'DesktopCodexProviderError'; }
}
function invalid(): never { throw new DesktopCodexProviderError(); }

function resourcePath(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    || value.split(/[\\/]/).some(part => part === '.' || part === '..')) invalid();
  if (process.platform === 'win32') {
    // The native parent supplies ordinary local DOS paths. Do not resolve UNC,
    // device namespaces, drive-relative paths or alternate data streams.
    if (!/^[a-zA-Z]:[\\/]/.test(value)) invalid();
    for (const part of value.slice(3).split(/[\\/]/).filter(Boolean)) {
      if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part)
        || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)) invalid();
    }
  }
  const path = resolve(value);
  if (path === parse(path).root) invalid();
  return path;
}

type Entry = { path: string; metadata: BigIntStats };
async function metadata(path: string, optional = false): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && right.isFile() && right.nlink === 1n
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function checkedDirectory(path: string, entries: Entry[], optional = false): Promise<boolean> {
  const entry = await metadata(path, optional);
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isDirectory() || relative(path, await realpath(path))) invalid();
  entries.push({ path, metadata: entry });
  return true;
}
async function recheckDirectories(entries: Entry[]): Promise<void> {
  for (const entry of entries) {
    const current = await metadata(entry.path);
    if (!current || current.isSymbolicLink() || !current.isDirectory()
      || !sameIdentity(entry.metadata, current) || relative(entry.path, await realpath(entry.path))) invalid();
  }
}
async function recheckFile(entry: Entry): Promise<void> {
  const current = await metadata(entry.path);
  if (!current || current.isSymbolicLink() || !sameFile(entry.metadata, current)
    || relative(entry.path, await realpath(entry.path))) invalid();
}

/** Hash the opened descriptor in bounded chunks; never load the executable into memory. */
async function checkedFile(path: string, maximum: number, directories: Entry[], options: {
  optional?: boolean; capture?: boolean; expected?: { bytes: number; sha256: string };
} = {}): Promise<{ entry: Entry; sha256: string; bytes: Buffer } | null> {
  const before = await metadata(path, options.optional);
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximum)
    || (options.expected && before.size !== BigInt(options.expected.bytes))) invalid();
  await recheckDirectories(directories);
  if (relative(path, await realpath(path))) invalid();
  // O_NONBLOCK prevents a raced FIFO substitution from blocking before fstat.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) invalid();
    const hash = createHash('sha256'), chunks: Buffer[] = [], buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1));
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maximum + 1 - total), total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum || BigInt(total) > before.size) invalid();
      hash.update(buffer.subarray(0, bytesRead));
      if (options.capture) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (BigInt(total) !== before.size || !sameFile(before, await handle.stat({ bigint: true }))) invalid();
    const sha256 = hash.digest('hex'), entry = { path, metadata: before };
    if (options.expected && sha256 !== options.expected.sha256.toLowerCase()) invalid();
    await recheckDirectories(directories);
    await recheckFile(entry);
    return { entry, sha256, bytes: Buffer.concat(chunks) };
  } finally { await handle.close(); }
}

/** Resolve only the installed provider. No PATH, npm, home, download or process fallback. */
export async function resolveDesktopCodexProvider(resourceRoot: string): Promise<{
  executable: string; version: typeof version; sha256: string;
} | null> {
  try {
    const root = resourcePath(resourceRoot), directories: Entry[] = [];
    let cursor = parse(root).root;
    await checkedDirectory(cursor, directories);
    for (const component of relative(cursor, root).split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, component);
      await checkedDirectory(cursor, directories);
    }
    for (const component of ['providers', 'codex']) {
      cursor = join(cursor, component);
      if (!await checkedDirectory(cursor, directories, true)) {
        await recheckDirectories(directories); return null;
      }
    }
    const manifest = await checkedFile(join(cursor, 'provider.json'), maximumManifest, directories, { optional: true, capture: true });
    if (!manifest) { await recheckDirectories(directories); return null; }
    const parsed = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)));
    const executable = join(cursor, 'codex.exe');
    const binary = await checkedFile(executable, maximumExecutable, directories, { expected: parsed.executable });
    const license = await checkedFile(join(cursor, 'LICENSE'), maximumLicense, directories, { expected: parsed.license });
    if (!binary || !license) invalid();
    await recheckDirectories(directories);
    for (const file of [manifest, binary, license]) await recheckFile(file.entry);
    return { executable, version, sha256: binary.sha256 };
  } catch { throw new DesktopCodexProviderError(); }
}
