import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readDesktopPayload } from './desktop-payload.ts';
import { assertDesktopProviderDirectory, verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';

/** Retire only the compiler's duplicate payload after the installer is verified.
 * Keep the staged payload, executable, setup, manifests and compilation cache.
 * Explicit member unlinks and empty-directory removal never remove extra files.
 */
export async function retireDesktopCompilerPayload(destination: string) {
  const root = resolve(destination);
  if (!isAbsolute(destination) || root !== destination) throw Error('DESKTOP_RETIREMENT_PATH_INVALID');
  await assertDesktopProviderDirectory(root);
  const payloadRoot = join(root, 'payload'), payload = await readDesktopPayload(payloadRoot);
  const compiled = join(root, 'target/x86_64-pc-windows-msvc/release');
  const found: string[] = [], directories: string[] = [];
  const pins = new Map(payload.manifest.files.map(file => [file.path, file]));
  async function visit(path: string) {
    const scoped = relative(compiled, path);
    if (!scoped || isAbsolute(scoped) || scoped === '..' || scoped.startsWith(`..${sep}`)) throw Error('DESKTOP_RETIREMENT_PATH_INVALID');
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error('DESKTOP_RETIREMENT_LINK');
    if (info.isDirectory()) {
      await assertDesktopProviderDirectory(path); directories.push(path);
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else {
      const name = relative(compiled, path).replaceAll('\\', '/');
      if (!info.isFile() || !pins.has(name)) throw Error('DESKTOP_RETIREMENT_EXTRA_FILE');
      found.push(name);
    }
  }
  for (const part of ['resources', 'binaries']) {
    const path = join(compiled, part);
    try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await visit(path);
  }
  // Complete validation precedes every mutation, including retained copies.
  for (const name of found) {
    const pin = pins.get(name)!;
    await verifyPinnedDesktopPayloadFile(join(payloadRoot, name), pin);
    await verifyPinnedDesktopPayloadFile(join(compiled, name), pin);
  }
  let bytes = 0;
  for (const name of found) {
    const pin = pins.get(name)!;
    await verifyPinnedDesktopPayloadFile(join(payloadRoot, name), pin);
    await verifyPinnedDesktopPayloadFile(join(compiled, name), pin);
    await unlink(join(compiled, name)); bytes += pin.bytes;
  }
  for (const path of directories.reverse()) { await assertDesktopProviderDirectory(path); await rmdir(path); }
  return { files: found.length, bytes, retained: payloadRoot, removedRoots: ['resources', 'binaries'].map(part => join(compiled, part)) };
}
