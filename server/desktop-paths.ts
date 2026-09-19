import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { secureDirectory } from './storage.ts';

const identitySchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop'),
  channel: z.literal('beta'), workspaceKey: z.uuid() }).strict();
export interface DesktopPaths {
  resourceRoot: string; appDataRoot: string; dataDir: string; backupDir: string;
  credentialsDir: string; logsDir: string; distDir: string;
}
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};

/** Paths come from the native parent, never cwd, .env, HOME or developer defaults. */
export function desktopPaths(resourceRoot: string, appDataRoot: string): DesktopPaths {
  for (const path of [resourceRoot, appDataRoot]) {
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path) || resolve(path) === parse(resolve(path)).root) {
      throw new Error('설치 자원과 사용자 데이터의 절대 경로가 필요합니다.');
    }
  }
  resourceRoot = resolve(resourceRoot); appDataRoot = resolve(appDataRoot);
  if (inside(resourceRoot, appDataRoot) || inside(appDataRoot, resourceRoot)) {
    throw new Error('설치 자원과 사용자 데이터 경로를 분리해야 합니다.');
  }
  return { resourceRoot, appDataRoot, dataDir: join(appDataRoot, 'workspace'), backupDir: join(appDataRoot, 'backups'),
    credentialsDir: join(appDataRoot, 'credentials'), logsDir: join(appDataRoot, 'logs'), distDir: join(resourceRoot, 'dist') };
}

async function regularFile(path: string, maximum: number): Promise<string | null> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) throw new Error('설치형 데이터 식별 파일을 확인해야 합니다.');
  return readFile(path, 'utf8');
}

/** Keep the lease until the service and DB have closed. Unknown directories are never adopted. */
export async function openDesktopInstallation(paths: DesktopPaths) {
  // Verify the complete resource path without creating or writing installation files.
  if (relative(paths.resourceRoot, await realpath(paths.resourceRoot)) || (await lstat(paths.resourceRoot)).isSymbolicLink()) {
    throw new Error('설치 자원 경로가 다른 위치를 가리킵니다.');
  }
  if (!(await lstat(paths.distDir)).isDirectory() || (await lstat(paths.distDir)).isSymbolicLink()
    || await regularFile(join(paths.distDir, 'index.html'), 2 * 1024 * 1024) === null) throw new Error('설치된 화면 자원이 없습니다.');
  await secureDirectory(paths.appDataRoot);
  const unlock = await lockfile.lock(paths.appDataRoot, { lockfilePath: join(paths.appDataRoot, 'desktop.lock'),
    stale: 30_000, update: 10_000, retries: 0 });
  let held = true, controllerUnlock: (() => Promise<void>) | undefined;
  const release = async () => {
    if (controllerUnlock) { await controllerUnlock(); controllerUnlock = undefined; }
    if (held) { await unlock(); held = false; }
  };
  try {
    const identityPath = join(paths.appDataRoot, 'desktop-installation.json');
    const raw = await regularFile(identityPath, 4096);
    let identity: z.infer<typeof identitySchema>;
    if (raw === null) {
      if ((await readdir(paths.appDataRoot)).some(name => name !== 'desktop.lock')) {
        throw new Error('기존 데이터 폴더를 새 설치형 작업실로 자동 선택하지 않습니다.');
      }
      identity = { version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: randomUUID() };
      await writeFile(identityPath, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
    } else identity = identitySchema.parse(JSON.parse(raw));
    await secureDirectory(paths.dataDir);
    const keyPath = join(paths.dataDir, 'workspace-id');
    const key = await regularFile(keyPath, 100);
    if (key === null) {
      // Recover only an interrupted empty first installation, never a missing identity over a DB.
      if ((await readdir(paths.dataDir)).length) throw new Error('기존 작업실 식별 파일이 없습니다.');
      await writeFile(keyPath, identity.workspaceKey, { flag: 'wx', mode: 0o600 });
    } else if (key.trim() !== identity.workspaceKey) throw new Error('설치형 작업실의 소유 식별자가 일치하지 않습니다.');
    controllerUnlock = await lockfile.lock(paths.dataDir, { lockfilePath: join(paths.dataDir, 'controller.lock'),
      stale: 30_000, update: 10_000, retries: 0 });
    for (const directory of [paths.backupDir, paths.credentialsDir, paths.logsDir]) await secureDirectory(directory);
    return { workspaceKey: identity.workspaceKey, release };
  } catch (error) { await release(); throw error; }
}
