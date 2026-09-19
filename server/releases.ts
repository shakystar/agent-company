import { inspectImageRuntimeBase as inspectRuntimeBase } from './image-fingerprint.ts';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { command, type Command } from './process.ts';
import type { RuntimeConfig } from './runtime.ts';
import { activeStorage, atomicJson } from './storage.ts';
import { WorkspaceStore } from './store.ts';
import { validOperatorContinuation } from './operator-request-resume.ts';
import { validateOperatorRequestState } from './operator-requests.ts';
import lockfile from 'proper-lockfile';
import { workerSourceFiles, workerImageSchema, workerReleasePinSchema, stableRuntimeHash, createWorkerReleaseManifest,
  validateWorkerReleaseCatalog, requireWorkerRelease, assertCompatibleWorkerReleases,
  type WorkerReleaseManifest, type WorkerReleaseCatalog, type WorkerReleasePin } from '../shared/runtime-releases.ts';
import type { WorkspaceState } from './store.ts';
import type { Run } from '../shared/types.ts';

const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const targetSchema = z.object({ mode: z.literal('docker'), wslDistro: z.string().nullable() }).strict();
const legacyReleaseSchema = z.object({
  version: z.literal(1), ownerKey: z.uuid(), target: targetSchema,
  activeImage: imageId, previousImage: imageId,
  history: z.array(z.object({ image: imageId, previousImage: imageId, action: z.enum(['activate', 'rollback']),
    createdAt: z.iso.datetime(), sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict()).min(1),
}).strict();
const pinnedReleaseSchema = legacyReleaseSchema.extend({ version: z.literal(2), catalog: z.unknown().transform(validateWorkerReleaseCatalog), planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const releaseSchema = z.union([legacyReleaseSchema, pinnedReleaseSchema]);
export type RuntimeRelease = z.infer<typeof releaseSchema>;
export { workerSourceFiles };
const target = (config: RuntimeConfig) => ({ mode: config.mode, wslDistro: config.wslDistro ?? null });
async function optionalJson(path: string): Promise<unknown | null> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('운영 이미지 기록이 일반 파일이 아니거나 너무 큽니다.');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function readRuntimeRelease(root: string, ownerKey: string, config: RuntimeConfig): Promise<RuntimeRelease | null> {
  const identity = await optionalJson(join(root, 'runtime-release.identity.json'));
  const raw = await optionalJson(join(root, 'runtime-release.json'));
  if (!raw && !identity) return null;
  if (!raw || !identity) throw new Error('운영 이미지 기록 일부가 누락됐습니다. 기본 이미지로 대체하지 않습니다.');
  const record = releaseSchema.parse(raw);
  const anchor = z.object({ version: z.literal(1), ownerKey: z.uuid() }).strict().parse(identity);
  if (anchor.ownerKey !== ownerKey || record.ownerKey !== ownerKey
    || JSON.stringify(record.target) !== JSON.stringify(target(config))) throw new Error('운영 이미지의 소유권 또는 Docker 실행 대상이 일치하지 않습니다.');
  const last = record.history.at(-1)!;
  if (last.image !== record.activeImage || last.previousImage !== record.previousImage) throw new Error('운영 이미지 선택과 이력이 일치하지 않습니다.');
  if (record.version === 2) {
    const catalog = validateWorkerReleaseCatalog(record.catalog);
    if (catalog.active.image !== record.activeImage || !catalog.manifests.some(item => item.image === record.previousImage)) throw new Error('운영 이미지 선택과 catalog가 일치하지 않습니다.');
    record.catalog = catalog;
  }
  return record;
}
export async function selectedRuntimeConfig(root: string, ownerKey: string, config: RuntimeConfig): Promise<RuntimeConfig> {
  if (await optionalJson(join(root, 'runtime-release.pending.json'))) throw new Error('이미지 이행이 중단됐습니다. 같은 release 명령으로 복구한 뒤 시작해야 합니다.');
  const release = await readRuntimeRelease(root, ownerKey, config);
  return release ? { ...config, image: release.activeImage, ...(release.version === 2 ? { releaseCatalog: validateWorkerReleaseCatalog(release.catalog) } : {}) } : config;
}
export async function dockerForRelease(config: RuntimeConfig, args: string[], runner: Command = command): Promise<string> {
  if (config.mode !== 'docker') throw new Error('이번 이미지 전환은 로컬 Docker만 지원합니다.');
  const result = await runner(config.wslDistro ? 'wsl.exe' : 'docker', config.wslDistro
    ? ['--distribution', config.wslDistro, '--exec', 'docker', ...args] : args, { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`운영 이미지 확인 실패: ${result.stderr.slice(-1500)}`);
  return result.stdout.trim();
}
export async function resolveImage(config: RuntimeConfig, image: string, runner?: Command): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255}$/.test(image)) throw new Error('이미지 식별자가 올바르지 않습니다.');
  return imageId.parse(await dockerForRelease(config, ['image', 'inspect', image, '--format', '{{.Id}}'], runner));
}
export async function inspectWorkerSources(config: RuntimeConfig, image: string, ownerKey: string, runner?: Command,
  expected?: Record<string, string>): Promise<Record<string, string>> {
  imageId.parse(image); z.uuid().parse(ownerKey);
  if (expected && (Object.keys(expected).length !== workerSourceFiles.length || !workerSourceFiles.every(name => /^[a-f0-9]{64}$/.test(expected[name] ?? '')))) throw new Error('구형 이미지 source hash 증거가 완전하지 않습니다.');
  const name = `ac-release-${ownerKey.slice(0, 8)}`;
  let output: string;
  try { output = await dockerForRelease(config, ['run', '--rm', '--name', name,
    '--label', 'app=agent-company', '--label', `agent-company.workspace=${ownerKey}`, '--label', 'agent-company.role=release-inspection',
    '--read-only', '--network=none', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--memory=64m', '--cpus=0.25', '--pids-limit=32', '--entrypoint=sha256sum', image, ...workerSourceFiles.map(path => `/app/${path}`)], runner); }
  catch (error) {
    const inspectArgs = ['inspect', name, '--format', '{{json .Config.Labels}}'];
    const inspected = await (runner ?? command)(config.wslDistro ? 'wsl.exe' : 'docker', config.wslDistro
      ? ['--distribution', config.wslDistro, '--exec', 'docker', ...inspectArgs] : inspectArgs, { timeoutMs: 30_000 });
    if (inspected.code === 0) {
      const labels = JSON.parse(inspected.stdout);
      if (labels.app !== 'agent-company' || labels['agent-company.workspace'] !== ownerKey || labels['agent-company.role'] !== 'release-inspection') {
        throw new Error('실패한 이미지 검사와 같은 이름의 컨테이너 소유권이 다릅니다. 종료하지 않았습니다.');
      }
      await dockerForRelease(config, ['rm', '-f', name], runner);
    } else if (!/No such (?:object|container)/i.test(inspected.stderr)) {
      throw new Error('이미지 검사 실패 후 검사 컨테이너 종료 여부를 확인하지 못했습니다.');
    }
    throw error;
  }
  const hashes: Record<string, string> = {};
  for (const path of workerSourceFiles) {
    const sha256 = expected?.[path] ?? createHash('sha256').update(await readFile(resolve('worker', path))).digest('hex');
    if (!output.split('\n').some(line => line.trim() === `${sha256}  /app/${path}`)) throw new Error(`이미지와 현재 worker 소스가 다릅니다: ${path}`);
    hashes[path] = sha256;
  }
  return hashes;
}
/** Called under the controller lock; refuses image changes for any saved unfinished Run. */
export async function assertReleaseIdle(root: string, ownerKey: string, config: RuntimeConfig, runner?: Command): Promise<void> {
  const selected = await activeStorage({ rootDir: root, ownerKey, backupDir: root });
  for (const key of new Set([ownerKey, selected.workspaceKey])) {
    if (await dockerForRelease(config, ['ps', '--filter', `label=agent-company.workspace=${key}`, '--format', '{{.ID}}'], runner)) {
      throw new Error('작업실 컨테이너가 실행 중입니다. 이미지 전환을 하지 않았습니다.');
    }
  }
  const dbPath = join(selected.dataDir, 'db');
  const info = await lstat(dbPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('운영 DB 경로를 확인해야 합니다.');
  const store = await WorkspaceStore.open(dbPath);
  try {
    const state = await store.read();
    validateOperatorRequestState(state);
    if (state.runs.some(run => run.cleanupPending || !['succeeded', 'failed', 'cancelled'].includes(run.status)
      && !(run.status === 'superseded' && state.runs.some(child => child.id === run.continuedByRunId
        && validOperatorContinuation(state, child)?.id === run.id)))) {
      throw new Error('일시정지·대기를 포함한 미완료 작업이 있습니다. 동일 작업의 이미지가 바뀌지 않도록 전환을 차단했습니다.');
    }
  } finally { await store.close(); }
}
/** The caller holds the same controller lock as the server. No live Run changes images. */
export async function selectRuntimeRelease(root: string, ownerKey: string, config: RuntimeConfig,
  request: { action: 'activate'; image: string } | { action: 'rollback' }, runner?: Command): Promise<RuntimeRelease> {
  const previous = await readRuntimeRelease(root, ownerKey, config);
  if (previous?.version === 2 || await optionalJson(join(root, 'runtime-release.pending.json'))) throw new Error('실행별 이미지 기록은 정식 pinned release 명령으로만 변경할 수 있습니다.');
  if (request.action === 'rollback' && !previous) throw new Error('복귀할 운영 이미지 이력이 없습니다.');
  const before = previous?.activeImage ?? await resolveImage(config, config.image, runner);
  const image = await resolveImage(config, request.action === 'rollback' ? previous!.previousImage : request.image, runner);
  if (image === before && previous) return previous;
  const sourceHashes = request.action === 'activate' ? await inspectWorkerSources(config, image, ownerKey, runner) : {};
  const result = releaseSchema.parse({ version: 1, ownerKey, target: target(config), activeImage: image, previousImage: before,
    history: [...(previous?.history ?? []), { image, previousImage: before, action: request.action, createdAt: new Date().toISOString(), sourceHashes }] });
  if (!previous) await writeFile(join(root, 'runtime-release.identity.json'), JSON.stringify({ version: 1, ownerKey }), { flag: 'wx', mode: 0o600 });
  await atomicJson(join(root, 'runtime-release.json'), result);
  return result;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceFileSchema = z.object({ path: z.string().min(1), sha256: digest }).strict();
const evidenceRecordSchema = z.object({ runId: z.uuid(), snapshotId: z.uuid(), runHash: digest, snapshotHash: digest,
  executionHash: digest, checkpointHash: digest, image: workerImageSchema, verifiedBy: z.string().trim().min(1).max(200),
  verifiedAt: z.iso.datetime(), reason: z.string().trim().min(20).max(8000), evidenceFiles: z.array(evidenceFileSchema).min(1).max(50) }).strict();
const legacyImageSchema = z.object({ image: workerImageSchema, sourceHashes: z.record(z.string(), digest), verifiedBy: z.string().trim().min(1).max(200),
  verifiedAt: z.iso.datetime(), reason: z.string().trim().min(20).max(8000), evidenceFiles: z.array(evidenceFileSchema).min(1).max(50) }).strict();
const evidenceSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), workspaceKey: z.uuid(),
  records: z.array(evidenceRecordSchema).max(10000), legacyImages: z.array(legacyImageSchema).max(1000).optional() }).strict();
type ReleaseEvidence = z.infer<typeof evidenceSchema>;
type PinnedRequest = { action: 'activate'; image: string; evidencePath?: string } | { action: 'rollback'; evidencePath?: string };
const assignmentSchema = z.object({ runId: z.uuid(), pin: workerReleasePinSchema,
  method: z.enum(['unstarted-assignment', 'operator-evidence']), evidence: evidenceRecordSchema.optional() }).strict();
const planSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), workspaceKey: z.uuid(), stateHash: digest,
  previousHash: digest, request: z.object({ action: z.enum(['activate', 'rollback']), image: z.string().optional() }).strict(),
  assignments: z.array(assignmentSchema), catalog: z.unknown(), legacyImages: z.array(legacyImageSchema), createdAt: z.iso.datetime() }).strict();
const journalSchema = z.object({ version: z.literal(1), planHash: digest, plan: planSchema, release: pinnedReleaseSchema }).strict();

function withoutPin(run: Run): object { const { runtimeRelease: _pin, ...rest } = run; return rest; }
function stateBinding(state: WorkspaceState): string { return stableRuntimeHash({ ...state, runs: state.runs.map(withoutPin) }); }
function unfinishedRun(state: WorkspaceState, run: Run): boolean {
  return !['succeeded', 'failed', 'cancelled'].includes(run.status)
    && !(run.status === 'superseded' && state.runs.some(child => child.id === run.continuedByRunId && validOperatorContinuation(state, child)?.id === run.id));
}
export function runtimeReleaseEvidenceBinding(state: WorkspaceState, runId: string) {
  const run = state.runs.find(item => item.id === runId), snapshot = state.snapshots.find(item => item.id === run?.snapshotId), execution = state.executionStates[runId];
  if (!run || !snapshot || !execution || snapshot.agentId !== run.agentId || snapshot.agentVersion !== run.agentVersion) throw new Error('Run/snapshot/frozen execution 귀속이 없어 이미지 증거를 만들 수 없습니다.');
  return { runId, snapshotId: snapshot.id, runHash: stableRuntimeHash(withoutPin(run)), snapshotHash: stableRuntimeHash(snapshot),
    executionHash: stableRuntimeHash(execution), checkpointHash: stableRuntimeHash(execution.checkpoint ?? null) };
}
function provablyUnstarted(state: WorkspaceState, run: Run): boolean {
  const saved = state.executionStates[run.id];
  return run.status === 'queued' && run.startedAt === null && (run.attempt ?? 0) === 0 && !run.completedAt
    && run.inputTokens === 0 && run.outputTokens === 0 && !run.result && !run.artifacts.length && !run.checkpointResults?.length
    && Boolean(saved) && !saved.checkpoint && !saved.previousResult && !saved.lastSessionId && !saved.resumeRequired && !saved.failedAttempts
    && saved.inputTokens === 0 && saved.outputTokens === 0 && !state.modelAttempts.some(item => item.runId === run.id);
}
async function verifyEvidenceFiles(files: Array<{ path: string; sha256: string }>): Promise<void> {
  for (const file of files) {
    const path = resolve(file.path), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error('이미지 증빙 파일의 형식 또는 크기가 올바르지 않습니다.');
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== file.sha256) throw new Error('이미지 증빙 파일 hash가 변경됐습니다.');
  }
}

