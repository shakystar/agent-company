import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { requireWorkerRelease, validateWorkerReleaseCatalog, workerImageSchema, workerSourceFiles,
  type WorkerReleaseCatalog } from '../shared/runtime-releases.ts';

const maximumManifest = 2 * 1024 * 1024, maximumFile = 1024 * 1024;
const engineSchema = z.object({ version: z.literal('29.1.3'), arch: z.literal('amd64'), sandbox: z.literal('codex-userns') }).strict();
const manifestSchema = z.object({ version: z.literal(1), provider: z.literal('codex'), codexVersion: z.literal('0.154.0'),
  target: z.literal('linux-x64'), engine: engineSchema, releaseCatalog: z.unknown(), browserImage: workerImageSchema.optional() }).strict();

export interface DesktopWorkerProvider {
  readonly codexVersion: '0.154.0';
  readonly engine: Readonly<z.infer<typeof engineSchema>>;
  readonly releaseCatalog: WorkerReleaseCatalog;
  readonly browserImage?: string;
}
export class DesktopWorkerProviderError extends Error {
  readonly code = 'DESKTOP_WORKER_PROVIDER_INVALID';
  constructor() { super('DESKTOP_WORKER_PROVIDER_INVALID'); this.name = 'DesktopWorkerProviderError'; }
}
function invalid(): never { throw new DesktopWorkerProviderError(); }
function resourcePath(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    || value.split(/[\\/]/).some(part => part === '.' || part === '..')) invalid();
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value)) invalid();
    for (const part of value.slice(3).split(/[\\/]/).filter(Boolean)) {
      if (/[<>:"|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)) invalid();
    }
  }
  const path = resolve(value);
  if (path === parse(path).root) invalid();
  return path;
}
type Entry = { path: string; stat: BigIntStats };
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && b.isFile() && b.nlink === 1n
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function metadata(path: string, optional: boolean): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function directory(path: string, directories: Entry[], optional = false): Promise<boolean> {
  const stat = await metadata(path, optional);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(path, await realpath(path))) invalid();
  directories.push({ path, stat }); return true;
}
async function recheckDirectories(directories: Entry[]): Promise<void> {
  for (const entry of directories) {
    const now = await lstat(entry.path, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || !sameIdentity(entry.stat, now)
      || relative(entry.path, await realpath(entry.path))) invalid();
  }
}
async function recheckFile(entry: Entry): Promise<void> {
  const now = await lstat(entry.path, { bigint: true });
  if (now.isSymbolicLink() || !sameFile(entry.stat, now) || relative(entry.path, await realpath(entry.path))) invalid();
}
async function checkedFile(path: string, maximum: number, directories: Entry[], options: {
  optional?: boolean; capture?: boolean; minimum?: number;
} = {}): Promise<{ entry: Entry; hash: string; bytes: Buffer } | null> {
  const before = await metadata(path, options.optional ?? false);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < BigInt(options.minimum ?? 0)
    || before.size > BigInt(maximum) || relative(path, await realpath(path))) invalid();
  await recheckDirectories(directories);
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
    const entry = { path, stat: before };
    await recheckDirectories(directories); await recheckFile(entry);
    return { entry, hash: hash.digest('hex'), bytes: Buffer.concat(chunks) };
  } finally { await handle.close(); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Installed-file verification only. No image lookup/pull, engine probe, process or host-auth fallback. */
export async function resolveDesktopWorkerProvider(resourceRoot: string): Promise<DesktopWorkerProvider | null> {
  try {
    const root = resourcePath(resourceRoot), directories: Entry[] = [], files: Entry[] = [];
    let cursor = parse(root).root;
    await directory(cursor, directories);
    for (const component of relative(cursor, root).split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, component); await directory(cursor, directories);
    }
    for (const component of ['runtimes', 'codex']) {
      cursor = join(cursor, component);
      if (!await directory(cursor, directories, true)) { await recheckDirectories(directories); return null; }
    }
    const manifest = await checkedFile(join(cursor, 'worker.json'), maximumManifest, directories, { optional: true, capture: true, minimum: 1 });
    if (!manifest) { await recheckDirectories(directories); return null; }
    files.push(manifest.entry);
    const parsed = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)));
    const releaseCatalog = validateWorkerReleaseCatalog(parsed.releaseCatalog);
    const active = requireWorkerRelease(releaseCatalog, releaseCatalog.active);
    const worker = join(root, 'worker'); await directory(worker, directories);
    for (const name of workerSourceFiles) {
      const file = await checkedFile(join(worker, name), maximumFile, directories);
      if (!file || file.hash !== active.sourceHashes[name]) invalid();
      files.push(file.entry);
    }
    const security = join(worker, 'security'); await directory(security, directories);
    for (const name of ['codex-userns.json', ...(parsed.browserImage ? ['browser-userns.json'] : [])]) {
      const file = await checkedFile(join(security, name), maximumFile, directories, { minimum: 1 });
      if (!file) invalid();
      files.push(file.entry);
    }
    await recheckDirectories(directories);
    for (const file of files) await recheckFile(file);
    return freeze({ codexVersion: parsed.codexVersion, engine: parsed.engine, releaseCatalog,
      ...(parsed.browserImage ? { browserImage: parsed.browserImage } : {}) });
  } catch { throw new DesktopWorkerProviderError(); }
}
