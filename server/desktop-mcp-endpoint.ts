import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const desktopMcpEndpointSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), epoch: z.uuid(),
  origin: z.string().refine(value => {
    const port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value)?.[1];
    // A default-port URL would lose its explicit port when sent by fetch.
    return port !== undefined && Number(port) <= 65535 && Number(port) !== 80;
  }) }).strict();
export type DesktopMcpEndpoint = z.infer<typeof desktopMcpEndpointSchema>;
const invalid = () => new Error('DESKTOP_MCP_ENDPOINT_INVALID');
async function parents(input: string) {
  if (!isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input) || input.split(/[\\/]/).some(part => part === '.' || part === '..')) throw invalid();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(input) || input.slice(3).split(/[\\/]/).some(part =>
    /[<>:"|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw invalid();
  const path = resolve(input), entries: { path: string; dev: bigint; ino: bigint }[] = []; let cursor = parse(path).root;
  for (const component of relative(cursor, path).split(/[\\/]/).slice(0, -1)) {
    cursor = join(cursor, component); const info = await lstat(cursor, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw invalid();
    entries.push({ path: cursor, dev: info.dev, ino: info.ino });
  }
  return { path, async recheck() {
    for (const entry of entries) {
      const info = await lstat(entry.path, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== entry.dev || info.ino !== entry.ino
        || relative(entry.path, await realpath(entry.path))) throw invalid();
    }
  } };
}
export async function readDesktopMcpEndpoint(path: string, ownerKey: string): Promise<DesktopMcpEndpoint> {
  try {
    z.uuid().parse(ownerKey); const checked = await parents(path), before = await lstat(checked.path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n
      || relative(checked.path, await realpath(checked.path))) throw invalid();
    const handle = await open(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stable = (after: typeof before) => after.isFile() && after.nlink === 1n && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
    try {
      if (!stable(await handle.stat({ bigint: true }))) throw invalid();
      const data = Buffer.alloc(4097); let length = 0;
      while (length < data.length) { const part = await handle.read(data, length, data.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
      if (BigInt(length) !== before.size || !stable(await handle.stat({ bigint: true })) || !stable(await lstat(checked.path, { bigint: true }))) throw invalid();
      await checked.recheck();
      const value = desktopMcpEndpointSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length))));
      if (value.ownerKey !== ownerKey) throw invalid();
      return value;
    } finally { await handle.close(); }
  } catch { throw invalid(); }
}

/** Public discovery only. Neither the desktop administrator token nor grant secrets are written here. */
export async function publishDesktopMcpEndpoint(path: string, value: DesktopMcpEndpoint): Promise<() => Promise<void>> {
  const endpoint = desktopMcpEndpointSchema.parse(value), checked = await parents(path);
  const previous = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (previous) await readDesktopMcpEndpoint(path, endpoint.ownerKey);
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(endpoint)); await handle.sync(); } finally { await handle.close(); }
  await checked.recheck();
  // The enclosing installation lease excludes another publisher. Preserve foreign or replaced files.
  const current = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (Boolean(current) !== Boolean(previous) || (current && previous && (current.dev !== previous.dev || current.ino !== previous.ino
    || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs || current.size !== previous.size))) throw invalid();
  await rename(temporary, path);
  const published = await readDesktopMcpEndpoint(path, endpoint.ownerKey);
  if (published.epoch !== endpoint.epoch) throw invalid();
  let released = false;
  return async () => {
    if (released) return;
    const existing = await readDesktopMcpEndpoint(path, endpoint.ownerKey);
    if (existing.epoch !== endpoint.epoch) throw invalid();
    await checked.recheck(); await unlink(path); released = true;
  };
}
