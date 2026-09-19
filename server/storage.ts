import { assertMigrationOrdinaryRestoreSupported, verifyMigrationActivationAuthorization, type MigrationActivationAuthorization } from './desktop-migration-cutover.ts';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { validateObjectiveState } from './objectives.ts';
import { validateOperatorRequestState } from './operator-requests.ts';
import { validateConsultationState } from './consultations.ts';
import { validateLearningReviews } from '../shared/learning.ts';
import { deploymentHoldSchema } from '../shared/deployment.ts';
import { stableRuntimeHash, workerReleasePinSchema } from '../shared/runtime-releases.ts';
import { validatePersistedGrowthReplay } from './growth-replay.ts';
import type { RuntimeDriver } from '../shared/types.ts';
import type { BackupRecord, RestoreRecord, StorageLimits, StorageStatus, StorageUsage } from '../shared/storage.ts';
import { BROWSER_IMAGE_BYTES } from '../shared/browser.ts';
import { WorkspaceStore, type WorkspaceState } from './store.ts';
import { artifactPreviewManifestSchema } from '../shared/artifact-preview.ts';
import { resolveArtifactPreview } from './artifact-preview.ts';

const GiB = 1024 ** 3;
export const defaultStorageLimits: StorageLimits = { dataBytes: 10 * GiB, backupBytes: 30 * GiB, tempBytes: 10 * GiB, minFreeBytes: 20 * GiB };
const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().nonnegative().safe();
const browserCaptureSchema = z.object({
  id: uuid, runId: uuid, agentId: uuid, conversationId: uuid.nullable(),
  scope: z.object({ type: z.enum(['agent', 'team', 'project']), id: uuid }).strict(),
  createdAt: z.iso.datetime(), bytes: size.positive().max(BROWSER_IMAGE_BYTES), sha256: digest,
  mediaType: z.enum(['image/jpeg', 'image/png']), width: size.positive(), height: size.positive(),
  url: z.string().min(1).max(2048), sourceHash: digest,
}).strict();
const manifestSchema = z.object({
  version: z.literal(1), ownerKey: uuid, id: uuid, createdAt: z.iso.datetime(),
  pinned: z.boolean(), kind: z.enum(['automatic', 'manual']),
  files: z.array(z.object({ path: z.string().regex(/^(?:state\.json|files\/[a-f0-9-]{36}\.blob|volumes\/[a-f0-9-]{36}\.jsonl\.gz)$/), bytes: size, sha256: digest })).max(100_000),
  volumes: z.array(z.object({ runId: uuid, bytes: size, files: size })).max(100_000),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const generationSchema = z.object({ id: uuid, workspaceKey: uuid });
const migrationStageSchema = z.object({ sourceManifestSha256: digest, stateSha256: digest,
  files: z.array(z.object({ path: z.string().regex(/^files\/[a-f0-9-]{36}\.blob$/), bytes: size, sha256: digest }).strict()).max(100_000) }).strict();
const layoutSchema = z.object({ version: z.literal(1), ownerKey: uuid, activeId: uuid.nullable(),
  generations: z.array(generationSchema),
  restores: z.array(generationSchema.extend({ backupId: uuid, createdAt: z.iso.datetime(), ready: z.boolean(), migration: migrationStageSchema.optional() })),
}).strict();
type Layout = z.infer<typeof layoutSchema>;
export interface StorageConfig { rootDir: string; backupDir: string; ownerKey: string; limits?: Partial<StorageLimits>; intervalMs?: number; freeSpace?: (path: string) => Promise<number> }
export interface StorageHost { store: WorkspaceStore; runtime: RuntimeDriver; dataDir: string }
export interface ExternalBackupReference { directory: string; ownerKey: string; backupId: string; manifestSha256: string }
export class StorageError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'StorageError'; }
}
export class StorageCleanupUncertainError extends StorageError {
  readonly cleanupUncertain = true;
  constructor() { super(409, '이관 준비 DB의 종료를 확인하지 못했습니다. 저장소 실행 잠금을 유지합니다.'); this.name = 'StorageCleanupUncertainError'; }
}

