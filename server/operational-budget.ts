import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { BudgetPauseError, type ModelStartRequest } from '../shared/telemetry.ts';
import { operationalLimit, updateOperationalBudgetSchema, type BudgetAttribution, type OperationalBudgetBlock,
  type OperationalBudgetStatus, type UpdateOperationalBudgetInput } from '../shared/operational-budget.ts';
import { atomicJson, secureDirectory } from './storage.ts';

const kstOffset = 9 * 60 * 60 * 1000;
export function koreaBudgetDay(at: Date): { date: string; resetAt: string } {
  if (!Number.isFinite(at.getTime())) throw new Error('운영 예산 시각이 올바르지 않습니다.');
  const date = new Date(at.getTime() + kstOffset).toISOString().slice(0, 10);
  return { date, resetAt: new Date(Date.parse(`${date}T00:00:00.000Z`) + 24 * 60 * 60 * 1000 - kstOffset).toISOString() };
}
const originalArchive = 'ledger.v1.original.json';
const limitsSchema = z.record(z.uuid(), operationalLimit.nullable());
const legacyReservationSchema = z.object({ id: z.uuid(), sequence: z.number().int().positive(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recordedAt: z.iso.datetime(), runId: z.string().min(1).max(200), rootRunId: z.string().min(1).max(200), projectId: z.uuid().nullable(),
  phase: z.enum(['task', 'evaluate', 'trial', 'repair']), kind: z.string().max(100), reason: z.string().max(2000) }).strict();
const changeSchema = z.object({ revision: z.number().int().positive(), at: z.iso.datetime(), dailyLimit: operationalLimit,
  projectDailyLimits: limitsSchema }).strict();
const legacyLedgerSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), identity: z.uuid(), createdAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(), dailyLimit: operationalLimit,
  projectDailyLimits: limitsSchema, starts: z.array(legacyReservationSchema), changes: z.array(changeSchema),
}).strict();
const attributionFields = z.object({ teamId: z.uuid().nullable().optional(), agentId: z.uuid().optional() }).strict();
const reservationSchema = legacyReservationSchema.extend(attributionFields.shape);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const importReferenceSchema = z.object({ id: z.uuid(), sha256: digest }).strict();
const ledgerSchema = legacyLedgerSchema.extend({ version: z.literal(2), teamDailyLimits: limitsSchema, agentDailyLimits: limitsSchema,
  starts: z.array(reservationSchema),
  changes: z.array(changeSchema.extend({ teamDailyLimits: limitsSchema.optional(), agentDailyLimits: limitsSchema.optional() })),
  migratedFrom: z.object({ version: z.literal(1), archiveFile: z.literal(originalArchive), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  usageImports: z.array(importReferenceSchema).max(1024).optional(),
});

const maximumFile = 128 * 1024 * 1024;
const anchorSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), identity: z.uuid() }).strict();
const migrationSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), identity: z.uuid(),
  identityRaw: z.string().max(4096), ledgerRaw: z.string().max(maximumFile), ledgerSha256: digest,
  legacyRaw: z.string().max(maximumFile).optional() }).strict();
const importPolicyDecisionSchema = z.object({ dailyLimit: operationalLimit, sourceDailyLimit: operationalLimit,
  targetDailyLimit: operationalLimit, expectedRevision: z.number().int().nonnegative() }).strict();
const importReceiptSchema = z.object({ version: z.literal(1), id: z.uuid(), ownerKey: z.uuid(), identity: z.uuid(),
  sourceOwnerKey: z.uuid(), sourceIdentity: z.uuid(), sourceLedgerSha256: digest,
  sourceSnapshotSha256: digest, beforeLedgerSha256: digest, at: z.iso.datetime(),
  policyDecision: importPolicyDecisionSchema.optional() }).strict();
const importJournalSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), identity: z.uuid(),
  receipt: importReferenceSchema, receiptDocument: importReceiptSchema, afterLedgerSha256: digest }).strict();