export { inspectImageRuntimeBase as inspectRuntimeBase } from './image-fingerprint.ts';

async function ownedBoundary(root: string, ownerKey: string, config: RuntimeConfig, runner?: Command) {
  const selected = await activeStorage({ rootDir: root, ownerKey, backupDir: root });
  for (const key of new Set([ownerKey, selected.workspaceKey])) {
    if (await dockerForRelease(config, ['ps', '-aq', '--filter', `label=agent-company.workspace=${key}`, '--format', '{{.ID}}'], runner)) {
      throw new Error('소유 컨테이너 정리가 끝나지 않았습니다. 표준 종료·정리 후 전환해야 합니다.');
    }
  }
  const info = await lstat(join(selected.dataDir, 'db'));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('운영 DB 경로를 확인해야 합니다.');
  return selected;
}
async function inspectManifest(config: RuntimeConfig, ownerKey: string, image: string, sources: Record<string, string>, runner?: Command): Promise<WorkerReleaseManifest> {
  if (await resolveImage(config, image, runner) !== image) throw new Error('불변 이미지가 없거나 식별자가 변경됐습니다.');
  const hashes = await inspectWorkerSources(config, image, ownerKey, runner, sources);
  return createWorkerReleaseManifest({ image, sourceHashes: hashes, runtimeBaseHash: await inspectRuntimeBase(config, image, ownerKey, runner) });
}
async function validateCatalogImages(config: RuntimeConfig, ownerKey: string, catalog: WorkerReleaseCatalog, runner?: Command) {
  for (const manifest of catalog.manifests) {
    const actual = await inspectManifest(config, ownerKey, manifest.image, manifest.sourceHashes, runner);
    if (actual.id !== manifest.id) throw new Error('보존된 이미지 manifest와 실제 실행 기반이 다릅니다.');
  }
}
function explicitImageDependencies(state: WorkspaceState): string[] {
  const images = new Set<string>();
  for (const revision of state.environmentRevisions) if (revision.report?.imageId) images.add(revision.report.imageId);
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.fingerprint && typeof object.fingerprint === 'object') {
      const image = (object.fingerprint as Record<string, unknown>).image;
      if (typeof image === 'string') images.add(workerImageSchema.parse(image));
    }
    for (const child of Object.values(object)) if (child && typeof child === 'object') walk(child);
  };
  walk(state.executionStates);
  return [...images];
}
async function readEvidence(path: string | undefined, ownerKey: string, workspaceKey: string): Promise<ReleaseEvidence> {
  if (!path) return { version: 1, ownerKey, workspaceKey, records: [] };
  const raw = await optionalJson(resolve(path)); if (!raw) throw new Error('이미지 증빙 파일이 없습니다.');
  const evidence = evidenceSchema.parse(raw);
  if (evidence.ownerKey !== ownerKey || evidence.workspaceKey !== workspaceKey || new Set(evidence.records.map(item => item.runId)).size !== evidence.records.length
    || new Set(evidence.legacyImages?.map(item => item.image)).size !== (evidence.legacyImages?.length ?? 0)) throw new Error('이미지 증빙 소유권·세대 또는 Run/이미지 중복이 올바르지 않습니다.');
  for (const record of [...evidence.records, ...(evidence.legacyImages ?? [])]) record.evidenceFiles = record.evidenceFiles.map(file => ({ ...file, path: resolve(file.path) }));
  return evidence;
}