export async function secureDirectory(path: string): Promise<void> {
  const target = resolve(path);
  let cursor = parse(target).root;
  for (const part of relative(cursor, target).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    await mkdir(cursor).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const entry = await lstat(cursor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new StorageError(409, '저장 경로에는 심볼릭 링크나 특수 파일을 사용할 수 없습니다.');
  }
  if (relative(target, await realpath(target))) throw new StorageError(409, '저장 경로가 다른 위치를 가리킵니다.');
}

/** Existing sources must never be created as a side effect of inspection. */
export async function existingStorageDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new StorageError(400, '이관 경로는 절대 경로여야 합니다.');
  const target = resolve(path);
  let cursor = parse(target).root;
  for (const part of relative(cursor, target).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StorageError(409, '이관 경로에 우회 연결이나 특수 파일이 있습니다.');
  }
  if (relative(target, await realpath(target))) throw new StorageError(409, '이관 경로가 다른 위치를 가리킵니다.');
  return target;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await secureDirectory(dirname(path));
  const existing = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new StorageError(409, '설정 파일이 일반 파일이 아닙니다.');
  const pending = `${path}.${randomUUID()}.tmp`;
  const handle = await open(pending, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(pending, path);
}

async function jsonFile(path: string, limit = 64 * 1024 * 1024, pin?: { bytes?: number; sha256: string }): Promise<unknown> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(limit)) throw new StorageError(409, '백업 기록의 크기나 파일 형식이 올바르지 않습니다.');
  await existingStorageDirectory(dirname(resolve(path)));
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const same = (other: typeof info) => other.isFile() && other.nlink === 1n && other.dev === info.dev && other.ino === info.ino
    && other.size === info.size && other.mtimeNs === info.mtimeNs && other.ctimeNs === info.ctimeNs;
  try {
    if (!same(await source.stat({ bigint: true }))) throw new StorageError(409, '백업 파일이 변경됐습니다.');
    const buffer = Buffer.alloc(Number(info.size) + 1); let bytes = 0;
    while (bytes < buffer.length) { const part = await source.read(buffer, bytes, buffer.length - bytes, bytes); if (!part.bytesRead) break; bytes += part.bytesRead; }
    if (BigInt(bytes) !== info.size || !same(await source.stat({ bigint: true })) || !same(await lstat(path, { bigint: true }))) throw new StorageError(409, '백업 검사 중 파일이 변경됐습니다.');
    await existingStorageDirectory(dirname(resolve(path)));
    const data = buffer.subarray(0, bytes);
    if (pin && ((pin.bytes !== undefined && pin.bytes !== bytes) || createHash('sha256').update(data).digest('hex') !== pin.sha256)) throw new StorageError(409, '승인된 백업 해시와 원문이 일치하지 않습니다.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } finally { await source.close(); }
}

export async function treeBytes(root: string, skip = new Set<string>()): Promise<number> {
  let bytes = 0;
  const walk = async (path: string, top = false): Promise<void> => {
    const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new StorageError(409, '저장소의 우회 연결을 확인해야 합니다.');
    if (info.isFile()) { bytes += info.size; return; }
    if (!info.isDirectory()) throw new StorageError(409, '저장소에 지원하지 않는 특수 파일이 있습니다.');
    for (const name of await readdir(path)) if (!top || !skip.has(name)) await walk(join(path, name));
  };
  await walk(root, true);
  return bytes;
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new StorageError(409, '백업에는 독립된 일반 파일만 사용할 수 있습니다.');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  if (bytes !== info.size) throw new StorageError(409, '백업 검사 도중 파일 크기가 변경됐습니다.');
  return { bytes, sha256: hash.digest('hex') };
}

function stateDocument(value: unknown): WorkspaceState {
  const arrays = ['agents', 'runs', 'memories', 'skills', 'snapshots', 'activities', 'teams', 'approvals', 'connections', 'projects', 'sharedArtifacts', 'teamTasks', 'messages', 'files', 'fileVersions'];
  if (!value || typeof value !== 'object' || arrays.some(key => !Array.isArray((value as Record<string, unknown>)[key]))) throw new StorageError(409, '백업의 DB 상태 형식이 올바르지 않습니다.');
  const state = value as WorkspaceState;
  for (const key of ['executionStates', 'deliveryRuns', 'messageOrigins'] as const) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new StorageError(409, '백업의 실행 상태가 올바르지 않습니다.');
  }
  for (const agent of state.agents) uuid.parse(agent.id);
  for (const run of state.runs) uuid.parse(run.id);
  if (state.deploymentHold !== undefined) deploymentHoldSchema.parse(state.deploymentHold);
  for (const run of state.runs) if (run.runtimeRelease !== undefined) workerReleasePinSchema.parse(run.runtimeRelease);
  // Backups from before personal environments predate this optional collection.
  // Normalize the restored copy, never rewrite the original backup document.
  state.environmentRevisions ??= [];
  state.conversations ??= [];
  state.conversationMessages ??= [];
  if (state.operatorRequests === undefined) state.operatorRequests = [];
  if (!Array.isArray(state.conversations) || !Array.isArray(state.conversationMessages)) throw new StorageError(409, '백업의 대화 이력 형식이 올바르지 않습니다.');
  // Old backups have no browser evidence collection. Explicit malformed values
  // are not treated as an empty collection, which would silently drop evidence.
  if (state.browserCaptures === undefined) state.browserCaptures = [];
  const captures = z.array(browserCaptureSchema).max(100_000).safeParse(state.browserCaptures);
  if (!captures.success) throw new StorageError(409, '백업의 브라우저 캡처 기록 형식이 올바르지 않습니다.');
  const blobIds = new Set(state.files.map(file => file.id));
  for (const capture of captures.data) {
    if (blobIds.has(capture.id)) throw new StorageError(409, '백업의 브라우저 캡처 파일 ID가 중복됩니다.');
    blobIds.add(capture.id);
  }
  // Preview manifests contain references, not copied site files. Historical
  // artifact revisions must travel with the backup or it is not restorable.
  // Validate only backup/staged copies here; ordinary store reads and startup
  // recovery must remain possible when a malformed preview needs diagnosis.
  if (state.artifactPreviews === undefined) state.artifactPreviews = [];
  const previews = z.array(artifactPreviewManifestSchema).max(100_000).safeParse(state.artifactPreviews);
  if (!previews.success) throw new StorageError(409, '백업의 미리보기 기록 형식이 올바르지 않습니다.');
  if (new Set(previews.data.map(preview => preview.id)).size !== previews.data.length) {
    throw new StorageError(409, '백업의 미리보기 ID가 중복됩니다.');
  }
  for (const preview of previews.data) {
    try { resolveArtifactPreview(state, preview); }
    catch { throw new StorageError(409, '백업의 고정 미리보기 원문·범위·해시가 일치하지 않습니다.'); }
  }
  state.artifactPreviews = previews.data;
  try { validateObjectiveState(state); validatePersistedGrowthReplay(state); validateOperatorRequestState(state); validateConsultationState(state); validateLearningReviews(state); }
  catch (error) { throw new StorageError(409, error instanceof Error ? error.message : '목적·성장 평가의 보존 기록이 올바르지 않습니다.'); }
  return state;
}