type ImportReference = z.infer<typeof importReferenceSchema>;
type ImportReceipt = z.infer<typeof importReceiptSchema>;
type ImportedSources = Map<string, { ownerKey: string; starts: Ledger['starts'] }>;
export type OperationalBudgetMigration = z.infer<typeof migrationSchema>;
export interface OperationalBudgetImportResult {
  importId: string; appended: number; totalImported: number; sourceIdentity: string; sourceLedgerSha256: string;
}
export interface OperationalBudgetImportOptions {
  sourceOwnerKey: string; sourceLedgerSha256: string; expectedRevision: number;
  approvedDailyLimit?: number; expectedSourceDailyLimit?: number;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const migrationError = () => new OperationalBudgetError(409, '운영 예산 이관 원문·소유권·정책 또는 복구 기록을 확인해야 합니다. 기존 사용량을 초기화하지 않았습니다.');
function json(bytes: Buffer): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function checkedLedger(raw: unknown, ownerKey: string, identity: string): Ledger {
  const original = (raw as { version?: unknown })?.version === 1 ? legacyLedgerSchema.parse(raw) : ledgerSchema.parse(raw);
  if (original.ownerKey !== ownerKey || original.identity !== identity
    || original.starts.some((entry, index) => entry.sequence !== index + 1)
    || new Set(original.starts.map(entry => entry.id)).size !== original.starts.length
    || original.changes.length !== original.revision || original.changes.some((entry, index) => entry.revision !== index + 1)) throw migrationError();
  return original.version === 1 ? { ...original, version: 2, teamDailyLimits: {}, agentDailyLimits: {} } : original;
}
function preservedCharges(before: Ledger['starts'], after: Ledger['starts']): boolean {
  return before.every((entry, index) => {
    const current = after[index]; if (!current) return false;
    // The existing attribution backfill may fill missing fields, never change known ones.
    const { teamId, agentId, ...charge } = entry;
    const { teamId: currentTeam, agentId: currentAgent, ...currentCharge } = current;
    return isDeepStrictEqual(charge, currentCharge) && (teamId === undefined || teamId === currentTeam)
      && (agentId === undefined || agentId === currentAgent);
  });
}
function samePolicy(a: Ledger, b: Ledger): boolean {
  return a.dailyLimit === b.dailyLimit && ['projectDailyLimits', 'teamDailyLimits', 'agentDailyLimits']
    .every(key => isDeepStrictEqual(a[key as 'projectDailyLimits'], b[key as 'projectDailyLimits']));
}
function migrationValue(raw: unknown): { snapshot: OperationalBudgetMigration; ledger: Ledger } {
  const snapshot = migrationSchema.parse(raw);
  if (Buffer.byteLength(snapshot.ledgerRaw) > maximumFile || Buffer.byteLength(snapshot.legacyRaw ?? '') > maximumFile
    || hash(snapshot.ledgerRaw) !== snapshot.ledgerSha256) throw migrationError();
  const anchor = anchorSchema.parse(JSON.parse(snapshot.identityRaw));
  if (anchor.ownerKey !== snapshot.ownerKey || anchor.identity !== snapshot.identity) throw migrationError();
  const ledger = checkedLedger(JSON.parse(snapshot.ledgerRaw), snapshot.ownerKey, snapshot.identity);
  // Transitively imported ledgers need their complete origin graph. Do not flatten or double-charge it.
  if (ledger.usageImports?.length) throw migrationError();
  if (ledger.migratedFrom) {
    if (!snapshot.legacyRaw || hash(snapshot.legacyRaw) !== ledger.migratedFrom.sha256) throw migrationError();
    const original = legacyLedgerSchema.parse(JSON.parse(snapshot.legacyRaw));
    if (original.ownerKey !== ledger.ownerKey || original.identity !== ledger.identity || original.createdAt !== ledger.createdAt
      || !preservedCharges(original.starts, ledger.starts) || ledger.revision < original.revision
      || !isDeepStrictEqual(ledger.changes.slice(0, original.changes.length), original.changes)
      || ledger.revision === original.revision && (ledger.dailyLimit !== original.dailyLimit
        || !isDeepStrictEqual(ledger.projectDailyLimits, original.projectDailyLimits))) throw migrationError();
  } else if (snapshot.legacyRaw !== undefined) throw migrationError();
  return { snapshot, ledger };
}
/** Pure validation for an already copied export capsule; never reads or mutates a directory. */
export function validateOperationalBudgetMigration(raw: unknown): OperationalBudgetMigration {
  try { return migrationValue(raw).snapshot; } catch { throw migrationError(); }
}
function applyImport(before: Ledger, source: Ledger, origins: ImportedSources, at: string, reference: ImportReference,
  decision?: z.infer<typeof importPolicyDecisionSchema>): Ledger {
  if (source.identity === before.identity || source.ownerKey === before.ownerKey) throw migrationError();
  const prior = origins.get(source.identity);
  if (prior && (prior.ownerKey !== source.ownerKey || source.starts.length < prior.starts.length
    || !isDeepStrictEqual(source.starts.slice(0, prior.starts.length), prior.starts))) throw migrationError();
  const next = structuredClone(before);
  if (decision) {
    if (decision.sourceDailyLimit !== source.dailyLimit || decision.targetDailyLimit !== before.dailyLimit
      || decision.expectedRevision !== before.revision) throw migrationError();
    next.dailyLimit = decision.dailyLimit;
  } else if (next.dailyLimit !== source.dailyLimit) throw migrationError();
  for (const field of ['projectDailyLimits', 'teamDailyLimits', 'agentDailyLimits'] as const) {
    for (const [id, limit] of Object.entries(source[field])) {
      if (Object.hasOwn(next[field], id) && next[field][id] !== limit) throw migrationError();
      next[field][id] = limit;
    }
  }
  if (!samePolicy(before, next)) {
    next.revision += 1;
    next.changes.push({ revision: next.revision, at, dailyLimit: next.dailyLimit,
      projectDailyLimits: { ...next.projectDailyLimits }, teamDailyLimits: { ...next.teamDailyLimits }, agentDailyLimits: { ...next.agentDailyLimits } });
  }
  const ids = new Set(next.starts.map(entry => entry.id));
  for (const entry of source.starts.slice(prior?.starts.length ?? 0)) {
    if (ids.has(entry.id)) throw migrationError();
    ids.add(entry.id); next.starts.push({ ...entry, sequence: next.starts.length + 1 });
  }
  next.usageImports = [...(next.usageImports ?? []), reference];
  ledgerSchema.parse(next);
  return next;
}
type LegacyLedger = z.infer<typeof legacyLedgerSchema>;
type Ledger = z.infer<typeof ledgerSchema>;
export class OperationalBudgetError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'OperationalBudgetError'; }
}
export class OperationalBudgetPause extends BudgetPauseError {
  constructor(readonly block: OperationalBudgetBlock) { super(block.reason); }
}
export interface OperationalBudgetOptions { directory: string; ownerKey: string; now?: () => Date }
export interface OperationalBudgetScopes { teamIds?: string[]; agentIds?: string[] }
export type BudgetAttributionResolver = (entry: { runId: string; rootRunId: string; projectId: string | null }) =>
  { teamId?: string | null; agentId?: string } | undefined;

