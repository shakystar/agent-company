import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { openDesktopAccountHome } from './desktop-account-home.ts';

type ErrorCode = 'DESKTOP_RUNTIME_AUTH_INVALID' | 'DESKTOP_RUNTIME_AUTH_BUSY'
  | 'DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE' | 'DESKTOP_RUNTIME_AUTH_LEASE_LOST' | 'DESKTOP_RUNTIME_AUTH_CLEANUP_FAILED';
export class DesktopRuntimeAuthError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'DesktopRuntimeAuthError'; }
}
const invalid = () => new DesktopRuntimeAuthError('DESKTOP_RUNTIME_AUTH_INVALID');
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stable = (a: BigIntStats, b: BigIntStats) => identity(a, b) && b.isFile() && b.nlink === 1n
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const maximum = 1024 * 1024;

/** Validates the document without returning, logging, interpreting or rewriting its secrets. */
async function inspectFile(path: string, expected?: BigIntStats): Promise<BigIntStats> {
  const directories: Array<{ path: string; stat: BigIntStats }> = [];
  let cursor = parse(path).root;
  for (const part of ['', ...relative(cursor, path).split(/[\\/]/).slice(0, -1)]) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw invalid();
    directories.push({ path: cursor, stat });
  }
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)
    || expected && !identity(expected, before) || relative(path, await realpath(path))) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const buffer = Buffer.alloc(Number(before.size) + 1);
  try {
    if (!stable(before, await handle.stat({ bigint: true }))) throw invalid();
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (BigInt(total) !== before.size || !stable(before, await handle.stat({ bigint: true }))) throw invalid();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    for (const entry of directories) {
      const now = await lstat(entry.path, { bigint: true });
      if (!now.isDirectory() || now.isSymbolicLink() || !identity(entry.stat, now)
        || relative(entry.path, await realpath(entry.path))) throw invalid();
    }
    if (!stable(before, await lstat(path, { bigint: true })) || relative(path, await realpath(path))) throw invalid();
    return before;
  } finally { buffer.fill(0); await handle.close(); }
}

export interface DesktopRuntimeAuthLease {
  /** Control-plane-only file path; never put it or credentials in an execution checkpoint. */
  readonly authFile: string;
  readonly signal: AbortSignal;
  /** Before binding, recheck that the authenticated source has not been replaced. */
  validate(): Promise<void>;
  /** Confirms real writer termination before unlocking. A failed idle check retains the lease and can be retried. */
  release(): Promise<void>;
}

/** Shared with official account operations through openDesktopAccountHome. This
 * does not map a WSL path, start a model, or attest that a credential is valid.
 * assertNoWriters must inspect the configured Docker target, including recovery
 * after a stale host lock; elapsed lease time is never proof of container exit.
 */
export async function openDesktopRuntimeAuth(options: {
  credentialsRoot: string; workspaceKey: string; assertNoWriters: () => Promise<void>;
}): Promise<DesktopRuntimeAuthLease> {
  if (typeof options.assertNoWriters !== 'function' || !isAbsolute(options.credentialsRoot)
    || /[\x00-\x1f\x7f]/.test(options.credentialsRoot)
    || options.credentialsRoot.split(/[\\/]/).some(part => part === '.' || part === '..')) throw invalid();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(options.credentialsRoot)
    || options.credentialsRoot.slice(3).split(/[\\/]/).some(part => /[<>:"|?*]|[. ]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw invalid();
  let home: Awaited<ReturnType<typeof openDesktopAccountHome>>;
  try { home = await openDesktopAccountHome(resolve(options.credentialsRoot), options.workspaceKey); }
  catch (error) { throw new DesktopRuntimeAuthError((error as NodeJS.ErrnoException).code === 'ELOCKED'
    ? 'DESKTOP_RUNTIME_AUTH_BUSY' : 'DESKTOP_RUNTIME_AUTH_INVALID'); }
  const alive = () => { if (home.signal.aborted) throw new DesktopRuntimeAuthError('DESKTOP_RUNTIME_AUTH_LEASE_LOST'); };
  const idle = async () => {
    alive();
    try { await options.assertNoWriters(); }
    catch { alive(); throw new DesktopRuntimeAuthError('DESKTOP_RUNTIME_AUTH_WRITER_ACTIVE'); }
    alive();
  };
  const authFile = join(home.directory, 'auth.json');
  let initial: BigIntStats;
  try { await idle(); initial = await inspectFile(authFile); alive(); }
  catch (error) {
    // No new writer has been admitted. The mandatory idle gate is checked again by every later holder.
    try { await home.release(); }
    catch { alive(); throw new DesktopRuntimeAuthError('DESKTOP_RUNTIME_AUTH_CLEANUP_FAILED'); }
    throw error instanceof DesktopRuntimeAuthError ? error : invalid();
  }
  let closing = false, released = false, releasing: Promise<void> | undefined;
  const inspectCurrent = async () => {
    alive();
    try { await inspectFile(authFile, initial); }
    catch { alive(); throw invalid(); }
    alive();
  };
  const validate = async () => {
    if (closing || released) throw invalid();
    await inspectCurrent();
    if (closing || released) throw invalid();
  };
  return {
    authFile, signal: home.signal, validate,
    release() {
      // Monotone admission closure: failed cleanup can be retried, never reused for a new writer.
      closing = true;
      if (released) return releasing ?? Promise.resolve();
      if (releasing) return releasing;
      releasing = (async () => {
        await idle();
        let fileFailure: unknown;
        try { await inspectCurrent(); } catch (error) { fileFailure = error; }
        try { await home.release(); }
        catch { alive(); throw new DesktopRuntimeAuthError('DESKTOP_RUNTIME_AUTH_CLEANUP_FAILED'); }
        released = true;
        // A damaged document must not strand the account lock or restore an old seed.
        // Login/logout may now repair it after their own real-writer check.
        if (fileFailure) throw fileFailure;
      })();
      void releasing.catch(() => { if (!released) releasing = undefined; });
      return releasing;
    },
  };
}