/** Restoring data is not permission to reconnect an external account or revive
 * a grant revoked after the backup. Keep historical snapshots/frozen inputs as
 * evidence, but require fresh verification AND explicit current grants. */
function disconnectRestoredGitHub(state: WorkspaceState): void {
  const ids = new Set<string>();
  const timestamp = new Date().toISOString();
  for (const connection of state.connections) {
    // New grants can be configured before verification. Those must not revive
    // either; only old registrations without GitHub/grant metadata are retained.
    if (!connection.github && connection.grants === undefined) continue;
    ids.add(connection.id);
    if (connection.github) connection.github = { ...connection.github, status: 'disconnected', generation: randomUUID() };
    connection.grants = [];
    connection.version = (connection.version ?? 0) + 1;
  }
  for (const agent of state.agents) {
    const retained = agent.repositoryIds.filter(id => !ids.has(id));
    if (retained.length === agent.repositoryIds.length) continue;
    agent.repositoryIds = retained; agent.version += 1; agent.updatedAt = timestamp;
  }
}

/** Personal imported files live in workspace volumes, but browser captures are
 * operator evidence in the blob store even when their visibility scope is agent. */
function backupBlobs(state: WorkspaceState) {
  return [...state.files.filter(file => file.scope.type !== 'agent').map(file => ({ ...file, kind: '공유 파일' })),
    ...(state.browserCaptures ?? []).map(capture => ({ ...capture, kind: '브라우저 캡처' }))];
}

/** Ready history and frozen task inputs remain selectable after restore, even if
 * no current Agent points at them. An unfinished installation may have no volume
 * yet; only a persisted completed build promises that its bundle already exists. */
function verifyEnvironmentReferences(state: WorkspaceState, volumes: Set<string>): void {
  if (state.environmentRevisions !== undefined && !Array.isArray(state.environmentRevisions)) {
    throw new StorageError(409, '백업의 개인 환경 이력 형식이 올바르지 않습니다.');
  }
  const requireBundle = (id: unknown) => {
    const parsed = uuid.safeParse(id);
    if (!parsed.success || !volumes.has(parsed.data)) throw new StorageError(409, '검증된 개인 환경의 실행 번들이 백업에 없습니다.');
  };
  for (const revision of state.environmentRevisions ?? []) {
    if (revision?.status === 'ready') requireBundle(revision.buildRunId);
  }
  for (const [runId, execution] of Object.entries(state.executionStates)) {
    if (execution?.input?.environment) requireBundle(execution.input.environment.buildRunId);
    // A crash can leave the successful result checkpoint ahead of the ready
    // revision transaction. Replaying that checkpoint must not activate an absent
    // bundle. Queued/failed partial builds do not make this completion promise.
    if (execution?.input?.environmentBuild && execution.checkpoint?.phase === 'complete'
      && execution.checkpoint.previousResult?.environmentBuild) requireBundle(runId);
  }
}

export async function loadStorageLayout(config: StorageConfig): Promise<Layout> {
  uuid.parse(config.ownerKey);
  try {
    const layout = layoutSchema.parse(await jsonFile(join(resolve(config.rootDir), 'storage-layout.json')));
    if (layout.ownerKey !== config.ownerKey || (layout.activeId && !layout.generations.some(item => item.id === layout.activeId))) throw new StorageError(409, '활성 데이터 세대의 소유권이 일치하지 않습니다.');
    return layout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, ownerKey: config.ownerKey, activeId: null, generations: [], restores: [] };
  }
}
export async function activeStorage(config: StorageConfig) {
  const layout = await loadStorageLayout(config);
  const generation = layout.generations.find(item => item.id === layout.activeId);
  return { dataDir: generation ? join(resolve(config.rootDir), 'generations', generation.id) : resolve(config.rootDir), workspaceKey: generation?.workspaceKey ?? config.ownerKey };
}

/** Owned local backup sets. State export is a logical copy of the complete application
 * aggregate, not a copy of a running PostgreSQL directory. Every volume is immutable
 * during maintenance and every retained backup is independently restorable. */
export class StorageManager {
  readonly limits: StorageLimits;
  readonly root: string;
  readonly backupRoot: string;
  readonly temporary: string;
  readonly intervalMs: number;
  reason: string | null = null;
  private layout!: Layout;
  private cached?: { time: number; usage: StorageUsage };
  private scanning?: Promise<StorageUsage>;
  private admission: Promise<unknown> = Promise.resolve();
  private reservations = new Map<string, number>();

  constructor(readonly config: StorageConfig, private readonly host: () => StorageHost) {
    this.root = resolve(config.rootDir); this.backupRoot = join(resolve(config.backupDir), uuid.parse(config.ownerKey));
    this.temporary = join(this.root, 'storage-tmp');
    const backupBase = resolve(config.backupDir);
    if (!relative(this.root, backupBase).startsWith('..') && !parse(relative(this.root, backupBase)).root) throw new StorageError(400, '백업은 운영 데이터 폴더 바깥에 저장해야 합니다.');
    if (!relative(backupBase, this.root).startsWith('..') && !parse(relative(backupBase, this.root)).root) throw new StorageError(400, '운영 데이터를 백업 폴더 안에 둘 수 없습니다.');
    this.limits = { ...defaultStorageLimits, ...config.limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 0) throw new StorageError(400, '저장 예산은 음수가 아닌 정수 바이트여야 합니다.');
    this.intervalMs = config.intervalMs ?? 86_400_000;
  }