export function operationalBudgetBlock(snapshot: OperationalBudgetStatus, projectId: string | null,
  teamId?: string | null, agentId?: string): OperationalBudgetBlock | null {
  const project = snapshot.projects.find(item => item.projectId === projectId);
  // Missing legacy attribution may belong to any scope. Explicit null means no team.
  const team = snapshot.teams?.find(item => (teamId === undefined || item.teamId === teamId) && item.remaining === 0);
  const agent = snapshot.agents?.find(item => (agentId === undefined || item.agentId === agentId) && item.remaining === 0);
  const base = { source: 'operational' as const, projectId, teamId, agentId, date: snapshot.date, resetAt: snapshot.resetAt };
  if (snapshot.remaining === 0) return { ...base, blockedBy: 'global',
    reason: `전체 일일 모델 시작 ${snapshot.dailyLimit}회 한도를 사용했습니다. 한국시간 자정 또는 한도 변경 후 이어갑니다.` };
  if (project?.remaining === 0) return { ...base, blockedBy: 'project',
    reason: `원래 과제 프로젝트의 일일 모델 시작 ${project.limit}회 한도를 사용했습니다. 다른 프로젝트의 잔여 한도는 유지됩니다.` };
  if (team) return { ...base, teamId: team.teamId, blockedBy: 'team',
    reason: `원래 과제 팀의 일일 모델 시작 ${team.limit}회 한도를 사용했습니다. 귀속 미기록 사용량도 보수적으로 포함합니다.` };
  if (agent) return { ...base, agentId: agent.agentId, blockedBy: 'agent',
    reason: `실행 에이전트의 일일 모델 시작 ${agent.limit}회 한도를 사용했습니다. 귀속 미기록 사용량도 보수적으로 포함합니다.` };
  return null;
}

/** Installation-owned ledger, deliberately outside restorable workspace generations.
 * Reservations are conservative and never refunded after a crash or rollback.
 */
