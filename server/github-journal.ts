import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { atomicJson, secureDirectory } from './storage.ts';

export const GITHUB_OPERATION_MAX_BYTES = 2 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const inputSchema = z.object({
  key: identifier, runId: identifier, agentId: identifier, connectionId: identifier,
  repository: z.string().max(250).regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  operation: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), fingerprint: digest,
}).strict();
export const identitySchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), identity: z.uuid(), createdAt: z.iso.datetime() }).strict();
export const recordSchema = inputSchema.omit({ key: true }).extend({
  version: z.literal(1), ownerKey: z.uuid(), identity: z.uuid(), keyHash: digest,
  status: z.enum(['pending', 'uncertain', 'completed']), attempts: z.number().int().positive().safe(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), result: z.unknown(),
}).strict();
type JournalRecord = z.infer<typeof recordSchema>;
export type GitHubOperationInput = z.infer<typeof inputSchema>;
export type GitHubReceiptLookup = Omit<GitHubOperationInput, 'fingerprint'>;
export interface GitHubOperationJournalOptions {
  /** Installation-owned location, not a restorable workspace generation. */
  directory: string;
  ownerKey: string;
  /** Disable after initial connection setup: a lost journal is never a fresh installation. */
  allowCreate?: boolean;
  /** Persist this anchor outside the journal when the connection is first configured. */
  expectedIdentity?: string;
}
export class GitHubJournalError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'GitHubJournalError'; }
}

/** Durable operation receipts, not an exactly-once network transaction.
 * The caller authorizes every invocation, including a cached result. It supplies
 * only sanitized metadata/results, never credentials, file bodies, or raw errors.
 * An action MUST reconcile its deterministic GitHub branch/commit/PR on every
 * call: pending/uncertain operations can have already succeeded remotely.
 */
export class GitHubOperationJournal {
  readonly directory: string;
  readonly identity: string;
  private constructor(private readonly ownerKey: string, directory: string, identity: string) {
    this.directory = directory; this.identity = identity;
  }

