import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

const markerName = 'desktop-codex-home.json';
const markerSchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop-codex'),
  workspaceKey: z.uuid() }).strict();

class DesktopAccountLeaseLostError extends Error {
  readonly code = 'DESKTOP_ACCOUNT_LEASE_LOST';
  constructor(cause: Error) {
    super('Codex 인증 홈의 로그인 잠금이 상실됐습니다.', { cause });
    this.name = 'DesktopAccountLeaseLostError';
  }
}

async function checkedDirectory(path: string, create: boolean): Promise<void> {
  let cursor = parse(path).root;
  for (const component of relative(cursor, path).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, component);
    if (create) await mkdir(cursor).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const metadata = await lstat(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Codex 인증 경로에 링크나 특수 파일을 사용할 수 없습니다.');
  }
  if (relative(path, await realpath(path))) throw new Error('Codex 인증 경로가 다른 위치를 가리킵니다.');
}

/** Inspect metadata only: an auth/config symlink must never import another home. */
async function checkedContents(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name), metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('Codex 인증 홈의 링크를 사용할 수 없습니다.');
    if (metadata.isDirectory()) {
      await checkedDirectory(path, false);
      await checkedContents(path);
    } else if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error('Codex 인증 홈에는 독립된 일반 파일만 사용할 수 있습니다.');
    }
  }
}

async function readMarker(path: string): Promise<unknown | null> {
  const metadata = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4096) {
    throw new Error('Codex 인증 홈 식별 파일의 형식이 올바르지 않습니다.');
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 4096 || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error('Codex 인증 홈 식별 파일이 변경됐습니다.');
    }
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('Codex 인증 홈 식별 파일이 너무 큽니다.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))); }
    catch { throw new Error('Codex 인증 홈 식별 파일을 해석하지 못했습니다.'); }
  } finally { await handle.close(); }
}

/** The caller retains this lease until its actual Codex child has exited.
 * signal reports unexpected lease loss only; normal release does not abort it.
 */
export async function openDesktopAccountHome(credentialsRoot: string, workspaceKey: string): Promise<{
  directory: string; signal: AbortSignal; release(): Promise<void>;
}> {
  const identity = markerSchema.parse({ version: 1, product: 'agent-company-desktop-codex', workspaceKey });
  if (!isAbsolute(credentialsRoot) || /[\x00-\x1f]/.test(credentialsRoot)
    || credentialsRoot.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    throw new Error('Codex 인증 저장소의 명시적 절대 경로가 필요합니다.');
  }
  const root = resolve(credentialsRoot);
  if (root === parse(root).root) throw new Error('파일시스템 루트를 Codex 인증 저장소로 사용할 수 없습니다.');
  await checkedDirectory(root, true);
  const directory = join(root, 'codex');
  await checkedDirectory(directory, true);
  // Keep the lock outside CODEX_HOME, so an unmarked home must be truly empty.
  const lockPath = join(root, 'codex.login.lock');
  const existingLock = await lstat(lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (existingLock && (!existingLock.isDirectory() || existingLock.isSymbolicLink())) {
    throw new Error('Codex 인증 잠금 경로에 링크나 특수 파일을 사용할 수 없습니다.');
  }
  const lease = new AbortController();
  let released = false;
  const unlock = await lockfile.lock(directory, { lockfilePath: lockPath,
    stale: 30_000, update: 10_000, retries: 0,
    onCompromised(error) {
      // Let the owner close admissions and wait for its child instead of
      // throwing from the lock timer and abruptly exiting the controller.
      if (!released && !lease.signal.aborted) lease.abort(new DesktopAccountLeaseLostError(error));
    } });
  let releasePromise: Promise<void> | undefined;
  const release = () => releasePromise ??= (async () => {
    // A replacement holder may already own this path. Never remove its lock
    // or mask the first compromise with proper-lockfile's later ERELEASED.
    lease.signal.throwIfAborted();
    try { await unlock(); }
    catch (error) { lease.signal.throwIfAborted(); throw error; }
    released = true;
    lease.signal.throwIfAborted();
  })();
  try {
    await checkedDirectory(directory, false);
    const markerPath = join(directory, markerName), raw = await readMarker(markerPath);
    lease.signal.throwIfAborted();
    if (raw === null) {
      if ((await readdir(directory)).length) throw new Error('식별 기록 없는 기존 Codex 인증 홈을 자동 선택하지 않습니다.');
      const handle = await open(markerPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(identity)); await handle.sync(); }
      finally { await handle.close(); }
    } else if (markerSchema.parse(raw).workspaceKey !== workspaceKey) {
      throw new Error('Codex 인증 홈의 작업실 소유권이 일치하지 않습니다.');
    }
    await checkedContents(directory);
    lease.signal.throwIfAborted();
    return { directory, signal: lease.signal, release };
  } catch (error) {
    try { await release(); }
    catch (cleanup) {
      if (cleanup === error) throw error;
      throw new AggregateError([error, cleanup], 'Codex 인증 홈 검증 실패 후 잠금 해제를 확인하지 못했습니다.', { cause: error });
    }
    throw error;
  }
}