export class OperationalModelBudget {
  readonly directory: string;
  private readonly ownerKey: string;
  private readonly clock: () => Date;
  private constructor(options: OperationalBudgetOptions) {
    this.directory = resolve(options.directory); this.ownerKey = z.uuid().parse(options.ownerKey); this.clock = options.now ?? (() => new Date());
  }
  static async open(options: OperationalBudgetOptions): Promise<OperationalModelBudget> {
    const budget = new OperationalModelBudget(options); await secureDirectory(budget.directory);
    await budget.locked(async () => {
      const anchor = join(budget.directory, 'identity.json'), path = join(budget.directory, 'ledger.json');
      const identity = await budget.file(anchor), ledger = await budget.file(path);
      if (!identity && !ledger) {
        if (await budget.file(join(budget.directory, originalArchive))
          || (await readdir(budget.directory)).some(name => name.startsWith('ledger.import.'))) throw new OperationalBudgetError(409, '기존 운영 원장 보존본이 있습니다. 새 원장으로 초기화하지 않습니다.');
        const initial: Ledger = { version: 2, ownerKey: budget.ownerKey, identity: randomUUID(), createdAt: budget.clock().toISOString(),
          revision: 0, dailyLimit: 100, projectDailyLimits: {}, teamDailyLimits: {}, agentDailyLimits: {}, starts: [], changes: [] };
        // Partial initialization is an explicit error on restart, never a reset.
        await writeFile(anchor, JSON.stringify({ version: 1, ownerKey: initial.ownerKey, identity: initial.identity }), { flag: 'wx', mode: 0o600 });
        await writeFile(path, JSON.stringify(initial), { flag: 'wx', mode: 0o600 });
      } else if (!identity || !ledger) throw new OperationalBudgetError(409, '운영 예산 원장 또는 식별 기록이 없습니다. 사용 이력을 초기화하지 않았습니다.');
      await budget.readLedger();
    });
    return budget;
  }
  private async file(path: string): Promise<Buffer | null> {
    const info = await lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(maximumFile)
      || relative(resolve(path), await realpath(path))) throw migrationError();
    const same = (other: typeof info) => other.isFile() && !other.isSymbolicLink() && other.nlink === 1n
      && other.dev === info.dev && other.ino === info.ino && other.size === info.size
      && other.mtimeNs === info.mtimeNs && other.ctimeNs === info.ctimeNs;
    const handle = await open(path, 'r');
    try {
      if (!same(await handle.stat({ bigint: true }))) throw migrationError();
      const chunks: Buffer[] = []; let length = 0;
      while (length <= maximumFile) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maximumFile + 1 - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
        if (!bytesRead) break;
        length += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
      }
      if (length > maximumFile || BigInt(length) !== info.size || !same(await handle.stat({ bigint: true }))
        || !same(await lstat(path, { bigint: true })) || relative(resolve(path), await realpath(path))) throw migrationError();
      return Buffer.concat(chunks, length);
    } finally { await handle.close(); }
  }
  private async readLedger(): Promise<Ledger> {
    const identity = await this.file(join(this.directory, 'identity.json')), bytes = await this.file(join(this.directory, 'ledger.json'));
    if (!identity || !bytes) throw new OperationalBudgetError(409, '운영 예산 원장을 확인할 수 없습니다. 자동 초기화하지 않습니다.');
    const anchor = anchorSchema.parse(json(identity));
    const raw = json(bytes) as { version?: unknown };
    const ledger = raw.version === 1 ? legacyLedgerSchema.parse(raw) : ledgerSchema.parse(raw);
    if (anchor.ownerKey !== this.ownerKey || ledger.ownerKey !== this.ownerKey || anchor.identity !== ledger.identity
      || ledger.starts.some((entry, index) => entry.sequence !== index + 1)
      || ledger.changes.length !== ledger.revision || ledger.changes.some((change, index) => change.revision !== index + 1)) {
      throw new OperationalBudgetError(409, '운영 예산 원장 소유권·사용 순서가 일치하지 않습니다.');
    }
    if (ledger.version === 1) return this.migrate(ledger, bytes);
    await this.validateMigration(ledger);
    try {
      const recovered = await this.recoverImport(ledger, bytes);
      await this.validateImports(recovered);
      return recovered;
    } catch { throw migrationError(); }
  }

  /** Read-only source export: no directory/identity creation and no v1 migration. The caller owns the cutover hold. */
  static async exportMigration(options: Pick<OperationalBudgetOptions, 'directory' | 'ownerKey'>): Promise<OperationalBudgetMigration> {
    try {
      if (!isAbsolute(options.directory)) throw migrationError();
      const budget = new OperationalModelBudget(options);
      const checkDirectory = async () => {
        let cursor = parse(budget.directory).root;
        for (const part of relative(cursor, budget.directory).split(/[\\/]/).filter(Boolean)) {
          cursor = join(cursor, part); const info = await lstat(cursor);
          if (!info.isDirectory() || info.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw migrationError();
        }
      };
      await checkDirectory();
      return await budget.locked(async () => {
        const identity = await budget.file(join(budget.directory, 'identity.json'));
        const ledger = await budget.file(join(budget.directory, 'ledger.json'));
        const legacy = await budget.file(join(budget.directory, originalArchive));
        if (!identity || !ledger || (await readdir(budget.directory)).some(name => name.startsWith('ledger.import.'))) throw migrationError();
        const anchor = anchorSchema.parse(json(identity));
        const snapshot = migrationValue({ version: 1, ownerKey: options.ownerKey, identity: anchor.identity,
          identityRaw: new TextDecoder('utf-8', { fatal: true }).decode(identity),
          ledgerRaw: new TextDecoder('utf-8', { fatal: true }).decode(ledger), ledgerSha256: hash(ledger),
          ...(legacy ? { legacyRaw: new TextDecoder('utf-8', { fatal: true }).decode(legacy) } : {}) }).snapshot;
        await checkDirectory(); return snapshot;
      });
    } catch { throw migrationError(); }
  }

  private importPath(id: string, kind: 'source' | 'before' | 'receipt'): string {
    return join(this.directory, `ledger.import.${z.uuid().parse(id)}.${kind}.json`);
  }
  private async importFiles(reference: ImportReference, pendingReceipt?: ImportReceipt) {
    const raw = await this.file(this.importPath(reference.id, 'receipt'))
      ?? (pendingReceipt ? Buffer.from(JSON.stringify(pendingReceipt)) : null);
    if (!raw || raw.length > 16 * 1024 || hash(raw) !== reference.sha256) throw migrationError();
    const receipt = importReceiptSchema.parse(json(raw));
    if (receipt.id !== reference.id || receipt.ownerKey !== this.ownerKey) throw migrationError();
    const sourceRaw = await this.file(this.importPath(receipt.id, 'source'));
    const beforeRaw = await this.file(this.importPath(receipt.id, 'before'));
    if (!sourceRaw || !beforeRaw || hash(sourceRaw) !== receipt.sourceSnapshotSha256 || hash(beforeRaw) !== receipt.beforeLedgerSha256) throw migrationError();
    const source = migrationValue(json(sourceRaw));
    if (source.snapshot.ownerKey !== receipt.sourceOwnerKey || source.snapshot.identity !== receipt.sourceIdentity
      || source.snapshot.ledgerSha256 !== receipt.sourceLedgerSha256) throw migrationError();
    const before = checkedLedger(json(beforeRaw), this.ownerKey, receipt.identity);
    await this.validateMigration(before);
    return { receipt, source, before };
  }
  private async validateImports(ledger: Ledger): Promise<ImportedSources> {
    const origins: ImportedSources = new Map();
    for (const [index, reference] of (ledger.usageImports ?? []).entries()) {
      const { receipt, source, before } = await this.importFiles(reference);
      if (receipt.identity !== ledger.identity || before.createdAt !== ledger.createdAt
        || !isDeepStrictEqual(before.usageImports ?? [], ledger.usageImports!.slice(0, index))) throw migrationError();
      const expected = applyImport(before, source.ledger, origins, receipt.at, reference, receipt.policyDecision);
      if (!preservedCharges(expected.starts, ledger.starts) || ledger.revision < expected.revision
        || !isDeepStrictEqual(ledger.changes.slice(0, expected.changes.length), expected.changes)
        || ledger.revision === expected.revision && !samePolicy(ledger, expected)) throw migrationError();
      origins.set(source.ledger.identity, { ownerKey: source.ledger.ownerKey, starts: source.ledger.starts });
    }
    return origins;
  }
  private async recoverImport(ledger: Ledger, raw: Buffer): Promise<Ledger> {
    const bytes = await this.file(join(this.directory, 'ledger.import.pending.json'));
    if (!bytes) {
      if (ledger.usageImports?.length || (await readdir(this.directory)).some(name => /^ledger\.import\.[a-f0-9-]{36}\.receipt\.json$/.test(name))) throw migrationError();
      return ledger;
    }
    if (bytes.length > 16 * 1024) throw migrationError();
    const journal = importJournalSchema.parse(json(bytes));
    if (journal.ownerKey !== this.ownerKey || journal.identity !== ledger.identity) throw migrationError();
    const receiptBytes = Buffer.from(JSON.stringify(journal.receiptDocument));
    if (hash(receiptBytes) !== journal.receipt.sha256) throw migrationError();
    const { receipt, source, before } = await this.importFiles(journal.receipt, journal.receiptDocument);
    if (receipt.identity !== ledger.identity) throw migrationError();
    const origins = await this.validateImports(before);
    const after = applyImport(before, source.ledger, origins, receipt.at, journal.receipt, receipt.policyDecision);
    if (hash(JSON.stringify(after)) !== journal.afterLedgerSha256) throw migrationError();
    const receiptPath = this.importPath(journal.receipt.id, 'receipt');
    if (!await this.file(receiptPath)) await this.preserveImport(receiptPath, receiptBytes);
    if (ledger.usageImports?.some(reference => reference.id === journal.receipt.id)) {
      if (!isDeepStrictEqual(ledger.usageImports.at(-1), journal.receipt)) throw migrationError();
      return ledger;
    }
    if (hash(raw) !== receipt.beforeLedgerSha256) throw migrationError();
    await atomicJson(join(this.directory, 'ledger.json'), after);
    return after;
  }
  private async preserveImport(path: string, bytes: Buffer): Promise<void> {
    if (bytes.length > maximumFile) throw migrationError();
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const actual = await this.file(path); if (!actual?.equals(bytes)) throw migrationError();
  }

  /** Append charges under the existing target identity. Policies may only add non-conflicting scopes. */
  async importMigration(raw: unknown, options: OperationalBudgetImportOptions): Promise<OperationalBudgetImportResult> {
    try {
      const input = z.object({ sourceOwnerKey: z.uuid(), sourceLedgerSha256: digest,
        expectedRevision: z.number().int().nonnegative(), approvedDailyLimit: operationalLimit.optional(),
        expectedSourceDailyLimit: operationalLimit.optional() }).strict()
        .refine(value => (value.approvedDailyLimit === undefined) === (value.expectedSourceDailyLimit === undefined)).parse(options);
      const source = migrationValue(raw);
      if (source.snapshot.ownerKey !== input.sourceOwnerKey || source.snapshot.ledgerSha256 !== input.sourceLedgerSha256) throw migrationError();
      if (input.expectedSourceDailyLimit !== undefined && input.expectedSourceDailyLimit !== source.ledger.dailyLimit) throw migrationError();
      const sourceBytes = Buffer.from(JSON.stringify(source.snapshot));
      if (sourceBytes.length > maximumFile) throw migrationError();
      return await this.locked(async () => {
        const before = await this.readLedger();
        const origins = await this.validateImports(before);
        for (const reference of before.usageImports ?? []) {
          const { receipt } = await this.importFiles(reference);
          if (receipt.sourceIdentity === source.snapshot.identity && receipt.sourceLedgerSha256 === source.snapshot.ledgerSha256) {
            if (receipt.sourceSnapshotSha256 !== hash(sourceBytes)
              || receipt.policyDecision?.dailyLimit !== input.approvedDailyLimit
              || receipt.policyDecision?.sourceDailyLimit !== input.expectedSourceDailyLimit
              || receipt.policyDecision && receipt.policyDecision.expectedRevision !== input.expectedRevision) throw migrationError();
            return { importId: receipt.id, appended: 0, totalImported: origins.get(source.snapshot.identity)!.starts.length,
              sourceIdentity: source.snapshot.identity, sourceLedgerSha256: source.snapshot.ledgerSha256 };
          }
        }
        if (before.revision !== input.expectedRevision) throw migrationError();
        const beforeBytes = await this.file(join(this.directory, 'ledger.json'));
        if (!beforeBytes || !isDeepStrictEqual(json(beforeBytes), before)) throw migrationError();
        const id = randomUUID();
        const receipt: ImportReceipt = { version: 1, id, ownerKey: this.ownerKey, identity: before.identity,
          sourceOwnerKey: source.snapshot.ownerKey, sourceIdentity: source.snapshot.identity,
          sourceLedgerSha256: source.snapshot.ledgerSha256, sourceSnapshotSha256: hash(sourceBytes),
          beforeLedgerSha256: hash(beforeBytes), at: this.clock().toISOString(),
          ...(input.approvedDailyLimit === undefined ? {} : { policyDecision: {
            dailyLimit: input.approvedDailyLimit, sourceDailyLimit: source.ledger.dailyLimit,
            targetDailyLimit: before.dailyLimit, expectedRevision: before.revision } }) };
        const receiptBytes = Buffer.from(JSON.stringify(receipt)), reference = { id, sha256: hash(receiptBytes) };
        const after = applyImport(before, source.ledger, origins, receipt.at, reference, receipt.policyDecision);
        if (Buffer.byteLength(JSON.stringify(after)) > maximumFile) throw migrationError();
        // All immutable evidence precedes the recoverable intent. No success is returned before ledger commit.
        await this.preserveImport(this.importPath(id, 'source'), sourceBytes);
        await this.preserveImport(this.importPath(id, 'before'), beforeBytes);
        await atomicJson(join(this.directory, 'ledger.import.pending.json'), { version: 1, ownerKey: this.ownerKey,
          identity: before.identity, receipt: reference, receiptDocument: receipt, afterLedgerSha256: hash(JSON.stringify(after)) });
        await this.preserveImport(this.importPath(id, 'receipt'), receiptBytes);
        await atomicJson(join(this.directory, 'ledger.json'), after);
        await this.readLedger();
        return { importId: id, appended: after.starts.length - before.starts.length, totalImported: source.ledger.starts.length,
          sourceIdentity: source.snapshot.identity, sourceLedgerSha256: source.snapshot.ledgerSha256 };
      });
    } catch { throw migrationError(); }
  }
  private async migrate(legacy: LegacyLedger, bytes: Buffer): Promise<Ledger> {
    const path = join(this.directory, originalArchive), preserved = await this.file(path);
    if (preserved && !preserved.equals(bytes)) throw new OperationalBudgetError(409, '기존 원장과 최초 보존본이 다릅니다. 보존본을 덮어쓰지 않았습니다.');
    if (!preserved) {
      // Create-only and sync before replacing the active ledger. A partial archive
      // fails closed; an exact archive allows a restart to finish the migration.
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
    const ledger: Ledger = { ...legacy, version: 2, teamDailyLimits: {}, agentDailyLimits: {},
      migratedFrom: { version: 1, archiveFile: originalArchive, sha256: createHash('sha256').update(bytes).digest('hex') } };
    await atomicJson(join(this.directory, 'ledger.json'), ledger);
    return ledger;
  }
  private async validateMigration(ledger: Ledger): Promise<void> {
    const bytes = await this.file(join(this.directory, originalArchive));
    if (!ledger.migratedFrom) {
      if (bytes) throw new OperationalBudgetError(409, '운영 원장의 이관 기록이 없습니다. 기존 보존본을 무시하지 않습니다.');
      return;
    }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== ledger.migratedFrom.sha256) {
      throw new OperationalBudgetError(409, '운영 원장 최초 보존본을 확인할 수 없습니다. 자동 복구·초기화하지 않습니다.');
    }
    const original = legacyLedgerSchema.parse(JSON.parse(bytes.toString('utf8')));
    const chargesUnchanged = original.starts.every((entry, index) => {
      const current = ledger.starts[index];
      if (!current) return false;
      const { teamId: _team, agentId: _agent, ...charge } = current;
      return isDeepStrictEqual(entry, charge);
    });
    if (ledger.identity !== original.identity || ledger.ownerKey !== original.ownerKey || ledger.createdAt !== original.createdAt
      || ledger.revision < original.revision || !chargesUnchanged
      || !isDeepStrictEqual(ledger.changes.slice(0, original.changes.length), original.changes)
      || (ledger.revision === original.revision && (ledger.dailyLimit !== original.dailyLimit
        || !isDeepStrictEqual(ledger.projectDailyLimits, original.projectDailyLimits)))) {
      throw new OperationalBudgetError(409, '이관된 운영 원장에서 기존 정책·사용 기록이 변경됐습니다.');
    }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const release = await lockfile.lock(this.directory, { stale: 30_000, update: 10_000,
      retries: { retries: 50, factor: 1, minTimeout: 20, maxTimeout: 100 } });
    try { return await operation(); } finally { await release(); }
  }
  private snapshot(ledger: Ledger, projectIds: string[] = [], scopes: OperationalBudgetScopes = {}): OperationalBudgetStatus {
    const day = koreaBudgetDay(this.clock()), today = ledger.starts.filter(entry => entry.date === day.date);
    const legacyUnattributed = { team: today.filter(entry => entry.teamId === undefined).length,
      agent: today.filter(entry => entry.agentId === undefined).length };
    return { enabled: true, ...day, timezone: 'Asia/Seoul', revision: ledger.revision, dailyLimit: ledger.dailyLimit,
      used: today.length, remaining: Math.max(0, ledger.dailyLimit - today.length), projectDailyLimits: { ...ledger.projectDailyLimits },
      projects: [...new Set([...projectIds, ...Object.keys(ledger.projectDailyLimits), ...today.flatMap(entry => entry.projectId ? [entry.projectId] : [])])].map(projectId => {
        const limit = ledger.projectDailyLimits[projectId] ?? null, used = today.filter(entry => entry.projectId === projectId).length;
        return { projectId, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
      }), teamDailyLimits: { ...ledger.teamDailyLimits }, agentDailyLimits: { ...ledger.agentDailyLimits }, legacyUnattributed,
      teams: [...new Set([...(scopes.teamIds ?? []), ...Object.keys(ledger.teamDailyLimits), ...today.flatMap(entry => entry.teamId ? [entry.teamId] : [])])].map(teamId => {
        const limit = ledger.teamDailyLimits[teamId] ?? null, used = legacyUnattributed.team + today.filter(entry => entry.teamId === teamId).length;
        return { teamId, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
      }), agents: [...new Set([...(scopes.agentIds ?? []), ...Object.keys(ledger.agentDailyLimits), ...today.flatMap(entry => entry.agentId ? [entry.agentId] : [])])].map(agentId => {
        const limit = ledger.agentDailyLimits[agentId] ?? null, used = legacyUnattributed.agent + today.filter(entry => entry.agentId === agentId).length;
        return { agentId, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
      }), waiting: [] };
  }
  async status(projectIds: string[] = [], scopes: OperationalBudgetScopes = {}): Promise<OperationalBudgetStatus> {
    return this.locked(async () => this.snapshot(await this.readLedger(), projectIds, scopes));
  }
  async canStart(projectId: string | null, teamId?: string | null, agentId?: string): Promise<boolean> {
    const snapshot = await this.status(projectId ? [projectId] : [], { teamIds: teamId ? [teamId] : [], agentIds: agentId ? [agentId] : [] });
    return !operationalBudgetBlock(snapshot, projectId, teamId, agentId);
  }
  async update(raw: UpdateOperationalBudgetInput): Promise<OperationalBudgetStatus> {
    const input = updateOperationalBudgetSchema.parse(raw);
    return this.locked(async () => {
      const ledger = await this.readLedger();
      if (ledger.revision !== input.expectedRevision) throw new OperationalBudgetError(409, '다른 화면에서 운영 한도가 변경됐습니다. 현재 설정을 확인한 뒤 다시 저장할 수 있습니다.');
      if (input.dailyLimit !== undefined) ledger.dailyLimit = input.dailyLimit;
      if (input.projectDailyLimits) Object.assign(ledger.projectDailyLimits, input.projectDailyLimits);
      if (input.teamDailyLimits) Object.assign(ledger.teamDailyLimits, input.teamDailyLimits);
      if (input.agentDailyLimits) Object.assign(ledger.agentDailyLimits, input.agentDailyLimits);
      ledger.revision += 1; ledger.changes.push({ revision: ledger.revision, at: this.clock().toISOString(),
        dailyLimit: ledger.dailyLimit, projectDailyLimits: { ...ledger.projectDailyLimits },
        teamDailyLimits: { ...ledger.teamDailyLimits }, agentDailyLimits: { ...ledger.agentDailyLimits } });
      await atomicJson(join(this.directory, 'ledger.json'), ledger); return this.snapshot(ledger);
    });
  }
  async reserve(request: ModelStartRequest, attribution: BudgetAttribution, beforeCommit?: () => Promise<void>): Promise<void> {
    const scopes = { teamIds: attribution.teamId ? [attribution.teamId] : [], agentIds: attribution.agentId ? [attribution.agentId] : [] };
    await this.locked(async () => {
      const ledger = await this.readLedger(), snapshot = this.snapshot(ledger, attribution.projectId ? [attribution.projectId] : [], scopes);
      const block = operationalBudgetBlock(snapshot, attribution.projectId, attribution.teamId, attribution.agentId); if (block) throw new OperationalBudgetPause(block);
      await beforeCommit?.();
      const at = this.clock();
      // If the callback crossed midnight, re-evaluate every limit for the actual
      // reservation day rather than charging a stale day or granting a free start.
      const current = this.snapshot(ledger, attribution.projectId ? [attribution.projectId] : [], scopes);
      const changed = operationalBudgetBlock(current, attribution.projectId, attribution.teamId, attribution.agentId); if (changed) throw new OperationalBudgetPause(changed);
      ledger.starts.push(reservationSchema.parse({ ...request, ...attribution, id: randomUUID(), sequence: ledger.starts.length + 1,
        date: koreaBudgetDay(at).date, recordedAt: at.toISOString() }));
      await atomicJson(join(this.directory, 'ledger.json'), ledger);
    });
  }
  /** Enrich only missing fields from installation-owned run records. Policy and
   * admission history remain unchanged; resolver failure commits nothing. */
  async backfillAttributions(resolver: BudgetAttributionResolver): Promise<{ updated: number; remaining: { team: number; agent: number } }> {
    return this.locked(async () => {
      const ledger = await this.readLedger(); let updated = 0;
      for (const entry of ledger.starts) {
        if (entry.teamId !== undefined && entry.agentId !== undefined) continue;
        const resolved = resolver(Object.freeze({ runId: entry.runId, rootRunId: entry.rootRunId, projectId: entry.projectId }));
        if (resolved === undefined) continue;
        const attribution = attributionFields.parse(resolved); let changed = false;
        if (entry.teamId === undefined && attribution.teamId !== undefined) { entry.teamId = attribution.teamId; changed = true; }
        if (entry.agentId === undefined && attribution.agentId !== undefined) { entry.agentId = attribution.agentId; changed = true; }
        if (changed) updated += 1;
      }
      if (updated) await atomicJson(join(this.directory, 'ledger.json'), ledger);
      return { updated, remaining: { team: ledger.starts.filter(entry => entry.teamId === undefined).length,
        agent: ledger.starts.filter(entry => entry.agentId === undefined).length } };
    });
  }
}