/** All mutation paths for v2 own the same controller lock; no exported unlocked selector exists. */
export async function transitionRuntimeRelease(root: string, ownerKey: string, config: RuntimeConfig, request: PinnedRequest, runner?: Command): Promise<RuntimeRelease> {
  const unlock = await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
  let store: WorkspaceStore | undefined;
  try {
    const selected = await ownedBoundary(root, ownerKey, config, runner);
    store = await WorkspaceStore.open(join(selected.dataDir, 'db'));
    const state = await store.read(); validateOperatorRequestState(state);
    if (!state.deploymentHold?.readyAt) throw new Error('배포 준비가 완료되지 않았습니다. 표준 서비스의 배포 준비 후 전환해야 합니다.');
    if (state.runs.some(run => run.cleanupPending || ['starting', 'running'].includes(run.status))) throw new Error('실행 정리 또는 정상 중단 상태 확인이 필요합니다.');
    const pendingPath = join(root, 'runtime-release.pending.json');
    const rawPending = await optionalJson(pendingPath);
    let previous: RuntimeRelease | null;
    // A first-install crash between writing the identity and release record is recoverable only through its exact journal.
    const rawRecord = await optionalJson(join(root, 'runtime-release.json'));
    const rawIdentity = await optionalJson(join(root, 'runtime-release.identity.json'));
    if (rawPending && !rawRecord && rawIdentity) {
      const anchor = z.object({ version: z.literal(1), ownerKey: z.uuid() }).strict().parse(rawIdentity);
      if (anchor.ownerKey !== ownerKey) throw new Error('이미지 이행 소유권이 다릅니다.');
      previous = null;
    } else previous = await readRuntimeRelease(root, ownerKey, config);
    const requestIdentity = request.action === 'activate' ? { action: request.action, image: request.image } : { action: request.action };
    let journal: z.infer<typeof journalSchema>;
    if (rawPending) {
      journal = journalSchema.parse(rawPending);
      if (journal.plan.ownerKey !== ownerKey || journal.plan.workspaceKey !== selected.workspaceKey || journal.planHash !== stableRuntimeHash(journal.plan)
        || journal.release.ownerKey !== ownerKey || stableRuntimeHash(journal.release.target) !== stableRuntimeHash(target(config))
        || journal.release.planHash !== journal.planHash || stableRuntimeHash(journal.plan.request) !== stableRuntimeHash(requestIdentity)) throw new Error('중단된 이미지 이행 계획 또는 요청이 일치하지 않습니다.');
      if (stableRuntimeHash(previous) !== journal.plan.previousHash && stableRuntimeHash(previous) !== stableRuntimeHash(journal.release)) throw new Error('중단 이후 운영 이미지 기록이 변경됐습니다.');
    } else {
      if (request.action === 'rollback' && !previous) throw new Error('복귀할 운영 이미지 이력이 없습니다.');
      const evidence = await readEvidence(request.evidencePath, ownerKey, selected.workspaceKey);
      const before = previous?.activeImage ?? await resolveImage(config, config.image, runner);
      const image = await resolveImage(config, request.action === 'activate' ? request.image : previous!.previousImage, runner);
      const known = previous?.version === 2 ? validateWorkerReleaseCatalog(previous.catalog).manifests : [];
      const candidates = new Map(known.map(manifest => [manifest.image, manifest]));
      const required = new Set([before, image, ...explicitImageDependencies(state), ...state.runs.flatMap(run => run.runtimeRelease ? [run.runtimeRelease.image] : [])]);
      for (const record of evidence.records) required.add(record.image);
      for (const id of required) {
        if (candidates.has(id)) continue;
        let sources: Record<string, string> | undefined;
        if (request.action === 'activate' && id === image) sources = await inspectWorkerSources(config, id, ownerKey, runner);
        else sources = previous?.history.toReversed().find(item => item.image === id && workerSourceFiles.every(name => item.sourceHashes[name]))?.sourceHashes;
        if (!sources) {
          const legacy = evidence.legacyImages?.find(item => item.image === id);
          if (legacy) { await verifyEvidenceFiles(legacy.evidenceFiles); sources = legacy.sourceHashes; }
        }
        // With no prior execution at all, current source equality establishes the initial release, not historical Run attribution.
        if (!sources && !state.runs.length) sources = await inspectWorkerSources(config, id, ownerKey, runner);
        if (!sources) throw new Error(`구형 이미지 source manifest 증거가 없습니다: ${id}`);
        candidates.set(id, await inspectManifest(config, ownerKey, id, sources, runner));
      }
      const active = candidates.get(image)!;
      const catalog = validateWorkerReleaseCatalog({ version: 1, active: { image, manifestId: active.id }, manifests: [...candidates.values()] });
      const assignments: z.infer<typeof assignmentSchema>[] = [];
      for (const run of state.runs) {
        if (run.runtimeRelease) { requireWorkerRelease(catalog, run.runtimeRelease); continue; }
        if (!unfinishedRun(state, run)) continue;
        let assignedImage: string, method: 'unstarted-assignment' | 'operator-evidence', record;
        runtimeReleaseEvidenceBinding(state, run.id);
        if (provablyUnstarted(state, run)) { assignedImage = before; method = 'unstarted-assignment'; }
        else {
          record = evidence.records.find(item => item.runId === run.id);
          if (!record) throw new Error(`시작된 Run의 검증된 이미지 증빙이 없습니다: ${run.id}`);
          const binding = runtimeReleaseEvidenceBinding(state, run.id);
          if (Object.entries(binding).some(([key, value]) => record![key as keyof typeof binding] !== value)) throw new Error('이미지 증빙의 Run/snapshot/checkpoint/frozen input이 현재 상태와 다릅니다.');
          await verifyEvidenceFiles(record.evidenceFiles);
          assignedImage = record.image; method = 'operator-evidence';
        }
        const manifest = candidates.get(assignedImage); if (!manifest) throw new Error('Run 이미지 manifest가 없습니다.');
        assignments.push({ runId: run.id, pin: { image: assignedImage, manifestId: manifest.id }, method, ...(record ? { evidence: record } : {}) });
      }
      if (previous?.version === 2 && previous.activeImage === image && !assignments.length && stableRuntimeHash(previous.catalog) === stableRuntimeHash(catalog)) {
        await validateCatalogImages(config, ownerKey, catalog, runner);
        return previous;
      }
      const plan = planSchema.parse({ version: 1, ownerKey, workspaceKey: selected.workspaceKey, stateHash: stateBinding(state), previousHash: stableRuntimeHash(previous),
        request: requestIdentity, assignments, catalog, legacyImages: evidence.legacyImages ?? [], createdAt: new Date().toISOString() });
      const planHash = stableRuntimeHash(plan);
      const release = pinnedReleaseSchema.parse({ version: 2, ownerKey, target: target(config), activeImage: image, previousImage: before, catalog, planHash,
        history: [...(previous?.history ?? []), { image, previousImage: before, action: request.action, createdAt: plan.createdAt, sourceHashes: active.sourceHashes }] });
      journal = { version: 1, planHash, plan, release };
      await atomicJson(pendingPath, journal);
    }
    const catalog = validateWorkerReleaseCatalog(journal.plan.catalog);
    if (stableRuntimeHash(catalog) !== stableRuntimeHash(validateWorkerReleaseCatalog(journal.release.catalog)) || journal.release.activeImage !== catalog.active.image) throw new Error('이행 계획과 대상 catalog가 다릅니다.');
    await validateCatalogImages(config, ownerKey, catalog, runner);
    for (const legacy of journal.plan.legacyImages) await verifyEvidenceFiles(legacy.evidenceFiles);
    for (const assignment of journal.plan.assignments) if (assignment.evidence) await verifyEvidenceFiles(assignment.evidence.evidenceFiles);
    const apply = (current: WorkspaceState) => {
      if (stateBinding(current) !== journal.plan.stateHash) throw new Error('이미지 이행 계획 이후 Run 또는 작업실 내용이 변경됐습니다.');
      for (const assignment of journal.plan.assignments) {
        const run = current.runs.find(item => item.id === assignment.runId); if (!run) throw new Error('이행할 Run이 없습니다.');
        requireWorkerRelease(catalog, assignment.pin);
        if (run.runtimeRelease && stableRuntimeHash(run.runtimeRelease) !== stableRuntimeHash(assignment.pin)) throw new Error('Run 이미지 pin이 이행 계획과 충돌합니다.');
        run.runtimeRelease = structuredClone(assignment.pin);
      }
      for (const run of current.runs) {
        if (unfinishedRun(current, run) && !run.runtimeRelease) throw new Error('미완료 Run에 알 수 없는 이미지 pin이 남아 있습니다.');
        if (run.runtimeRelease) requireWorkerRelease(catalog, run.runtimeRelease);
      }
    };
    await store.change(apply);
    await ownedBoundary(root, ownerKey, config, runner);
    if (!await optionalJson(join(root, 'runtime-release.identity.json'))) await writeFile(join(root, 'runtime-release.identity.json'), JSON.stringify({ version: 1, ownerKey }), { flag: 'wx', mode: 0o600 });
    await atomicJson(join(root, 'runtime-release.json'), journal.release);
    await atomicJson(join(root, `runtime-release-plan-${journal.planHash}.json`), journal);
    await unlink(pendingPath);
    return journal.release;
  } finally { try { await store?.close(); } finally { await unlock(); } }
}

export async function createRuntimeReleaseEvidenceTemplate(root: string, ownerKey: string, config: RuntimeConfig, runner?: Command): Promise<unknown> {
  const unlock = await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
  let store: WorkspaceStore | undefined;
  try {
    const selected = await ownedBoundary(root, ownerKey, config, runner);
    store = await WorkspaceStore.open(join(selected.dataDir, 'db'));
    const state = await store.read();
    return { version: 1, ownerKey, workspaceKey: selected.workspaceKey, records: state.runs.filter(run => unfinishedRun(state, run) && !run.runtimeRelease && !provablyUnstarted(state, run))
      .map(run => ({ ...runtimeReleaseEvidenceBinding(state, run.id), image: '', verifiedBy: '', verifiedAt: '', reason: '', evidenceFiles: [] })), legacyImages: [] };
  } finally { try { await store?.close(); } finally { await unlock(); } }
}
