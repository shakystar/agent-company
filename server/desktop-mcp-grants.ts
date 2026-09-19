import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './storage.ts';

const maximum = 128 * 1024;
const scopeSchema = z.object({ type: z.enum(['team', 'project']), id: z.uuid() }).strict();
const grantSchema = z.object({ id: z.uuid(), label: z.string().trim().min(1).max(100), scope: scopeSchema,
  submitTasks: z.boolean(), budgetTeamId: z.uuid().nullable(), createdAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(), generationKey: z.uuid() }).strict();
const storedGrantSchema = grantSchema.extend({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/) });
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const documentSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), revision,
  grants: z.array(storedGrantSchema).max(100) }).strict().refine(value => new Set(value.grants.map(grant => grant.id)).size === value.grants.length
    && new Set(value.grants.map(grant => grant.tokenHash)).size === value.grants.length);
const createSchema = z.object({ revision, label: grantSchema.shape.label, scope: scopeSchema,
  submitTasks: z.boolean(), budgetTeamId: z.uuid().nullable() }).strict();
const revokeSchema = z.object({ revision, id: z.uuid() }).strict();
const credentialSchema = z.object({ id: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(value => Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value) }).strict();
const identitySchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop'),
  channel: z.literal('beta'), workspaceKey: z.uuid() }).strict();
export type DesktopMcpGrant = z.infer<typeof grantSchema>;
export type DesktopMcpGrantStatus = { revision: number; grants: DesktopMcpGrant[] };
export type DesktopMcpGrantCreate = z.infer<typeof createSchema>;
type Stored = z.infer<typeof documentSchema>;
type Code = 'DESKTOP_MCP_GRANTS_INVALID' | 'DESKTOP_MCP_GRANTS_STALE' | 'DESKTOP_MCP_GRANT_DENIED'
  | 'DESKTOP_MCP_GRANTS_CLOSED' | 'DESKTOP_MCP_GRANTS_BUSY' | 'DESKTOP_MCP_GRANTS_LIMIT';
export class DesktopMcpGrantsError extends Error {
  readonly statusCode: number;
  constructor(readonly code: Code) {
    super(code); this.name = 'DesktopMcpGrantsError';
    this.statusCode = code === 'DESKTOP_MCP_GRANT_DENIED' ? 403
      : ['DESKTOP_MCP_GRANTS_STALE', 'DESKTOP_MCP_GRANTS_LIMIT'].includes(code) ? 409 : 503;
  }
}
const invalid = () => new DesktopMcpGrantsError('DESKTOP_MCP_GRANTS_INVALID');
const activeStores = new Set<string>();
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stable = (a: BigIntStats, b: BigIntStats) => same(a, b) && b.isFile() && b.nlink === 1n
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function localRoot(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.split(/[\\/]/).some(part => part === '.' || part === '..')) throw invalid();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(3).split(/[\\/]/).some(part =>
    /[<>:"|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw invalid();
  const root = resolve(value); if (root === parse(root).root) throw invalid(); return root;
}
type CheckedDocument = { value: unknown; stat: BigIntStats; hash: string };
async function readDocument(path: string, limit: number, optional = false): Promise<CheckedDocument | null> {
  const before = await lstat(path, { bigint: true }).catch(error => {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit)
    || relative(path, await realpath(path))) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const bytes = Buffer.alloc(Number(before.size) + 1);
  try {
    if (!stable(before, await handle.stat({ bigint: true }))) throw invalid();
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    if (BigInt(offset) !== before.size || !stable(before, await handle.stat({ bigint: true }))
      || !stable(before, await lstat(path, { bigint: true })) || relative(path, await realpath(path))) throw invalid();
    const content = bytes.subarray(0, offset);
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)), stat: before, hash: digest(content) };
  } finally { bytes.fill(0); await handle.close(); }
}
function grantDto(grant: z.infer<typeof storedGrantSchema>): DesktopMcpGrant {
  return { id: grant.id, label: grant.label, scope: { ...grant.scope }, submitTasks: grant.submitTasks,
    budgetTeamId: grant.budgetTeamId, createdAt: grant.createdAt, revokedAt: grant.revokedAt, generationKey: grant.generationKey };
}

/** Caller holds the desktop installation lease. This ledger is outside workspace backup/restore data.
 * A grant callback must not re-enter this store's FIFO. Close retains admission until accepted callbacks finish. */
