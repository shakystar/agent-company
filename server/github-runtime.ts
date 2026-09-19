import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import type { GitHubStatus } from '../shared/repositories.ts';
import { GitHubAppAuth, readGitHubConfig, type GitHubAuthOptions } from './github-auth.ts';
import { GitHubOperationJournal } from './github-journal.ts';
import { GitHubTransport } from './github-transport.ts';
import { secureDirectory } from './storage.ts';

const anchorSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), journalIdentity: z.uuid(),
  appId: z.string().regex(/^[1-9][0-9]*$/), installationId: z.string().regex(/^[1-9][0-9]*$/),
}).strict();
const journalIdentitySchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), identity: z.uuid(), createdAt: z.iso.datetime() }).strict();
type Anchor = z.infer<typeof anchorSchema>;
export interface GitHubRuntime {
  transport: GitHubTransport;
  journal: Pick<GitHubOperationJournal, 'execute' | 'completed'>;
  /** Synchronous local readiness only; never reads a key or contacts GitHub. */
  status: () => GitHubStatus;
  transportFor: (guard: () => Promise<void>, expectedRepository?: { repository: string; id: number }) => GitHubTransport;
}
export interface GitHubRuntimeOptions {
  /** The installation's data root, never activeStorage(...).dataDir. */
  rootDir: string;
  ownerKey: string;
  env?: NodeJS.ProcessEnv;
  /** Trusted test injection. No production credentials are needed by the tests. */
  authOptions?: GitHubAuthOptions;
}
export class GitHubRuntimeError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'GitHubRuntimeError'; }
}
const unavailable = () => new GitHubRuntimeError(503, 'GitHub 연결 설정 또는 영속 원장 준비가 완료되지 않았습니다.');
const damaged = () => new GitHubRuntimeError(409, 'GitHub 연결 식별 기록 또는 원장이 없거나 일치하지 않습니다. 외부 작업을 재실행하지 않습니다.');

async function maybeStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw damaged(); }
}
/** Identity documents are bounded before and during the read, not after readFile allocates. */
async function identityFile(path: string): Promise<unknown | null> {
  const original = await maybeStat(path);
  if (!original) return null;
  if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || original.size < 1 || original.size > 4096) throw damaged();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.size !== original.size || actual.dev !== original.dev || actual.ino !== original.ino) throw damaged();
    const bytes = Buffer.alloc(4097); let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size !== actual.size || size > 4096) throw damaged();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch { throw damaged(); }
  finally { await file.close(); }
}
async function directoryMatches(path: string) {
  const info = await maybeStat(path);
  if (!info?.isDirectory() || info.isSymbolicLink() || relative(path, await realpath(path))) throw damaged();
}
function parseAnchor(value: unknown) {
  const parsed = anchorSchema.safeParse(value);
  if (!parsed.success) throw damaged();
  return parsed.data;
}
function cancellable<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(unavailable()); }
  return new Promise((resolveResult, rejectResult) => {
    const cancel = () => rejectResult(unavailable());
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(resolveResult, rejectResult).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** The anchor and operation receipts count toward the existing root data budget.
 * They are deliberately not restored with a workspace generation. Each receipt
 * already has the journal's 2MiB cap; the service must reserve disk before writes.
 */
export async function createGitHubRuntime(options: GitHubRuntimeOptions): Promise<GitHubRuntime> {
  const owner = z.uuid().safeParse(options.ownerKey);
  if (!owner.success) throw damaged();
  const root = resolve(options.rootDir), anchorPath = join(root, 'github-runtime.json'), journalPath = join(root, 'github-operations');
  const config = readGitHubConfig(options.env ?? process.env, { forbiddenRoots: [root] });
  const localStatus = new GitHubAppAuth(config, options.authOptions).status();
  let journal: GitHubOperationJournal | undefined, anchor: Anchor | undefined, writable = false;
  if (localStatus.configured) {
    try {
      await secureDirectory(root);
      let compromised = false;
      const release = await lockfile.lock(anchorPath, { realpath: false, stale: 30_000, update: 10_000,
        retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 }, onCompromised: () => { compromised = true; } });
      try {
        const existing = await identityFile(anchorPath);
        if (existing === null) {
          // Orphaned receipts may represent an interrupted first setup or a lost
          // anchor. Neither case is safe to treat as a brand-new connection.
          if (await maybeStat(journalPath)) throw damaged();
          journal = await GitHubOperationJournal.open({ directory: journalPath, ownerKey: owner.data });
          anchor = { version: 1, ownerKey: owner.data, journalIdentity: journal.identity, appId: config.appId!, installationId: config.installationId! };
          if (compromised) throw damaged();
          const file = await open(anchorPath, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify(anchor)); await file.sync(); } finally { await file.close(); }
        } else {
          anchor = parseAnchor(existing);
          if (anchor.ownerKey !== owner.data || anchor.appId !== config.appId || anchor.installationId !== config.installationId) throw damaged();
          journal = await GitHubOperationJournal.open({ directory: journalPath, ownerKey: owner.data,
            expectedIdentity: anchor.journalIdentity, allowCreate: false });
        }
        if (compromised) throw damaged();
        writable = true;
      } finally { if (!compromised) await release(); }
    } catch { throw damaged(); }
  }
  async function integrity() {
    if (!writable || !anchor || !journal) throw unavailable();
    try {
      await directoryMatches(root); await directoryMatches(journalPath);
      const current = parseAnchor(await identityFile(anchorPath));
      if (current.ownerKey !== anchor.ownerKey || current.journalIdentity !== anchor.journalIdentity
        || current.appId !== anchor.appId || current.installationId !== anchor.installationId) throw damaged();
      const receiptIdentity = journalIdentitySchema.safeParse(await identityFile(join(journalPath, 'identity.json')));
      if (!receiptIdentity.success || receiptIdentity.data.ownerKey !== owner.data || receiptIdentity.data.identity !== anchor.journalIdentity) throw damaged();
    } catch { writable = false; throw damaged(); }
  }
  function transportFor(guard: () => Promise<void>, expectedRepository?: { repository: string; id: number }) {
    const expected = expectedRepository ? { ...expectedRepository } : undefined;
    if (expected && (!config.repositories.includes(expected.repository.toLowerCase()) || !Number.isSafeInteger(expected.id) || expected.id < 1)) throw unavailable();
    const fetcher = options.authOptions?.fetch ?? globalThis.fetch;
    const guardedFetch: typeof globalThis.fetch = async (input, init) => {
      return cancellable((async () => {
        init?.signal?.throwIfAborted();
        await integrity();
        // No further asynchronous work occurs between the caller's current-scope
        // check and network dispatch. Auth issuance uses this same boundary.
        await guard();
        init?.signal?.throwIfAborted();
        return fetcher(input, init);
      })(), init?.signal);
    };
    const auth = new GitHubAppAuth(config, { ...options.authOptions, fetch: guardedFetch });
    return new GitHubTransport({ token: (repository, access, signal) => {
      if (expected && repository.toLowerCase() !== expected.repository.toLowerCase()) throw unavailable();
      return auth.token(repository, access, signal, expected?.id);
    }, fetch: guardedFetch });
  }
  return {
    transport: transportFor(async () => undefined), transportFor,
    journal: { execute: async (input, action) => {
      await integrity();
      const result = await journal!.execute(input, async () => { await integrity(); return action(); });
      await integrity();
      return result;
    }, completed: async input => {
      await integrity();
      const result = await journal!.completed(input);
      await integrity();
      return result;
    } },
    status: () => ({ ...localStatus, missing: [...localStatus.missing], repositories: [...localStatus.repositories], writable }),
  };
}