  async initialize() {
    await secureDirectory(this.root); await secureDirectory(this.backupRoot); await secureDirectory(this.temporary);
    this.layout = await loadStorageLayout(this.config);
    // A crash after staging rename but before the active pointer commit keeps the
    // original active generation. Move only the recorded restore back for retry.
    for (const restore of this.layout.restores) {
      const staged = join(this.temporary, restore.id); const moved = join(this.root, 'generations', restore.id);
      const exists = await lstat(staged).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (!exists) {
        const marker = await jsonFile(join(moved, 'operation.json')).catch(() => null) as { ownerKey?: string; id?: string } | null;
        if (marker?.ownerKey === this.config.ownerKey && marker.id === restore.id) { await treeBytes(moved); await rename(moved, staged); }
      }
    }
  }
  private async saveLayout() { await atomicJson(join(this.root, 'storage-layout.json'), this.layout); this.cached = undefined; }
  private runtime(key: string) {
    const runtime = this.host().runtime.forkWorkspace?.(key);
    if (!runtime?.listWorkspaceVolumes) throw new StorageError(503, '현재 실행기는 저장공간 측정·복원을 지원하지 않습니다.');
    return runtime;
  }
  async volumes(signal?: AbortSignal) {
    const runtime = this.host().runtime;
    if (!runtime.listWorkspaceVolumes) throw new StorageError(503, '현재 실행기는 볼륨 저장 기능을 지원하지 않습니다.');
    return runtime.listWorkspaceVolumes(signal);
  }
  async usage(fresh = false): Promise<StorageUsage> {
    if (!fresh && this.cached && Date.now() - this.cached.time < 5000) return this.cached.usage;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      let dataBytes = await treeBytes(this.root, new Set(['storage-tmp', 'controller.lock']));
      let tempBytes = await treeBytes(this.temporary);
      for (const key of new Set([this.config.ownerKey, ...this.layout.generations.map(item => item.workspaceKey)])) {
        for (const volume of await this.runtime(key).listWorkspaceVolumes!()) dataBytes += volume.bytes;
      }
      for (const restore of this.layout.restores) {
        for (const volume of await this.runtime(restore.workspaceKey).listWorkspaceVolumes!()) tempBytes += volume.bytes;
      }
      const free = this.config.freeSpace ?? (async (path: string) => { const info = await statfs(path); return info.bavail * info.bsize; });
      const freeBytes = Math.min(await free(this.root), await free(this.backupRoot));
      const usage = { dataBytes, backupBytes: await treeBytes(this.backupRoot), tempBytes, freeBytes };
      this.cached = { time: Date.now(), usage }; return usage;
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  async check(add: Partial<Pick<StorageUsage, 'dataBytes' | 'backupBytes' | 'tempBytes'>> = {}, fresh = false): Promise<void> {
    const usage = await this.usage(fresh);
    for (const key of ['dataBytes', 'backupBytes', 'tempBytes'] as const) {
      if (usage[key] + (add[key] ?? 0) + (key === 'dataBytes' && Object.keys(add).length ? [...this.reservations.values()].reduce((a, b) => a + b, 0) : 0) > this.limits[key]) throw new StorageError(507, `${key === 'dataBytes' ? '운영 데이터' : key === 'backupBytes' ? '백업' : '임시 공간'} 예산이 부족합니다. 기존 자료를 보존하고 대기합니다.`);
    }
    const reserved = Object.keys(add).length ? [...this.reservations.values()].reduce((a, b) => a + b, 0) : 0;
    if (usage.freeBytes - reserved - Object.values(add).reduce((sum, value) => sum + value, 0) < this.limits.minFreeBytes) throw new StorageError(507, '실제 디스크의 최소 여유 공간을 확보할 때까지 대기합니다.');
  }
  async reserveData(owner: string, bytes: number): Promise<() => void> {
    const task = this.admission.then(async () => {
      if (this.reservations.has(owner)) throw new StorageError(409, '중복 디스크 예약입니다.');
      await this.check({ dataBytes: bytes }, true); this.reservations.set(owner, bytes);
      return () => { this.reservations.delete(owner); this.cached = undefined; };
    });
    this.admission = task.catch(() => undefined); return task;
  }
  invalidate() { this.cached = undefined; }
  private async manifest(id: string): Promise<Manifest> {
    uuid.parse(id);
    const directory = join(this.backupRoot, id);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StorageError(409, '백업 디렉터리가 올바르지 않습니다.');
    const value = manifestSchema.parse(await jsonFile(join(directory, 'manifest.json')));
    if (value.id !== id || value.ownerKey !== this.config.ownerKey) throw new StorageError(409, '백업 소유권이 일치하지 않습니다.');
    return value;
  }
  async backups(): Promise<BackupRecord[]> {
    const result: BackupRecord[] = [];
    for (const entry of await readdir(this.backupRoot, { withFileTypes: true })) {
      if (!uuid.safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const manifest = await this.manifest(entry.name);
      result.push({ id: manifest.id, createdAt: manifest.createdAt, pinned: manifest.pinned, kind: manifest.kind,
        bytes: await treeBytes(join(this.backupRoot, manifest.id)), verified: true });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async status(busy: boolean, paused: boolean): Promise<StorageStatus> {
    let usage: StorageUsage = this.cached?.usage ?? { dataBytes: 0, backupBytes: 0, tempBytes: 0, freeBytes: 0 };
    let reason = this.reason;
    try { usage = await this.usage(); await this.check(); } catch (error) { reason = error instanceof Error ? error.message : '저장공간을 측정하지 못했습니다.'; }
    const backups = await this.backups();
    return { enabled: true, limits: this.limits, usage, backupDir: this.backupRoot, busy, paused, reason, backups,
      restores: this.layout.restores.filter(item => item.ready).map(({ id, backupId, createdAt }) => ({ id, backupId, createdAt })), lastBackupAt: backups[0]?.createdAt ?? null };
  }

  private async verify(directory: string, manifest: Manifest): Promise<WorkspaceState> {
    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new StorageError(409, '백업에 중복 파일이 있습니다.');
    if (!manifest.files.some(file => file.path === 'state.json')) throw new StorageError(409, '백업 DB 상태가 없습니다.');
    for (const file of manifest.files) {
      // All components are validated; never follow a symlink in the archive folder.
      const parent = dirname(join(directory, file.path));
      if (relative(resolve(parent), await realpath(parent))) throw new StorageError(409, '백업에 우회 경로가 있습니다.');
      const actual = await hashFile(join(directory, file.path));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new StorageError(409, '백업 무결성 검증에 실패했습니다.');
    }
    const stateEntry = manifest.files.find(file => file.path === 'state.json')!;
    const state = stateDocument(await jsonFile(join(directory, 'state.json'), 64 * 1024 * 1024, stateEntry));
    const paths = new Set(manifest.files.map(file => file.path));
    const entries = new Map(manifest.files.map(file => [file.path, file]));
    for (const file of backupBlobs(state)) {
      uuid.parse(file.id);
      const entry = entries.get(`files/${file.id}.blob`);
      if (!entry) throw new StorageError(409, `${file.kind}이 백업에 없습니다.`);
      if (entry.bytes !== file.bytes || entry.sha256 !== file.sha256) throw new StorageError(409, `${file.kind}이 백업 DB 기록과 일치하지 않습니다.`);
    }
    const volumes = new Set(manifest.volumes.map(volume => volume.runId));
    if (volumes.size !== manifest.volumes.length) throw new StorageError(409, '백업에 중복 작업 볼륨이 있습니다.');
    for (const volume of manifest.volumes) if (!paths.has(`volumes/${volume.runId}.jsonl.gz`)) throw new StorageError(409, '작업 볼륨이 백업에 없습니다.');
    for (const id of [...state.agents.map(agent => agent.workspaceRunId), ...state.snapshots.map(item => item.agent.workspaceRunId)]) {
      if (id && !volumes.has(id)) throw new StorageError(409, '파일 복원 시점이 백업에 없습니다.');
    }
    verifyEnvironmentReferences(state, volumes);
    return state;
  }

  /** Caller holds the service maintenance gate and has confirmed no worker writes. */
  async backup(kind: 'automatic' | 'manual' = 'manual'): Promise<BackupRecord> {
    const host = this.host();
    if (!host.runtime.exportWorkspace) throw new StorageError(503, '볼륨 백업을 지원하지 않는 실행기입니다.');
    const volumes = await this.volumes();
    const state = stateDocument(await host.store.read());
    const stateJson = JSON.stringify(state);
    if (Buffer.byteLength(stateJson) > 64 * 1024 * 1024) throw new StorageError(413, '첫 버전의 DB 논리 백업 한도는 64MiB입니다. 기존 데이터는 보존합니다.');
    const estimate = volumes.reduce((sum, volume) => sum + volume.bytes, 0) + await treeBytes(join(host.dataDir, 'files')) + Buffer.byteLength(stateJson) + 1024 * 1024;
    await this.check({ tempBytes: estimate }, true);
    const id = randomUUID(); const staging = join(this.temporary, id);
    await secureDirectory(staging);
    await atomicJson(join(staging, 'operation.json'), { ownerKey: this.config.ownerKey, id });
    const manifest: Manifest = { version: 1, ownerKey: this.config.ownerKey, id, createdAt: new Date().toISOString(), pinned: false, kind, files: [], volumes };
    try {
      await writeFile(join(staging, 'state.json'), stateJson, { flag: 'wx', mode: 0o600 });
      manifest.files.push({ path: 'state.json', ...await hashFile(join(staging, 'state.json')) });
      await secureDirectory(join(staging, 'files')); await secureDirectory(join(staging, 'volumes'));
      for (const file of backupBlobs(state)) {
        uuid.parse(file.id);
        const source = join(host.dataDir, 'files', `${file.id}.blob`);
        const hashed = await hashFile(source);
        if (hashed.sha256 !== file.sha256 || hashed.bytes !== file.bytes) throw new StorageError(409, `${file.kind}이 DB 기록과 일치하지 않습니다.`);
        const path = `files/${file.id}.blob`;
        await pipeline(createReadStream(source), createWriteStream(join(staging, path), { flags: 'wx', mode: 0o600 }));
        manifest.files.push({ path, ...hashed });
      }
      for (const volume of volumes) {
        const path = `volumes/${uuid.parse(volume.runId)}.jsonl.gz`;
        const available = this.limits.tempBytes - await treeBytes(this.temporary);
        const exported = await host.runtime.exportWorkspace(volume.runId, join(staging, path), available);
        manifest.files.push({ path, bytes: exported.bytes, sha256: exported.sha256 });
      }
      await this.verify(staging, manifest);
      await atomicJson(join(staging, 'manifest.json'), manifest);
      const bytes = await treeBytes(staging);
      const old = (await this.backups()).filter(item => !item.pinned);
      const removable = old.slice(2); // New verified set occupies the third retained slot.
      const retained = (await this.usage(true)).backupBytes - removable.reduce((sum, item) => sum + item.bytes, 0);
      if (retained + bytes > this.limits.backupBytes) throw new StorageError(507, '보호된 백업을 유지할 보관 공간이 부족합니다. 새 백업을 게시하지 않았습니다.');
      // Publish by a same-filesystem rename; cross-device backup is a later feature.
      const target = join(this.backupRoot, id);
      try { await rename(staging, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        throw new StorageError(409, '이번 로컬 백업은 운영 데이터와 같은 파일시스템의 경로를 지원합니다. 외부 디스크는 후속 연결 대상입니다.');
      }
      // Only after successful validation/publication do we rotate older owned sets.
      for (const item of removable) {
        const previous = await this.manifest(item.id);
        if (previous.pinned) continue;
        await this.verify(join(this.backupRoot, item.id), previous);
        await treeBytes(join(this.backupRoot, item.id));
        await rm(join(this.backupRoot, uuid.parse(item.id)), { recursive: true });
      }
      this.cached = undefined; this.reason = null;
      return { id, createdAt: manifest.createdAt, pinned: manifest.pinned, kind, bytes, verified: true };
    } finally {
      // This exact fresh operation directory contains only this operation's temp copies.
      const marker = await jsonFile(join(staging, 'operation.json')).catch(() => null) as { ownerKey?: string; id?: string } | null;
      if (marker?.ownerKey === this.config.ownerKey && marker.id === id) { await treeBytes(staging); await rm(staging, { recursive: true }); }
      this.cached = undefined;
    }
  }

  async pin(id: string, pinned: boolean) {
    const manifest = await this.manifest(id);
    await this.verify(join(this.backupRoot, id), manifest);
    await atomicJson(join(this.backupRoot, id, 'manifest.json'), { ...manifest, pinned });
    this.cached = undefined;
  }

  /** Offline caller holds the source controller lease and has confirmed Docker
   * is idle. This does not initialize/repair source layout or rotate any backup.
   * The caller chooses a fresh destination outside both data and backup trees.
   * Standard logical blobs are retained; this is not a secret-content filter. */
  async exportProtected(options: { directory: string; signal?: AbortSignal }): Promise<{
    backup: BackupRecord; manifestSha256: string; stateSha256: string;
  }> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (!isAbsolute(options.directory)) throw new StorageError(400, '내보내기 대상은 절대 경로여야 합니다.');
    const target = resolve(options.directory), parent = await existingStorageDirectory(dirname(target));
    const overlaps = (a: string, b: string) => { const r = relative(a, b); return r === '' || (!r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && r !== '..' && !isAbsolute(r)); };
    if ([this.root, resolve(this.config.backupDir)].some(path => overlaps(path, target) || overlaps(target, path))) throw new StorageError(400, '독립된 새 이관 폴더를 지정해야 합니다.');
    if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new StorageError(409, '이관 대상 폴더가 이미 존재합니다.');
    const host = this.host();
    if (!host.runtime.exportWorkspace) throw new StorageError(503, '볼륨 내보내기를 지원하지 않습니다.');
    const volumes = await this.volumes(signal), state = stateDocument(await host.store.read());
    const raw = JSON.stringify(state), stateBytes = Buffer.byteLength(raw);
    if (stateBytes > 64 * 1024 * 1024) throw new StorageError(413, 'DB 논리 백업 한도는 64MiB입니다.');
    const estimate = stateBytes + volumes.reduce((n, v) => n + v.bytes, 0) + await treeBytes(join(host.dataDir, 'files')) + 1024 * 1024;
    const free = this.config.freeSpace ?? (async (path: string) => { const fs = await statfs(path); return fs.bavail * fs.bsize; });
    const check = async (remaining = 0) => {
      signal?.throwIfAborted();
      if (await free(parent) - remaining < this.limits.minFreeBytes) throw new StorageError(507, '이관 백업과 최소 디스크 여유 공간을 확보해야 합니다.');
    };
    if (estimate > this.limits.tempBytes || estimate > this.limits.backupBytes) throw new StorageError(507, '이관 백업의 저장 예산이 부족합니다.');
    await check(estimate);
    const id = randomUUID(), staging = join(parent, `.migration-${id}`);
    await mkdir(staging, { mode: 0o700 });
    // Failed exports are deliberately retained at this unique staging path for inspection.
    await atomicJson(join(staging, 'operation.json'), { ownerKey: this.config.ownerKey, id, target });
    const manifest: Manifest = { version: 1, ownerKey: this.config.ownerKey, id,
      createdAt: new Date().toISOString(), pinned: true, kind: 'manual', files: [], volumes };
    await writeFile(join(staging, 'state.json'), raw, { flag: 'wx', mode: 0o600 });
    manifest.files.push({ path: 'state.json', ...await hashFile(join(staging, 'state.json')) });
    await secureDirectory(join(staging, 'files')); await secureDirectory(join(staging, 'volumes'));
    for (const file of backupBlobs(state)) {
      signal?.throwIfAborted(); uuid.parse(file.id);
      const source = join(host.dataDir, 'files', `${file.id}.blob`), hashed = await hashFile(source);
      if (hashed.bytes !== file.bytes || hashed.sha256 !== file.sha256) throw new StorageError(409, '내보낼 파일과 DB 기록이 다릅니다.');
      await check(hashed.bytes);
      const path = `files/${file.id}.blob`;
      await pipeline(createReadStream(source), createWriteStream(join(staging, path), { flags: 'wx', mode: 0o600 }));
      manifest.files.push({ path, ...hashed });
    }
    for (const volume of volumes) {
      await check(volume.bytes);
      const path = `volumes/${uuid.parse(volume.runId)}.jsonl.gz`;
      const available = Math.min(this.limits.tempBytes, this.limits.backupBytes) - await treeBytes(staging);
      if (available <= 0) throw new StorageError(507, '이관 백업의 저장 예산이 부족합니다.');
      const exported = await host.runtime.exportWorkspace(volume.runId, join(staging, path), available, signal);
      manifest.files.push({ path, bytes: exported.bytes, sha256: exported.sha256 });
    }
    await this.verify(staging, manifest); await check();
    await atomicJson(join(staging, 'manifest.json'), manifest);
    const bytes = await treeBytes(staging);
    if (bytes > this.limits.tempBytes || bytes > this.limits.backupBytes) throw new StorageError(507, '이관 백업의 저장 예산이 부족합니다.');
    const manifestSha256 = (await hashFile(join(staging, 'manifest.json'))).sha256;
    // Reserve the final name first. Windows and POSIX both refuse a competing file;
    // publication cannot replace an existing nonempty backup directory.
    if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new StorageError(409, '이관 대상이 생성되어 게시를 중단합니다.');
    await rename(staging, target);
    return { backup: { id, createdAt: manifest.createdAt, pinned: true, kind: 'manual', bytes, verified: true },
      manifestSha256, stateSha256: manifest.files.find(file => file.path === 'state.json')!.sha256 };
  }

  async inspectExternalBackup(reference: ExternalBackupReference) {
    const directory = await existingStorageDirectory(reference.directory);
    uuid.parse(reference.ownerKey); uuid.parse(reference.backupId); digest.parse(reference.manifestSha256);
    const hashed = await hashFile(join(directory, 'manifest.json'));
    if (hashed.sha256 !== reference.manifestSha256) throw new StorageError(409, '승인된 이관 백업 manifest 해시가 다릅니다.');
    const manifest = manifestSchema.parse(await jsonFile(join(directory, 'manifest.json'), 64 * 1024 * 1024, { sha256: reference.manifestSha256 }));
    if (manifest.ownerKey !== reference.ownerKey || manifest.id !== reference.backupId || !manifest.pinned) throw new StorageError(409, '보호된 이관 백업의 소유권 또는 식별자가 다릅니다.');
    const state = await this.verify(directory, manifest);
    const volumes = new Set(manifest.volumes.map(volume => volume.runId));
    for (const run of state.runs.filter(run => ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status))) {
      const saved = state.executionStates[run.id];
      if (run.workspaceSourceRunId && !volumes.has(run.workspaceSourceRunId)) throw new StorageError(409, '미완료 작업의 원본 작업 볼륨이 이관 백업에 없습니다.');
      if ((saved?.lastSessionId || saved?.checkpoint?.sessionId || saved?.resumeRequired) && !volumes.has(run.id)) throw new StorageError(409, '미완료 작업의 재개 볼륨이 이관 백업에 없습니다.');
    }
    if ((await hashFile(join(directory, 'manifest.json'))).sha256 !== reference.manifestSha256) throw new StorageError(409, '이관 검사 중 manifest가 변경됐습니다.');
    return { manifest, state };
  }

  /** Cross-owner import is explicit; ordinary restore remains same-owner only. */
  async prepareImport(reference: ExternalBackupReference): Promise<RestoreRecord> {
    if (reference.ownerKey === this.config.ownerKey) throw new StorageError(400, '같은 소유자의 백업은 기존 복원 기능을 사용해야 합니다.');
    const { manifest, state } = await this.inspectExternalBackup(reference);
    return this.stageRestore(resolve(reference.directory), manifest, state, reference);
  }

  async prepareRestore(backupId: string): Promise<RestoreRecord> {
    await assertMigrationOrdinaryRestoreSupported(this.root, this.config.ownerKey);
    const manifest = await this.manifest(backupId);
    const directory = join(this.backupRoot, backupId);
    const state = await this.verify(directory, manifest);
    return this.stageRestore(directory, manifest, state);
  }

  private async stageRestore(directory: string, manifest: Manifest, state: WorkspaceState, migration?: ExternalBackupReference): Promise<RestoreRecord> {
    const backupId = manifest.id;
    const estimate = manifest.volumes.reduce((sum, volume) => sum + volume.bytes, 0) + manifest.files.filter(file => !file.path.startsWith('volumes/')).reduce((sum, file) => sum + file.bytes, 0) + 64 * 1024 * 1024;
    await this.check({ tempBytes: estimate }, true);
    const restore: Layout['restores'][number] = { id: randomUUID(), workspaceKey: randomUUID(), backupId, createdAt: new Date().toISOString(), ready: false };
    this.layout.restores.push(restore); await this.saveLayout();
    const destination = join(this.temporary, restore.id);
    await secureDirectory(destination); await atomicJson(join(destination, 'operation.json'), { ownerKey: this.config.ownerKey, id: restore.id });
    const runtime = this.runtime(restore.workspaceKey);
    if (!runtime.importWorkspace) throw new StorageError(503, '볼륨 복원을 지원하지 않는 실행기입니다.');
    // Failure is retained and measured as a staged restore, never exposed as active data.
    for (const volume of manifest.volumes) {
      const archive = manifest.files.find(file => file.path === `volumes/${volume.runId}.jsonl.gz`)!;
      await runtime.importWorkspace(volume.runId, join(directory, archive.path), Math.max(1, Math.min(volume.bytes, this.limits.dataBytes)), undefined,
        { bytes: archive.bytes, sha256: archive.sha256 });
      await this.check({}, true);
    }
    const imported = await runtime.listWorkspaceVolumes!();
    if (manifest.volumes.some(volume => !imported.some(item => item.runId === volume.runId))) throw new StorageError(409, '복원된 작업 볼륨이 불완전합니다.');
    await secureDirectory(join(destination, 'files'));
    for (const file of manifest.files.filter(file => file.path.startsWith('files/'))) {
      await pipeline(createReadStream(join(directory, file.path)), createWriteStream(join(destination, file.path), { flags: 'wx', mode: 0o600 }));
      const actual = await hashFile(join(destination, file.path));
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new StorageError(409, '복원한 공유 파일의 무결성이 일치하지 않습니다.');
    }
    disconnectRestoredGitHub(state);
    state.operatorPaused = true;
    const restored = await WorkspaceStore.open(join(destination, 'db'));
    try {
      await restored.replace(state);
      // JSONB orders object keys independently of the source JSON. Compare the
      // values, including array order, after applying the compatible defaults.
      if (!isDeepStrictEqual(await restored.read(), state)) throw new StorageError(409, '복원한 DB가 원본 상태와 일치하지 않습니다.');
    } finally { try { await restored.close(); } catch { throw new StorageCleanupUncertainError(); } }
    if (migration) {
      await this.inspectExternalBackup(migration);
      await atomicJson(join(destination, 'migration-receipt.json'), { version: 1, source: migration,
        targetOwnerKey: this.config.ownerKey, workspaceKey: restore.workspaceKey, generationId: restore.id,
        createdAt: restore.createdAt, stateSha256: manifest.files.find(file => file.path === 'state.json')!.sha256 });
      restore.migration = { sourceManifestSha256: migration.manifestSha256, stateSha256: stableRuntimeHash(state),
        files: manifest.files.filter(file => file.path.startsWith('files/')) };
    }
    await this.check({}, true);
    restore.ready = true; await this.saveLayout();
    return { id: restore.id, backupId, createdAt: restore.createdAt };
  }

  async activate(id: string, authorization?: MigrationActivationAuthorization): Promise<StorageHost> {
    const selected = this.layout.restores.find(item => item.id === uuid.parse(id) && item.ready);
    if (!selected) throw new StorageError(404, '검증된 복원본을 찾을 수 없습니다.');
    if (selected.migration) await verifyMigrationActivationAuthorization(this.root, this.config.ownerKey, id, authorization);
    else await assertMigrationOrdinaryRestoreSupported(this.root, this.config.ownerKey);
    const runtime = this.runtime(selected.workspaceKey);
    const source = join(this.temporary, id);
    const newBytes = await treeBytes(source) + (await runtime.listWorkspaceVolumes!()).reduce((sum, item) => sum + item.bytes, 0);
    const current = await this.usage(true);
    if (current.dataBytes + newBytes > this.limits.dataBytes) throw new StorageError(507, '기존 상태와 복원본을 함께 보존할 운영 데이터 예산이 부족합니다.');
    const destination = join(this.root, 'generations', id);
    await secureDirectory(dirname(destination));
    await rename(source, destination);
    let store: WorkspaceStore | undefined;
    try {
      store = await WorkspaceStore.open(join(destination, 'db'));
      // Recheck a staged database prepared by an earlier process before changing
      // the active pointer. A failed check retains the original active store.
      const stagedState = stateDocument(await store.read());
      if (selected.migration) {
        const receipt = await jsonFile(join(destination, 'migration-receipt.json')) as {
          targetOwnerKey?: string; workspaceKey?: string; generationId?: string; source?: { manifestSha256?: string };
        };
        if (receipt.targetOwnerKey !== this.config.ownerKey || receipt.workspaceKey !== selected.workspaceKey || receipt.generationId !== id
          || receipt.source?.manifestSha256 !== selected.migration.sourceManifestSha256 || stableRuntimeHash(stagedState) !== selected.migration.stateSha256) throw new StorageError(409, '준비된 이관 DB 또는 출처 영수증이 변경됐습니다.');
        for (const file of selected.migration.files) {
          await existingStorageDirectory(dirname(join(destination, file.path)));
          const actual = await hashFile(join(destination, file.path));
          if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new StorageError(409, '준비된 이관 파일이 변경됐습니다.');
        }
      }
      // Also seal restored copies prepared before this safeguard was installed.
      if (!selected.migration) await store.change(state => { disconnectRestoredGitHub(state); state.operatorPaused = true; });
      else if (!stagedState.operatorPaused) throw new StorageError(409, 'DESKTOP_MIGRATION_MUST_REMAIN_PAUSED');
      const previous = structuredClone(this.layout);
      this.layout.generations.push({ id, workspaceKey: selected.workspaceKey });
      this.layout.restores = this.layout.restores.filter(item => item.id !== id); this.layout.activeId = id;
      try { await this.saveLayout(); } catch (error) { this.layout = previous; throw error; }
      return { store, runtime, dataDir: destination };
    } catch (error) {
      try { await store?.close(); } catch { throw new StorageCleanupUncertainError(); }
      // Layout did not commit: preserve the original active store and allow retry.
      await rename(destination, source);
      throw error;
    }
  }
}
