import { mkdir, readdir, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertDesktopProviderDirectory, readDesktopProviderFile, verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';

export const desktopPayloadMaximumFileBytes = 8 * 1024 ** 3;
export const desktopPayloadFreeSpaceFloor = 20n * 1024n ** 3n;
const manifestSchema = z.object({ version: z.literal(1), target: z.literal('x86_64-pc-windows-msvc'), protocol: z.literal(1),
  entry: z.literal('resources/server/desktop-entry.js'), distributionReady: z.literal(false), node: z.string().max(100).optional(),
  files: z.array(z.object({ path: z.string().min(1).max(1000), bytes: z.number().int().nonnegative().max(desktopPayloadMaximumFileBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(20_000) }).passthrough();
export type DesktopPayloadManifest = z.infer<typeof manifestSchema>;
export interface DesktopPayload {
  source: string; manifest: DesktopPayloadManifest; manifestBytes: Buffer; copyBytes: bigint;
}
const invalidPath = () => new Error('동봉 자원 목록에 허용되지 않은 경로나 중복이 있습니다.');

export function parseDesktopPayloadManifest(data: Buffer): DesktopPayloadManifest {
  if (data.length > 2 * 1024 * 1024) throw new Error('동봉 자원 목록의 크기 한도를 초과했습니다.');
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  const names = new Set<string>();
  for (const file of manifest.files) {
    const parts = file.path.split('/'), name = file.path.toLowerCase();
    if (isAbsolute(file.path) || file.path.includes('\\') || !['resources', 'binaries'].includes(parts[0]) || parts.length < 2
      || parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f\x7f]|[. ]$/.test(part)
        || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)
        || ['.data', '.verification', '.git', 'credentials', 'backups'].includes(part.toLowerCase())
        || part.toLowerCase().startsWith('.env') || part.toLowerCase().endsWith('.map')) || names.has(name)) throw invalidPath();
    names.add(name);
  }
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (names.has(parts.join('/'))) throw invalidPath(); parts.pop(); }
  }
  for (const required of [manifest.entry, 'resources/dist/index.html', 'binaries/node-x86_64-pc-windows-msvc.exe']) {
    if (!names.has(required)) throw new Error('네이티브 실행에 필요한 동봉 자원이 없습니다.');
  }
  return manifest;
}

export async function readDesktopPayload(source: string): Promise<DesktopPayload> {
  await assertDesktopProviderDirectory(source);
  const { data: manifestBytes } = await readDesktopProviderFile(join(source, 'payload-manifest.json'), 2 * 1024 * 1024);
  const manifest = parseDesktopPayloadManifest(manifestBytes);
  const copyBytes = manifest.files.reduce((sum, file) => sum + BigInt(file.bytes), BigInt(manifestBytes.length));
  return { source, manifest, manifestBytes, copyBytes };
}

export function desktopPayloadSpaceSufficient(freeBytes: bigint, plannedBytes: bigint): boolean {
  return plannedBytes >= 0n && freeBytes - plannedBytes >= desktopPayloadFreeSpaceFloor;
}
export async function assertDesktopPayloadCopySpace(directory: string, plannedBytes: bigint): Promise<void> {
  await assertDesktopProviderDirectory(directory);
  const disk = await statfs(directory, { bigint: true });
  if (!desktopPayloadSpaceSufficient(disk.bavail * disk.bsize, plannedBytes)) {
    throw new Error('동봉 자원을 복사할 디스크 여유가 부족합니다. 최소 20GiB와 새 후보 공간을 확보해야 합니다.');
  }
}

const contains = (base: string, candidate: string) => {
  const path = relative(base, candidate);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
async function ensureDirectories(destination: string, parts: string[]) {
  let parent = destination;
  for (const part of parts) {
    await assertDesktopProviderDirectory(parent);
    parent = join(parent, part);
    await mkdir(parent).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await assertDesktopProviderDirectory(parent);
  }
}

/** Internal scheduling only: callers retain every per-file path, hash and identity check. */
export async function runDesktopPayloadCopyWorkers(files: DesktopPayloadManifest['files'],
  copy: (file: DesktopPayloadManifest['files'][number]) => Promise<void>): Promise<void> {
  let next = 0, failure: { error: unknown } | undefined;
  const worker = async () => {
    try {
      while (!failure) {
        const file = files[next++];
        if (!file) return;
        await copy(file);
      }
    } catch (error) { failure ??= { error }; }
  };
  // Only four file operations and their 64 KiB transfer buffers can be live.
  // A failure stops admission; already admitted operations finish their finally blocks.
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, files.length) }, worker));
  if (failure) throw failure.error;
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

/** The caller checks its destination filesystem's floor before creating a new copy directory. */
export async function copyDesktopPayload(payload: DesktopPayload, destination: string): Promise<void> {
  await assertDesktopProviderDirectory(payload.source);
  await assertDesktopProviderDirectory(destination);
  if (contains(resolve(payload.source), resolve(destination)) || contains(resolve(destination), resolve(payload.source))
    || (await readdir(destination)).length) throw new Error('동봉 자원은 원본과 분리된 새 빈 폴더에만 복사합니다.');
  // Re-parse the checked manifest snapshot; never accept a subsequently modified in-memory member list.
  const manifest = parseDesktopPayloadManifest(payload.manifestBytes);
  await runDesktopPayloadCopyWorkers(manifest.files, async file => {
    const parts = file.path.split('/'); parts.pop();
    await ensureDirectories(destination, parts);
    await verifyPinnedDesktopPayloadFile(join(payload.source, file.path), file, { destination: join(destination, file.path) });
  });
  await writeFile(join(destination, 'payload-manifest.json'), payload.manifestBytes, { flag: 'wx' });
}