export async function openDesktopMcpGrants(options: { appDataRoot: string; ownerKey: string; generationKey: string }) {
  let root: string, ownerKey: string, generationKey: string;
  try { root = localRoot(options.appDataRoot); ownerKey = z.uuid().parse(options.ownerKey); generationKey = z.uuid().parse(options.generationKey); }
  catch { throw invalid(); }
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (activeStores.has(key)) throw new DesktopMcpGrantsError('DESKTOP_MCP_GRANTS_BUSY');
  activeStores.add(key);
  try {
    const directories: Array<{ path: string; stat: BigIntStats }> = [];
    let cursor = parse(root).root;
    for (const part of ['', ...relative(cursor, root).split(/[\\/]/).filter(Boolean)]) {
      cursor = join(cursor, part); const stat = await lstat(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw invalid();
      directories.push({ path: cursor, stat });
    }
    const ownerPath = join(root, 'desktop-installation.json'), path = join(root, 'desktop-mcp-grants.json');
    const owner = await readDocument(ownerPath, 16 * 1024);
    if (!owner || identitySchema.parse(owner.value).workspaceKey !== ownerKey) throw invalid();
    const owned = async () => {
      for (const entry of directories) {
        const now = await lstat(entry.path, { bigint: true });
        if (!now.isDirectory() || now.isSymbolicLink() || !same(entry.stat, now) || relative(entry.path, await realpath(entry.path))) throw invalid();
      }
      const current = await readDocument(ownerPath, 16 * 1024);
      if (!current || current.hash !== owner.hash || !stable(owner.stat, current.stat)) throw invalid();
    };
    const parsed = (value: unknown): Stored => {
      const document = documentSchema.parse(value);
      if (document.ownerKey !== ownerKey) throw invalid();
      return document;
    };
    let observed = await readDocument(path, maximum, true);
    let state: Stored = observed ? parsed(observed.value) : { version: 1, ownerKey, revision: 0, grants: [] };
    await owned();
    let tail: Promise<void> = Promise.resolve(), closing = false, closePromise: Promise<void> | undefined;
    let failure: DesktopMcpGrantsError | undefined;
    const snapshot = (): DesktopMcpGrantStatus => ({ revision: state.revision, grants: state.grants.map(grantDto) });
    const reload = async () => {
      if (failure) throw failure;
      try {
        await owned(); const current = await readDocument(path, maximum, true);
        if (Boolean(current) !== Boolean(observed) || current && observed && (!stable(observed.stat, current.stat) || current.hash !== observed.hash)) throw invalid();
        if (current) state = parsed(current.value);
        await owned();
      } catch { throw failure ??= invalid(); }
    };
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new DesktopMcpGrantsError('DESKTOP_MCP_GRANTS_CLOSED'));
      const next = tail.then(operation); tail = next.then(() => {}, () => {}); return next;
    };
    const save = async (next: Stored) => {
      try {
        const value = parsed(next), body = JSON.stringify(value);
        if (Buffer.byteLength(body) > maximum) throw invalid();
        await reload();
        if (!observed) {
          const handle = await open(path, 'wx', 0o600);
          try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
        } else await atomicJson(path, value);
        await owned();
        const written = await readDocument(path, maximum);
        if (!written || written.hash !== digest(body)) throw invalid();
        state = parsed(written.value); observed = written;
      } catch { throw failure ??= invalid(); }
    };
    const assertRevision = (expected: number) => {
      if (!Number.isSafeInteger(expected) || expected !== state.revision || expected >= Number.MAX_SAFE_INTEGER) {
        throw new DesktopMcpGrantsError('DESKTOP_MCP_GRANTS_STALE');
      }
    };
    return {
      status: (): Promise<DesktopMcpGrantStatus> => enqueue(async () => { await reload(); return snapshot(); }),
      create: (input: DesktopMcpGrantCreate): Promise<{ revision: number; grant: DesktopMcpGrant; token: string }> => {
        const request = createSchema.safeParse(input);
        return enqueue(async () => {
          await reload(); if (!request.success) throw invalid(); assertRevision(request.data.revision);
          if (state.grants.length >= 100) throw new DesktopMcpGrantsError('DESKTOP_MCP_GRANTS_LIMIT');
          const token = randomBytes(32).toString('base64url');
          const grant = { id: randomUUID(), label: request.data.label, scope: request.data.scope, submitTasks: request.data.submitTasks,
            budgetTeamId: request.data.budgetTeamId, createdAt: new Date().toISOString(), revokedAt: null,
            generationKey, tokenHash: digest(token) };
          await save({ ...state, revision: state.revision + 1, grants: [...state.grants, grant] });
          return { revision: state.revision, grant: grantDto(grant), token };
        });
      },
      revoke: (input: { revision: number; id: string }): Promise<DesktopMcpGrantStatus> => {
        const request = revokeSchema.safeParse(input);
        return enqueue(async () => {
          await reload(); if (!request.success) throw invalid(); assertRevision(request.data.revision);
          const grant = state.grants.find(item => item.id === request.data.id);
          if (!grant) throw new DesktopMcpGrantsError('DESKTOP_MCP_GRANT_DENIED');
          if (!grant.revokedAt) await save({ ...state, revision: state.revision + 1,
            grants: state.grants.map(item => item.id === grant.id ? { ...item, revokedAt: new Date().toISOString() } : item) });
          return snapshot();
        });
      },
      withGrant: <T>(input: { id: string; token: string }, operation: (grant: DesktopMcpGrant) => Promise<T>): Promise<T> => {
        const request = credentialSchema.safeParse(input);
        return enqueue(async () => {
          await reload();
          if (!request.success) throw new DesktopMcpGrantsError('DESKTOP_MCP_GRANT_DENIED');
          const grant = state.grants.find(item => item.id === request.data.id);
          if (!grant || grant.revokedAt || grant.generationKey !== generationKey
            || !timingSafeEqual(Buffer.from(grant.tokenHash, 'hex'), Buffer.from(digest(request.data.token), 'hex'))) {
            throw new DesktopMcpGrantsError('DESKTOP_MCP_GRANT_DENIED');
          }
          const result = await operation(grantDto(grant)); await reload(); return result;
        });
      },
      close: (): Promise<void> => {
        closing = true;
        return closePromise ??= tail.finally(() => { activeStores.delete(key); });
      },
    };
  } catch (error) {
    activeStores.delete(key);
    if (error instanceof DesktopMcpGrantsError) throw error;
    throw invalid();
  }
}