  static async open(options: GitHubOperationJournalOptions): Promise<GitHubOperationJournal> {
    const ownerKey = z.uuid().parse(options.ownerKey), directory = resolve(options.directory);
    const expectedIdentity = options.expectedIdentity === undefined ? undefined : z.uuid().parse(options.expectedIdentity);
    const existing = await lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
    });
    if (!existing && (options.allowCreate === false || expectedIdentity)) throw new GitHubJournalError(409, 'GitHub 작업 원장이 없습니다. 기존 외부 작업 이력을 초기화하지 않습니다.');
    await secureDirectory(directory);
    return withLock(directory, async assertLock => {
      const path = join(directory, 'identity.json');
      let raw = await jsonFile(path, 4096);
      if (!raw) {
        if (options.allowCreate === false || expectedIdentity || (await readdir(directory)).length) {
          throw new GitHubJournalError(409, 'GitHub 원장 식별 기록이 없습니다. 기존 이력을 초기화하지 않습니다.');
        }
        const initial = { version: 1 as const, ownerKey, identity: randomUUID(), createdAt: new Date().toISOString() };
        assertLock();
        // A partial first write remains evidence and fails validation on restart.
        const handle = await open(path, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(initial)); await handle.sync(); } finally { await handle.close(); }
        raw = initial;
      }
      const anchor = parseIdentity(raw);
      if (anchor.ownerKey !== ownerKey || expectedIdentity && anchor.identity !== expectedIdentity) {
        throw new GitHubJournalError(409, 'GitHub 원장 소유권 또는 식별자가 일치하지 않습니다.');
      }
      assertLock();
      return new GitHubOperationJournal(ownerKey, directory, anchor.identity);
    });
  }

  async execute(raw: GitHubOperationInput, action: () => Promise<unknown>): Promise<unknown> {
    const input = inputSchema.parse(raw);
    // No untrusted key or repository string becomes a filesystem path.
    const keyHash = createHash('sha256').update(input.key).digest('hex');
    const path = join(this.directory, `${keyHash}.json`);
    return withLock(path, async assertLock => {
      await this.assertIdentity();
      const previous = await jsonFile(path);
      let record: JournalRecord | undefined;
      if (previous !== null) {
        const parsed = recordSchema.safeParse(previous);
        if (!parsed.success) throw new GitHubJournalError(409, 'GitHub 작업 기록 형식이 올바르지 않습니다. 기존 기록을 덮어쓰지 않습니다.');
        record = parsed.data;
        if (record.ownerKey !== this.ownerKey || record.identity !== this.identity || record.keyHash !== keyHash
          || record.runId !== input.runId || record.agentId !== input.agentId || record.connectionId !== input.connectionId
          || record.repository !== input.repository || record.operation !== input.operation || record.fingerprint !== input.fingerprint) {
          throw new GitHubJournalError(409, '같은 GitHub 작업 키의 본문 또는 귀속이 다릅니다. 새 외부 작업으로 재실행하지 않습니다.');
        }
        if (record.status === 'completed') { assertLock(); return record.result; }
      }
      const at = new Date().toISOString();
      const { key: _key, ...metadata } = input;
      const pending: JournalRecord = { ...metadata, version: 1, ownerKey: this.ownerKey, identity: this.identity,
        keyHash, status: 'pending', attempts: (record?.attempts ?? 0) + 1, createdAt: record?.createdAt ?? at, updatedAt: at, result: null };
      assertLock();
      await this.publish(path, pending);
      assertLock();
      let value: unknown;
      try {
        value = await action();
      } catch (error) {
        // Store no exception text: HTTP errors can contain headers or bodies.
        // A failed dispatch is uncertain until the transport reconciles GitHub.
        assertLock(); await this.assertIdentity();
        await this.publish(path, { ...pending, status: 'uncertain', updatedAt: new Date().toISOString() });
        throw error;
      }
      assertLock(); await this.assertIdentity();
      // Serialization/size/write failure leaves pending; never report success
      // without a durable receipt, even if GitHub already accepted the write.
      const result = jsonResult(value);
      await this.publish(path, { ...pending, status: 'completed', updatedAt: new Date().toISOString(), result });
      assertLock();
      return result;
    });
  }

  /** Read a completed, installation-owned receipt without rewriting legacy data.
   * The caller must validate the original frozen project/team/connection scope.
   * A missing or uncertain receipt is not proof of branch ownership.
   */
  async completed(raw: GitHubReceiptLookup): Promise<unknown> {
    const input = inputSchema.omit({ fingerprint: true }).parse(raw);
    const keyHash = createHash('sha256').update(input.key).digest('hex');
    const path = join(this.directory, `${keyHash}.json`);
    return withLock(path, async assertLock => {
      await this.assertIdentity();
      const parsed = recordSchema.safeParse(await jsonFile(path));
      if (!parsed.success) throw new GitHubJournalError(409, '기존 게시의 완료 영수증을 확인할 수 없습니다.');
      const record = parsed.data;
      if (record.ownerKey !== this.ownerKey || record.identity !== this.identity || record.keyHash !== keyHash
        || record.runId !== input.runId || record.agentId !== input.agentId || record.connectionId !== input.connectionId
        || record.repository !== input.repository || record.operation !== input.operation || record.status !== 'completed') {
        throw new GitHubJournalError(409, '기존 게시 영수증의 완료 상태 또는 귀속이 일치하지 않습니다.');
      }
      assertLock(); return record.result;
    });
  }

  private async assertIdentity(): Promise<void> {
    const raw = await jsonFile(join(this.directory, 'identity.json'), 4096);
    if (!raw) throw new GitHubJournalError(409, 'GitHub 원장 식별 기록이 없습니다. 외부 작업을 실행하지 않습니다.');
    const anchor = parseIdentity(raw);
    if (anchor.ownerKey !== this.ownerKey || anchor.identity !== this.identity) throw new GitHubJournalError(409, 'GitHub 원장 식별자가 변경됐습니다. 외부 작업을 실행하지 않습니다.');
  }

  private async publish(path: string, record: JournalRecord): Promise<void> {
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > GITHUB_OPERATION_MAX_BYTES) throw new GitHubJournalError(413, 'GitHub 작업 기록이 2MiB 한도를 초과했습니다. 외부 결과를 다시 조회해야 합니다.');
    await atomicJson(path, record);
  }
}

function parseIdentity(value: unknown) {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new GitHubJournalError(409, 'GitHub 원장 식별 기록이 손상됐습니다. 자동 초기화하지 않습니다.');
  return parsed.data;
}
function jsonResult(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('Missing JSON result');
    if (Buffer.byteLength(text) > GITHUB_OPERATION_MAX_BYTES) throw new GitHubJournalError(413, 'GitHub 작업 결과가 2MiB 한도를 초과했습니다.');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof GitHubJournalError) throw error;
    throw new GitHubJournalError(502, 'GitHub 작업 결과를 영속 기록할 수 없습니다. 외부 결과를 다시 조회해야 합니다.');
  }
}
async function jsonFile(path: string, maxBytes = GITHUB_OPERATION_MAX_BYTES): Promise<unknown | null> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new GitHubJournalError(409, 'GitHub 원장 파일 형식 또는 크기가 올바르지 않습니다.');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new GitHubJournalError(409, 'GitHub 원장 파일이 읽기 한도를 초과했습니다.');
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    // JSON null is a corrupt receipt, never the sentinel for a missing file.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record');
    return value;
  }
  catch { throw new GitHubJournalError(409, 'GitHub 원장 파일이 손상됐습니다. 자동 초기화하지 않습니다.'); }
}
async function withLock<T>(path: string, action: (assertLock: () => void) => Promise<T>): Promise<T> {
  let compromised = false;
  const assertLock = () => { if (compromised) throw new GitHubJournalError(409, 'GitHub 원장 잠금이 손상됐습니다. 외부 결과 확인이 필요합니다.'); };
  const release = await lockfile.lock(path, { realpath: false, stale: 30_000, update: 10_000,
    retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 }, onCompromised: () => { compromised = true; } });
  try { assertLock(); return await action(assertLock); }
  finally { if (!compromised) await release(); }
}
