import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionInput, ExecutionHooks, ExecutionResult, ExecutionCheckpoint, RuntimeDriver, RuntimeInfo, Skill, Run } from '../shared/types.ts';
import { requireWorkerRelease, selectWorkerReleaseCatalog, validateWorkerReleaseCatalogSet, validateHistoricalWorkerAuthBindings,
  legacyWorkerEntrySha256, type HistoricalWorkerAuthBinding, type WorkerReleaseCatalog, type WorkerReleasePin } from '../shared/runtime-releases.ts';
import { growthTaskPrompt, growthReplayProposalSchema, type ComparisonEvidence, type GrowthReplayProposal } from '../shared/growth.ts';
import { resolveGrowthReplay } from './growth-replay.ts';
import { objectiveAssessmentSchema } from '../shared/objectives.ts';
import { command, type Command } from './process.ts';
import type { RuntimeAuthBinding, RuntimeAuthBindingLease } from './runtime-auth-binding.ts';
import { DockerWorkspaces, type WorkspaceFileInput } from './workspaces.ts';
import { isBudgetPause, unknownUsage, type ModelAttempt, type ModelPhase } from '../shared/telemetry.ts';
import { environmentProposalSchema, environmentSpecSchema, type EnvironmentToolCall } from '../shared/environment.ts';
import { DockerEnvironments, environmentResources } from './environment-runtime.ts';
import { DockerBrowser, browserResources, type BrowserRuntimeConfig } from './browser-runtime.ts';
import { learningInput, validateLearning } from './learning.ts';
import { learningReviewSchema } from '../shared/learning.ts';

const text = z.string().max(100_000);
const candidate = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(2000), content: text.min(1), replay: growthReplayProposalSchema.nullable().optional() });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const skillContent = (skill: Pick<Skill, 'name' | 'description' | 'content'> | null) => skill ? { name: skill.name, description: skill.description, content: skill.content } : null;
const qualityOutput = (task: { result: string; artifacts: ExecutionResult['artifacts'] }) => ({ result: task.result, artifacts: task.artifacts.map(({ name, content, mediaType }) => ({ name, content, mediaType })) });
const paused = (error: unknown) => isBudgetPause(error) || Boolean(error && typeof error === 'object'
  && ('statusCode' in error && error.statusCode === 507 || 'code' in error && ['RUN_PAUSED', 'DEPLOYMENT_PAUSED'].includes(String(error.code))));
class WorkerInterruptedError extends Error {
  readonly code = 'WORKER_INTERRUPTED';
}
class RuntimeCleanupPendingError extends Error {
  readonly code = 'RUNTIME_CLEANUP_PENDING';
}
const comparisonSchema = z.object({ verdict: z.enum(['improved', 'equivalent', 'regressed', 'inconclusive']), reason: z.string().max(20_000),
  replayApplicable: z.boolean().nullable().optional(),
  evidence: z.array(z.string().max(4000)).max(30), usefulChanges: z.array(z.string().max(4000)).max(30), failures: z.array(z.string().max(4000)).max(30),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() });
export const taskResultSchema = z.object({
  result: text.min(1),
  learningProtocol: z.literal(1).optional(),
  learningReview: learningReviewSchema.optional(),
  route: z.enum(['task', 'discuss']).optional(),
  memories: z.array(z.object({ kind: z.enum(['fact', 'preference', 'procedure']), title: z.string().trim().min(1).max(200), content: z.string().min(1).max(50_000) })).max(30),
  skills: z.array(candidate).max(10),
  artifacts: z.array(z.object({ name: z.string().min(1).max(200), content: text, mediaType: z.string().min(1).max(100) })).max(25),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  skillConcerns: z.array(z.object({ skillId: z.string().min(1).max(100), reason: z.string().max(4000), evidence: z.string().max(4000), replay: growthReplayProposalSchema.nullable().optional() })).max(30).optional(),
  environmentProposal: environmentProposalSchema.nullable().optional(),
  objectiveAssessment: objectiveAssessmentSchema.nullable().optional(),
});
interface ComparisonProgress {
  fingerprint: ComparisonEvidence['fingerprint'];
  trials: Array<{ result: ReturnType<typeof qualityOutput>; attempt: ModelAttempt; inputTokens: number; outputTokens: number }>;
  completed?: { evidence: ComparisonEvidence; inputTokens: number; outputTokens: number };
}
export interface RuntimeConfig {
  releaseCatalog?: WorkerReleaseCatalog;
  /** Trusted imported history; never changes the active provider/default pin. */
  historicalReleaseCatalogs?: WorkerReleaseCatalog[];
  historicalAuthBindings?: HistoricalWorkerAuthBinding[];
  browserImage?: string;
  mode: 'docker' | 'kubernetes'; image: string; model: string;
  auth: 'none' | 'codex' | 'api-key' | 'desktop-codex'; authFile: string; apiKey?: string;
  namespace?: string; context?: string; authSecret?: string;
  workspaceKey?: string;
  wslDistro?: string;
  persistentWorkspaces?: boolean;
  dockerSandbox?: 'default' | 'codex-userns';
  /** Resolved on the Docker CLI host; never mounted inside a worker. */
  seccompProfile?: string;
  timeoutMs: number;
}
export class RuntimeReleaseBlockedError extends Error {
  readonly code = 'RUNTIME_RELEASE_BLOCKED';
}
function pinnedConfig(config: RuntimeConfig, run?: Pick<Run, 'runtimeRelease'>): RuntimeConfig {
  const catalog = config.releaseCatalog;
  if (!catalog) {
    if (run?.runtimeRelease || config.historicalReleaseCatalogs?.length) throw new RuntimeReleaseBlockedError('실행 이미지 pin에 대응하는 catalog가 없습니다. 기본 이미지로 대체하지 않습니다.');
    return config;
  }
  try {
    if (!run?.runtimeRelease) throw new Error('실행의 고정 worker 이미지 증거가 없습니다.');
    const selected = selectWorkerReleaseCatalog(catalog, config.historicalReleaseCatalogs, run.runtimeRelease);
    const manifest = requireWorkerRelease(selected, run.runtimeRelease);
    // Nested helpers only need this homogeneous catalog. The runtime's original
    // registry/default remains unchanged and selects every Run independently.
    return { ...config, image: manifest.image, releaseCatalog: selected,
      historicalReleaseCatalogs: undefined };
  } catch (error) { throw new RuntimeReleaseBlockedError(error instanceof Error ? error.message : '실행 이미지 증거가 유효하지 않습니다.'); }
}
function assertEnvironmentRelease(config: RuntimeConfig, input: ExecutionInput): void {
  if (input.environment && config.releaseCatalog && !config.releaseCatalog.manifests.some(item => item.image === input.environment!.report.imageId)) {
    throw new RuntimeReleaseBlockedError('개인 환경과 Run의 실행 기반이 다릅니다. 기존 환경과 Run pin을 바꾸지 않고 호환 환경 준비를 기다립니다.');
  }
}
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = env.AGENT_RUNTIME ?? 'docker';
  const auth = env.AGENT_AUTH ?? 'none';
  const dockerSandbox = env.AGENT_DOCKER_SANDBOX ?? 'default';
  if (!['default', 'codex-userns'].includes(dockerSandbox)) throw new Error('AGENT_DOCKER_SANDBOX은 default 또는 codex-userns입니다.');
  if (mode !== 'docker' && dockerSandbox !== 'default') throw new Error('codex-userns 프로필은 검증된 Docker 실행 대상에만 적용합니다.');
  if (mode !== 'docker' && mode !== 'kubernetes') throw new Error('AGENT_RUNTIME은 docker 또는 kubernetes입니다.');
  if (!['none', 'codex', 'api-key'].includes(auth)) throw new Error('AGENT_AUTH 설정을 확인하십시오.');
  const timeoutMs = Number(env.AGENT_TIMEOUT_SECONDS ?? '900') * 1000;
  const wslDistro = env.AGENT_DOCKER_WSL_DISTRO?.trim();
  const browserImage = env.AGENT_BROWSER_IMAGE || undefined;
  if (browserImage && (mode !== 'docker' || !/^sha256:[a-f0-9]{64}$/.test(browserImage))) throw new Error('브라우저는 Docker의 검증된 불변 이미지 ID로만 활성화합니다.');
  if (wslDistro && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(wslDistro)) throw new Error('WSL 배포 이름이 올바르지 않습니다.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) throw new Error('AGENT_TIMEOUT_SECONDS 허용 범위는 10~3600입니다.');
  return {
    browserImage,
    mode, auth: auth as RuntimeConfig['auth'], image: env.AGENT_IMAGE ?? 'agent-company-worker:0.1.0',
    model: env.AGENT_MODEL ?? 'gpt-6-astra',
    authFile: env.AGENT_CODEX_AUTH_FILE ?? join(homedir(), '.codex', 'auth.json'),
    apiKey: env.OPENAI_API_KEY, namespace: env.AGENT_K8S_NAMESPACE,
    context: env.AGENT_K8S_CONTEXT, authSecret: env.AGENT_K8S_AUTH_SECRET, timeoutMs,
    wslDistro, persistentWorkspaces: env.AGENT_PERSIST_WORKSPACES !== 'false', dockerSandbox: dockerSandbox as RuntimeConfig['dockerSandbox'],
  };
}
function resourceName(runId: string, phase: string) {
  if (!/^[a-zA-Z0-9-]{1,60}$/.test(runId)) throw new Error('잘못된 실행 ID입니다.');
  return `ac-${runId.toLowerCase()}-${phase}`.slice(0, 63).replace(/-$/, '');
}
export function workspaceVolume(config: RuntimeConfig, runId: string): string {
  if (!config.workspaceKey) throw new Error('영속 작업공간에는 워크스페이스 식별자가 필요합니다.');
  return `ac-${createHash('sha256').update(config.workspaceKey).digest('hex').slice(0, 16)}-${createHash('sha256').update(runId).digest('hex').slice(0, 24)}`;
}
export interface DesktopRuntimeOptions {
  authentication: RuntimeAuthBinding;
  mapHostPath: (file: string) => Promise<string>;
  securityProfiles?: { worker: string; browser: string };
}
type AuthMount = Pick<RuntimeAuthBindingLease, 'source' | 'ownerKey'>;
function workerAuthentication(config: RuntimeConfig): 'codex-file-v1' | 'codex-secret-directory-v1' {
  const manifest = config.releaseCatalog?.manifests.find(item => item.image === config.image);
  const binding = config.historicalAuthBindings?.find(item => item.pin.image === config.image);
  if (binding) {
    if (!manifest || manifest.id !== binding.pin.manifestId || manifest.sourceHashes['entry.mjs'] !== binding.entrySha256
      || !legacyWorkerEntrySha256.some(hash => hash === binding.entrySha256)
      || binding.contract !== 'codex-secret-directory-v1') throw new RuntimeReleaseBlockedError('역사별 인증 어댑터의 정확한 이미지·entry 증거가 없습니다.');
    return binding.contract;
  }
  if (manifest && legacyWorkerEntrySha256.some(hash => hash === manifest.sourceHashes['entry.mjs'])) throw new RuntimeReleaseBlockedError('구형 entry에는 검증된 역사별 인증 어댑터가 필요합니다.');
  return 'codex-file-v1';
}
function desktopAuthArguments(config: RuntimeConfig, binding?: AuthMount): string[] {
  if (config.auth !== 'desktop-codex') {
    if (binding) throw new Error('설치형 인증 마운트는 설치형 실행기에서만 사용할 수 있습니다.');
    return [];
  }
  if (config.mode !== 'docker' || !binding || !/^\/[\s\S]+\/auth\.json$/.test(binding.source)
    || /[\x00-\x1f\x7f\\]/.test(binding.source) || binding.source.split('/').some(part => part === '.' || part === '..')
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.ownerKey)) {
    throw new Error('설치형 인증 파일의 실행 대상이 올바르지 않습니다.');
  }
  // Docker --mount is CSV, including when a Windows directory contains a comma.
  const source = `source=${binding.source}`;
  const field = /[,\"]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
  if (workerAuthentication(config) === 'codex-secret-directory-v1') {
    // The legacy entry copies this one read-only file into its private tmpfs
    // home. Refreshes in that home are not written back to the app account.
    return ['--label', `agent-company.credential-owner=${binding.ownerKey}`, '--log-driver=none',
      '--mount', `type=bind,${field},target=/run/agent-credentials/auth.json,readonly`, '--env=AGENT_SECRET_DIR=/run/agent-credentials'];
  }
  return ['--label', `agent-company.credential-owner=${binding.ownerKey}`, '--log-driver=none',
    '--mount', `type=bind,${field},target=/home/node/.codex/auth.json`];
}
export function dockerArguments(config: RuntimeConfig, name: string, input?: ExecutionInput, persistent = false, binding?: AuthMount): string[] {
  config = pinnedConfig(config, input?.run);
  const authentication = desktopAuthArguments(config, binding);
  if (config.dockerSandbox === 'codex-userns' && (!config.seccompProfile || config.seccompProfile === 'unconfined')) throw new Error('검증된 seccomp 프로필 경로가 필요합니다.');
  const selected = input?.environment;
  if (selected && (!config.persistentWorkspaces || !config.workspaceKey || !/^[a-zA-Z0-9-]{1,60}$/.test(selected.buildRunId))) throw new Error('개인 환경 마운트에는 소유된 영속 볼륨이 필요합니다.');
  if (selected) environmentSpecSchema.parse(selected.spec);
  if (input) assertEnvironmentRelease(config, input);
  const browserAllocation = input?.collaboration?.tools.some(tool => tool.name === 'browser_open')
    ? browserResources(input.resources ?? { memoryMiB: 2048, cpus: 2 }).worker : input?.resources;
  const allocation = selected?.spec.servers.length ? environmentResources(browserAllocation).worker : browserAllocation;
  const memory = allocation?.memoryMiB;
  const cpus = allocation?.cpus ?? 2;
  if ((memory !== undefined && (!Number.isSafeInteger(memory) || memory < 64)) || !Number.isFinite(cpus) || cpus <= 0) throw new Error('실행 자원 할당이 올바르지 않습니다.');
  return ['run', '--rm', '-i', '--name', name, '--label', 'app=agent-company',
    '--label', `agent-company.workspace=${config.workspaceKey ?? 'test'}`,
    ...(input?.run ? ['--label', `agent-company.run=${input.run.id}`] : []),
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    ...(config.dockerSandbox === 'codex-userns' ? [`--security-opt=seccomp=${config.seccompProfile}`] : []),
    '--user=1000:1000', '--pids-limit=256', memory ? `--memory=${memory}m` : '--memory=2g', `--cpus=${cpus}`,
    ...(persistent && input ? ['--mount', `type=volume,source=${workspaceVolume(config, input.run.id)},target=/workspace`] : ['--tmpfs=/workspace:rw,nosuid,nodev,size=512m,uid=1000,gid=1000']),
    ...(selected ? ['--mount', `type=volume,source=${workspaceVolume(config, selected.buildRunId)},target=/opt/agent-environment,readonly,volume-nocopy`] : []),
    '--tmpfs=/home/node/.codex:rw,noexec,nosuid,nodev,size=128m,uid=1000,gid=1000',
    ...authentication,
    '--tmpfs=/tmp:rw,nosuid,nodev,size=128m', '--network=bridge',
    '--env=HOME=/home/node', '--env=CODEX_HOME=/home/node/.codex', config.image];
}
export function kubernetesResources(config: RuntimeConfig, name: string, payload: unknown) {
  if (config.auth === 'desktop-codex') throw new Error('설치형 인증은 지정된 로컬 Docker 실행기에서만 사용할 수 있습니다.');
  config = pinnedConfig(config, (payload as { input?: ExecutionInput })?.input?.run);
  if (!config.namespace || !config.context || !config.authSecret) throw new Error('Kubernetes context·namespace·인증 Secret을 명시해야 합니다.');
  const serialized = JSON.stringify(payload);
  if (typeof serialized !== 'string') throw new Error('Kubernetes 실행 입력이 올바르지 않습니다.');
  if (Buffer.byteLength(serialized, 'utf8') > 960 * 1024) {
    throw new Error('Kubernetes 실행 입력이 960 KiB 제한을 초과했습니다. 현재 ConfigMap 전송 경로에서는 이 크기의 기억·결과를 전달할 수 없습니다.');
  }
  const labels = { app: 'agent-company', 'agent-company-run': name, 'agent-company.workspace': config.workspaceKey ?? 'test' };
  const allocation = (payload as { input?: ExecutionInput })?.input?.resources;
  if (allocation) dockerArguments(config, name, { ...(payload as { input: ExecutionInput }).input, resources: allocation });
  return { apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: config.namespace, labels }, data: { 'input.json': serialized } },
    { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: config.namespace, labels }, spec: {
      backoffLimit: 0, activeDeadlineSeconds: Math.ceil(config.timeoutMs / 1000), ttlSecondsAfterFinished: 3600,
      template: { metadata: { labels }, spec: {
        restartPolicy: 'Never', automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'worker', image: config.image, imagePullPolicy: 'IfNotPresent',
          args: ['/input/input.json'],
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          resources: allocation ? { requests: { cpu: String(allocation.cpus), memory: `${allocation.memoryMiB}Mi` }, limits: { cpu: String(allocation.cpus), memory: `${allocation.memoryMiB}Mi` } }
            : { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '2', memory: '2Gi' } },
          env: [{ name: 'HOME', value: '/home/node' }, { name: 'CODEX_HOME', value: '/home/node/.codex' }, { name: 'AGENT_SECRET_DIR', value: '/credentials' }],
          volumeMounts: [
            { name: 'input', mountPath: '/input', readOnly: true }, { name: 'credentials', mountPath: '/credentials', readOnly: true },
            { name: 'workspace', mountPath: '/workspace' }, { name: 'codex', mountPath: '/home/node/.codex' }, { name: 'tmp', mountPath: '/tmp' },
          ],
        }],
        volumes: [
          { name: 'input', configMap: { name } }, { name: 'credentials', secret: { secretName: config.authSecret, defaultMode: 288 } },
          ...['workspace', 'codex', 'tmp'].map(volume => ({ name: volume, emptyDir: { sizeLimit: volume === 'workspace' ? '512Mi' : '128Mi' } })),
        ],
      } },
    } },
  ] };
}

export class ContainerRuntime implements RuntimeDriver {
  readonly config: RuntimeConfig;
  get defaultReleasePin(): WorkerReleasePin | undefined { return this.config.releaseCatalog ? structuredClone(this.config.releaseCatalog.active) : undefined; }
  selectReleasePinForEnvironment(imageId?: string): WorkerReleasePin | undefined {
    if (imageId === undefined) return this.defaultReleasePin;
    if (!this.config.releaseCatalog) return undefined;
    try {
      const catalogs = validateWorkerReleaseCatalogSet(this.config.releaseCatalog, this.config.historicalReleaseCatalogs ?? []);
      const manifest = [catalogs.active, ...catalogs.historical].flatMap(item => item.manifests).find(item => item.image === imageId);
      if (!manifest) throw new Error('검증된 개인 환경의 구축 이미지가 현재 또는 역사별 catalog에 없습니다.');
      return { image: manifest.image, manifestId: manifest.id };
    } catch (error) { throw new RuntimeReleaseBlockedError(error instanceof Error ? error.message : '개인 환경 실행 이미지 증거가 유효하지 않습니다.'); }
  }
  get browserEnabled(): boolean { return this.config.mode === 'docker' && Boolean(this.config.browserImage); }
  get browserAvailable(): boolean { return this.browser.available; }
  get workspacePersistence(): boolean { return this.config.mode === 'docker' && Boolean(this.config.persistentWorkspaces && this.config.workspaceKey); }
  private readonly runCommand: Command;
  private readonly environments: DockerEnvironments;
  private readonly browser: DockerBrowser;
  private readonly environmentRuns = new Map<string, { input: ExecutionInput; signal: AbortSignal }>();
  private readonly executingRuns = new Set<string>();
  private browserCalls = 0;
  private workspaceOperations = 0;
  private settlementOperations = 0;
  private deploymentActivityRevision = 0;
  constructor(config = runtimeConfig(), private readonly runner: Command = command, private readonly desktop?: DesktopRuntimeOptions) {
    if (config.auth === 'desktop-codex') {
      if (!desktop || config.mode !== 'docker' || config.wslDistro || !config.workspaceKey
        || !/^sha256:[a-f0-9]{64}$/.test(config.image) || config.authFile || config.apiKey || config.authSecret) {
        throw new Error('설치형 실행에는 명시된 로컬 대상·인증 연결·불변 이미지가 필요합니다.');
      }
    } else if (desktop) throw new Error('설치형 인증 연결과 실행 모드가 일치하지 않습니다.');
    if (!config.releaseCatalog && config.historicalReleaseCatalogs?.length) throw new RuntimeReleaseBlockedError('역사별 실행 이미지에는 현재 catalog가 필요합니다.');
    const catalogs = config.releaseCatalog ? validateWorkerReleaseCatalogSet(config.releaseCatalog, config.historicalReleaseCatalogs ?? []) : undefined;
    if (config.historicalAuthBindings?.length && (!catalogs || config.auth !== 'desktop-codex')) throw new RuntimeReleaseBlockedError('역사별 인증 어댑터에는 설치형 인증과 검증된 catalog가 필요합니다.');
    const historicalAuthBindings = catalogs ? validateHistoricalWorkerAuthBindings(catalogs.active, catalogs.historical, config.historicalAuthBindings ?? []) : undefined;
    this.config = { ...config, ...(catalogs ? { releaseCatalog: catalogs.active, historicalReleaseCatalogs: catalogs.historical,
      historicalAuthBindings, image: catalogs.active.active.image } : {}) };
    // An explicit execution target, not a missing-command fallback or shell wrapper.
    this.runCommand = (file, args, options) => file === 'docker' && config.wslDistro
      ? runner('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'docker', ...args], options)
      : runner(file, args, options);
    this.environments = new DockerEnvironments(this.config, this.runCommand, input => input ? this.workspacesFor(input.run) : this.workspaces, runId => workspaceVolume(this.config, runId), async name => {
      if (await this.removeWorker(name)) { this.pendingCleanup.delete(name); return true; }
      this.pendingCleanup.add(name); return false;
    }, input => this.configForRun(input.run));
    this.browser = new DockerBrowser(this.runCommand, () => this.dockerBrowserConfig());
  }
  async callBrowser(input: ExecutionInput, request: import('../shared/browser.ts').BrowserRequest, signal: AbortSignal) {
    this.configForRun(input.run);
    if (!this.browserEnabled || !input.collaboration?.tools.some(tool => tool.name === 'browser_open')) throw new Error('이 실행에는 브라우저 기능이 활성화되지 않았습니다.');
    this.browserCalls++;
    this.deploymentActivityRevision++;
    try { return await this.browser.call(input, request, signal); }
    finally { this.browserCalls--; }
  }
  private configForRun(run: Pick<Run, 'runtimeRelease'>): RuntimeConfig {
    return pinnedConfig(this.config, run);
  }
  async validateRunRelease(run: Run): Promise<void> {
    const config = this.configForRun(run);
    if (!config.releaseCatalog || config.mode !== 'docker') return;
    let result;
    try { result = await this.runCommand('docker', ['image', 'inspect', config.image, '--format', '{{.Id}}'], { timeoutMs: 30_000 }); }
    catch (error) { throw new RuntimeReleaseBlockedError(`고정 실행 이미지를 확인하지 못했습니다: ${config.image}. ${error instanceof Error ? error.message : ''}`); }
    if (result.code !== 0 || result.stdout.trim() !== config.image) throw new RuntimeReleaseBlockedError(`고정 실행 이미지 ${config.image}이 없거나 식별자가 다릅니다. 다른 이미지로 대체하지 않습니다.`);
  }
  private deploymentBlockers(includePendingCleanup = true) {
    return [
      { code: 'executing_runs', label: '실행 중 작업', count: this.executingRuns.size },
      { code: 'environment_runs', label: '개인 환경 실행', count: this.environmentRuns.size },
      { code: 'environment_busy', label: '개인 환경 helper 사용 또는 정리 확인', count: Number(this.environments.busy) },
      { code: 'browser_calls', label: '브라우저 호출', count: this.browserCalls },
      { code: 'browser_session', label: '브라우저 세션 종료 확인', count: Number(!this.browser.available) },
      { code: 'workspace_operations', label: '작업공간 작업', count: this.workspaceOperations },
      { code: 'settlement_operations', label: '실행 종료 정리', count: this.settlementOperations },
      { code: 'pending_cleanup', label: '컨테이너 종료 재확인', count: includePendingCleanup ? this.pendingCleanup.size : 0 },
      { code: 'pending_trial_copies', label: '임시 비교 작업공간 정리', count: this.pendingTrialCopies.size },
      { code: 'cleanup_retry', label: '정리 재시도', count: Number(Boolean(this.cleanupRetry)) },
      { code: 'recovery', label: '시작 복구', count: Number(Boolean(this.recovery)) },
    ].filter(item => item.count > 0);
  }
  private assertDeploymentInactive() {
    const blockers = this.deploymentBlockers(false);
    if (blockers.length) throw Object.assign(new Error(`배포 전환에 필요한 실행·정리가 남아 있습니다: ${this.deploymentBlockers().map(item => `${item.label} ${item.count}건 [${item.code}]`).join(', ')}.`),
      { code: 'DEPLOYMENT_RUNTIME_BUSY', blockers: this.deploymentBlockers() });
  }
  /** Read-only Docker drain gate; only proven-absent cleanup bookkeeping is reconciled. */
  async confirmDeploymentIdle(): Promise<void> {
    this.assertDeploymentInactive();
    const revision = this.deploymentActivityRevision, pending = [...this.pendingCleanup];
    const unchanged = () => {
      this.assertDeploymentInactive();
      if (revision !== this.deploymentActivityRevision || pending.length !== this.pendingCleanup.size || pending.some(name => !this.pendingCleanup.has(name))) {
        throw Object.assign(new Error('확인 중 실행 또는 정리 상태가 변경됐습니다. 배포 경계를 다시 검사합니다. [activity_changed]'), { code: 'DEPLOYMENT_ACTIVITY_CHANGED' });
      }
    };
    const c = this.config;
    if (!c.workspaceKey) throw new Error('배포 경계 확인에는 작업공간 소유권 식별자가 필요합니다.');
    if (c.mode !== 'docker') throw new Error('현재 배포 경계 확인은 Docker 실행 대상에서만 지원합니다.');
    let result;
    try { result = await this.runCommand('docker', ['ps', '-aq', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${c.workspaceKey}`], { timeoutMs: 30_000 }); }
    catch { throw new Error('현재 소유 컨테이너 상태를 확인하지 못했습니다. 배포 준비로 표시하지 않습니다. [workspace_inspection_failed]'); }
    unchanged();
    if (result.code !== 0 || result.stderr.trim()) throw new Error('현재 소유 컨테이너 상태를 확인하지 못했습니다. 배포 준비로 표시하지 않습니다. [workspace_inspection_failed]');
    if (result.stdout.trim()) throw new Error(`현재 소유 컨테이너가 남아 있습니다: ${result.stdout.trim().split(/\s+/).length}건 [workspace_containers]. 종료 확인 후 배포 경계를 다시 검사합니다.`);
    for (const name of pending) {
      // Names originate only from this runtime's cleanup callbacks. Search all
      // containers, including stopped ones and names whose labels have changed.
      if (!/^ac-[a-z0-9-]{1,60}$/.test(name)) throw new Error(`컨테이너 종료 기록 ${pending.length}건의 이름을 확인하지 못했습니다. [cleanup_name_invalid]`);
      let inspected;
      try { inspected = await this.runCommand('docker', ['ps', '-aq', '--filter', `name=^/${name}$`], { timeoutMs: 30_000 }); }
      catch { throw new Error(`컨테이너 종료 기록 ${pending.length}건의 부재를 확인하지 못했습니다. [cleanup_inspection_failed]`); }
      unchanged();
      if (inspected.code !== 0 || inspected.stderr.trim()) throw new Error(`컨테이너 종료 기록 ${pending.length}건의 부재를 확인하지 못했습니다. [cleanup_inspection_failed]`);
      if (inspected.stdout.trim()) throw new Error(`종료 재확인 대상 컨테이너가 남아 있습니다: ${pending.length}건 중 ${name} [pending_cleanup].`);
    }
    await this.desktop?.authentication.assertIdle();
    unchanged();
    for (const name of pending) this.pendingCleanup.delete(name);
  }
  private inspection?: { expiresAt: number; value: Promise<RuntimeInfo> };
  private recovered = false;
  private recovery?: Promise<void>;
  private readonly pendingCleanup = new Set<string>();
  private readonly pendingTrialCopies = new Map<string, { parentRunId: string; release?: () => void }>();
  private cleanupRetry?: Promise<void>;
  private workerConfig?: Promise<RuntimeConfig>;
  private browserConfig?: Promise<BrowserRuntimeConfig>;
  private get workspaces(): DockerWorkspaces {
    return new DockerWorkspaces(this.config, this.runCommand, runId => workspaceVolume(this.config, runId),
      name => { this.pendingCleanup.add(name); });
  }
  private workspacesFor(run: Pick<Run, 'runtimeRelease'>): DockerWorkspaces {
    const config = this.configForRun(run);
    return new DockerWorkspaces(config, this.runCommand, runId => workspaceVolume(config, runId), name => { this.pendingCleanup.add(name); });
  }
  private async workspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.workspaceOperations++;
    this.deploymentActivityRevision++;
    try { return await operation(); } finally { this.workspaceOperations--; }
  }

  async listWorkspace(runId: string, path = ''): Promise<unknown> {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.list(runId, path));
  }

  async readWorkspace(runId: string, path: string): Promise<unknown> {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.read(runId, path));
  }

  forkWorkspace(workspaceKey: string): ContainerRuntime {
    if (!workspaceKey || workspaceKey.length > 200 || /[\x00-\x1f\x7f]/.test(workspaceKey)) throw new Error('작업공간 식별자가 올바르지 않습니다.');
    if (workspaceKey === this.config.workspaceKey) return this;
    return new ContainerRuntime({ ...this.config, workspaceKey }, this.runner, this.desktop);
  }

  async listWorkspaceVolumes(signal?: AbortSignal) {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.volumes(signal));
  }

  async exportWorkspace(runId: string, archivePath: string, maxBytes?: number, signal?: AbortSignal) {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.export(runId, archivePath, maxBytes, signal));
  }

  async importWorkspace(runId: string, archivePath: string, maxBytes?: number, signal?: AbortSignal, expectedArchive?: { bytes: number; sha256: string }) {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.import(runId, archivePath, maxBytes, signal, expectedArchive));
  }

  async importWorkspaceFiles(runId: string, sourceRunId: string | null, files: WorkspaceFileInput[], signal?: AbortSignal) {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.importFiles(runId, sourceRunId, files, signal));
  }

  async downloadWorkspaceFile(runId: string, path: string, maxBytes?: number) {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.download(runId, path, maxBytes));
  }

  async removeWorkspaceVolume(runId: string) {
    if (this.pendingCleanup.size) throw new Error('실행 환경의 정리 확인을 기다리고 있습니다.');
    return this.workspaceOperation(() => this.workspaces.remove(runId));
  }

  private async dockerWorkerConfig(): Promise<RuntimeConfig> {
    if (this.config.dockerSandbox !== 'codex-userns') return this.config;
    return this.workerConfig ??= (async () => {
      const engine = await this.runCommand('docker', ['version', '--format', '{{.Server.Version}}/{{.Server.Arch}}'], { timeoutMs: 30_000 });
      if (engine.code !== 0 || engine.stdout.trim() !== '29.1.3/amd64') throw new Error('codex-userns는 Docker 29.1.3/amd64에서만 검증했습니다. 다른 엔진은 프로필 재검증이 필요합니다.');
      let profile = this.desktop?.securityProfiles?.worker ?? fileURLToPath(new URL('../worker/security/codex-userns.json', import.meta.url));
      await access(profile);
      if (this.desktop) profile = await this.desktop.mapHostPath(profile);
      else if (this.config.wslDistro) {
        const mapped = await this.runCommand('wsl.exe', ['--distribution', this.config.wslDistro, '--exec', 'wslpath', '-a', profile], { timeoutMs: 30_000 });
        if (mapped.code !== 0 || !mapped.stdout.trim().startsWith('/')) throw new Error('WSL seccomp 프로필 경로를 확인하지 못했습니다.');
        profile = mapped.stdout.trim();
      }
      return { ...this.config, seccompProfile: profile };
    })().catch(error => { this.workerConfig = undefined; throw error; });
  }

  private async dockerBrowserConfig(): Promise<BrowserRuntimeConfig> {
    return this.browserConfig ??= (async () => {
      const engine = await this.runCommand('docker', ['version', '--format', '{{.Server.Version}}/{{.Server.Arch}}'], { timeoutMs: 30_000 });
      if (engine.code !== 0 || engine.stdout.trim() !== '29.1.3/amd64') throw new Error('브라우저 전용 프로필은 Docker 29.1.3/amd64에서 검증합니다. 다른 엔진은 재검증이 필요합니다.');
      let profile = this.desktop?.securityProfiles?.browser ?? fileURLToPath(new URL('../worker/security/browser-userns.json', import.meta.url));
      await access(profile);
      if (this.desktop) profile = await this.desktop.mapHostPath(profile);
      else if (this.config.wslDistro) {
        const mapped = await this.runCommand('wsl.exe', ['--distribution', this.config.wslDistro, '--exec', 'wslpath', '-a', profile], { timeoutMs: 30_000 });
        if (mapped.code !== 0 || !mapped.stdout.trim().startsWith('/')) throw new Error('WSL 브라우저 전용 프로필 경로를 확인하지 못했습니다.');
        profile = mapped.stdout.trim();
      }
      return { image: this.config.browserImage ?? '', workspaceKey: this.config.workspaceKey ?? '', seccompProfile: profile };
    })().catch(error => { this.browserConfig = undefined; throw error; });
  }

  async settle(runId: string): Promise<void> {
    this.deploymentActivityRevision++;
    this.settlementOperations++;
    try { await this.settleSelected(runId); }
    finally { this.settlementOperations--; }
  }
  private async settleSelected(runId: string): Promise<void> {
    await this.browser.close(runId);
    const names = [...['task', 'evaluate', 'repair', 'baseline-trial', 'candidate-trial', 'comparison-judge', 'session-probe'].map(phase => resourceName(runId, phase)), ...this.environments.namesFor(runId)];
    for (const name of [...names, ...[...this.pendingCleanup].filter(name => name.startsWith('ac-ws-'))]) {
      if (!this.pendingCleanup.has(name)) continue;
      if (!await this.removeWorker(name)) throw new Error(`실행 환경 정리를 확인하지 못했습니다: ${name}`);
      this.pendingCleanup.delete(name);
      this.environments.forget(name);
    }
    await this.removePendingTrialCopies(runId);
    await this.retryAuthenticationCleanup();
  }

  private async removePendingTrialCopies(parentRunId?: string): Promise<void> {
    for (const [runId, pending] of this.pendingTrialCopies) {
      if (parentRunId && pending.parentRunId !== parentRunId) continue;
      try { await this.workspaces.remove(runId); }
      catch { throw new RuntimeCleanupPendingError('임시 비교 작업공간의 정리 완료를 기다립니다.'); }
      if (this.pendingTrialCopies.get(runId) === pending) {
        this.pendingTrialCopies.delete(runId); pending.release?.();
      }
    }
  }

  async canResume(input: ExecutionInput): Promise<boolean> {
    assertEnvironmentRelease(this.configForRun(input.run), input);
    await this.validateRunRelease(input.run);
    return this.workspaceOperation(() => this.canResumeSelected(input));
  }
  private async canResumeSelected(input: ExecutionInput): Promise<boolean> {
    const selected = this.configForRun(input.run);
    if (input.environmentBuild) return this.environments.canResumeBuild(input);
    if (input.agent.repositoryIds.length && input.repositoryTransport !== 'github-app-v1') return false;
    if (input.checkpoint?.phase === 'complete' || input.checkpoint?.phase === 'evaluate') {
      return Boolean(input.checkpoint.previousResult);
    }
    if (!input.checkpoint && input.previousResult) return true;
    if (this.config.mode !== 'docker' || !this.config.persistentWorkspaces || !this.config.workspaceKey
      || !input.checkpoint?.sessionId || !/^[a-f0-9-]{36}$/i.test(input.checkpoint.sessionId)) return false;
    try {
      // Inventory helpers must finish before their read-only mounts can be
      // interpreted as active workers. Keep the lock through probe cleanup.
      return await this.workspacesFor(input.run).withInventoryLock(async () => {
        const name = resourceName(input.run.id, 'session-probe');
        if (this.pendingCleanup.has(name)) throw new RuntimeCleanupPendingError('세션 확인 환경의 정리 완료를 기다리고 있습니다.');
        const volume = workspaceVolume(this.config, input.run.id);
        const owned = await this.runCommand('docker', ['volume', 'inspect', volume, '--format', '{{json .Labels}}'], { timeoutMs: 30_000 });
        if (owned.code !== 0) return false;
        const labels = z.record(z.string(), z.string()).parse(JSON.parse(owned.stdout));
        if (labels.app !== 'agent-company' || labels['agent-company.workspace'] !== this.config.workspaceKey || labels['agent-company.run'] !== input.run.id) return false;
        const active = await this.runCommand('docker', ['ps', '-q', '--filter', `volume=${volume}`], { timeoutMs: 30_000 });
        if (active.code !== 0 || active.stdout.trim()) return false;
        let resumable = false;
        try {
          const probe = await this.runCommand('docker', ['run', '--rm', '--name', name, '--label', 'app=agent-company',
            '--label', `agent-company.workspace=${this.config.workspaceKey}`, '--label', `agent-company.run=${input.run.id}`,
            '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--memory=64m', '--cpus=0.25',
            '--mount', `type=volume,source=${volume},target=/workspace,readonly`, selected.image, '--check-session', input.checkpoint!.sessionId!], { timeoutMs: 30_000 });
          resumable = probe.code === 0;
        } finally {
          if (await this.removeWorker(name)) this.pendingCleanup.delete(name);
          else {
            this.pendingCleanup.add(name);
            throw new RuntimeCleanupPendingError('세션 확인 환경의 정리 완료를 기다리고 있습니다.');
          }
        }
        return resumable;
      });
    } catch (error) {
      if (error instanceof RuntimeCleanupPendingError) throw error;
      return false;
    }
  }

  private async removeWorker(name: string): Promise<boolean> {
    const c = this.config;
    try {
      if (c.mode === 'docker') {
        const result = await this.runCommand('docker', ['rm', '-f', name], { timeoutMs: 15_000 });
        return result.code === 0 || /No such container/i.test(result.stderr);
      }
      const result = await this.runCommand('kubectl', ['--context', c.context!, '-n', c.namespace!,
        'delete', `job/${name}`, `configmap/${name}`, '--ignore-not-found', '--wait=true', '--timeout=20s'], { timeoutMs: 25_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private async finishWorker(name: string, hooks: ExecutionHooks): Promise<void> {
    if (await this.removeWorker(name)) {
      // A different concurrently running worker must not clear this failure.
      this.pendingCleanup.delete(name);
      return;
    }
    this.pendingCleanup.add(name);
    await hooks.onEvent(`실행 환경 정리를 확인하지 못했습니다: ${name}. 정리 확인 전 새 작업 환경을 시작하지 않습니다.`);
  }

  private async retryPendingCleanup(): Promise<void> {
    if (!this.pendingCleanup.size && !this.pendingTrialCopies.size) return this.retryAuthenticationCleanup();
    if (this.cleanupRetry) return this.cleanupRetry;
    this.cleanupRetry = (async () => {
      while (this.pendingCleanup.size) {
        for (const name of [...this.pendingCleanup]) {
          if (!await this.removeWorker(name)) {
            throw new RuntimeCleanupPendingError(`잔여 실행 환경 정리를 확인하지 못해 새 실행을 차단했습니다: ${name}`);
          }
          this.pendingCleanup.delete(name);
          this.environments.forget(name);
        }
      }
      await this.removePendingTrialCopies();
      await this.retryAuthenticationCleanup();
    })().finally(() => { this.cleanupRetry = undefined; });
    return this.cleanupRetry;
  }

  private async retryAuthenticationCleanup(): Promise<void> {
    try { await this.desktop?.authentication.retryCleanup(); }
    catch { throw new RuntimeCleanupPendingError('인증 파일을 사용한 컨테이너의 종료와 연결 정리를 기다립니다.'); }
  }

  /** Called only by the locked control-plane, never by a read-only health request. */
  async recover(): Promise<void> {
    if (!this.config.workspaceKey || this.recovered) return;
    if (this.recovery) return this.recovery;
    this.deploymentActivityRevision++;
    this.recovery = this.cleanupPreviousWorkers().then(() => { this.recovered = true; }).finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  private async cleanupPreviousWorkers(): Promise<void> {
    const c = this.config;
    const selector = `agent-company.workspace=${c.workspaceKey}`;
    if (c.mode === 'docker') {
      const list = await this.runCommand('docker', ['ps', '-aq', '--filter', 'label=app=agent-company', '--filter', `label=${selector}`], { timeoutMs: c.wslDistro ? 30_000 : 5000 });
      if (list.code !== 0) throw new Error('이전 컨테이너 상태를 확인하지 못했습니다. Docker 연결을 확인해야 합니다.');
      for (const id of list.stdout.trim().split(/\s+/).filter(Boolean)) {
        if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('이전 컨테이너 식별자가 올바르지 않습니다.');
        const result = await this.runCommand('docker', ['rm', '-f', id], { timeoutMs: 15_000 });
        if (result.code !== 0 && !/No such container/i.test(result.stderr)) throw new Error(`이전 컨테이너 정리에 실패했습니다: ${id}`);
      }
      await this.workspaces.recoverTemporaryTrials();
    } else {
      if (!c.context || !c.namespace) throw new Error('Kubernetes context·namespace 설정이 필요합니다.');
      const result = await this.runCommand('kubectl', ['--context', c.context, '-n', c.namespace, 'delete', 'jobs,configmaps', '-l', `app=agent-company,${selector}`, '--ignore-not-found', '--wait=true', '--timeout=20s'], { timeoutMs: 25_000 });
      if (result.code !== 0) throw new Error('이전 Kubernetes 작업 정리에 실패했습니다.');
    }
  }

  inspect(refresh = false): Promise<RuntimeInfo> {
    if (refresh || !this.inspection || this.inspection.expiresAt <= Date.now()) {
      this.inspection = { expiresAt: Date.now() + 5000, value: this.inspectCurrent() };
    }
    return this.inspection.value.then(info => this.pendingCleanup.size ? {
      ...info,
      // available reports engine presence; execute/phase performs the cleanup gate.
      // This read-only inspection does not delete resources as a side effect.
      message: `${this.pendingCleanup.size}개 실행 환경의 정리가 확인되지 않았습니다. 다음 실행은 잔여 환경 정리에 성공한 뒤 시작합니다. ${info.message}`,
    } : info);
  }

  private async inspectCurrent(c = this.config): Promise<RuntimeInfo> {
    let authenticated = false;
    if (c.mode === 'kubernetes') authenticated = Boolean(c.authSecret);
    else if (c.auth === 'api-key') authenticated = Boolean(c.apiKey?.trim());
    else if (c.auth === 'desktop-codex') authenticated = await this.desktop!.authentication.hasCredentials();
    else if (c.auth === 'codex') {
      try { await access(c.authFile); authenticated = true; } catch { /* explicit missing-auth status */ }
    }
    const info: RuntimeInfo = { mode: c.mode, available: false, authenticated, image: c.image, model: c.model, version: null, message: '' };
    try {
      if (c.mode === 'docker') {
        const version = await this.runCommand('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: c.wslDistro ? 30_000 : 5000 });
        if (version.code !== 0) throw new Error('Docker 엔진이 실행되지 않았습니다.');
        info.version = version.stdout.trim();
        if (c.dockerSandbox === 'codex-userns' && info.version !== '29.1.3') throw new Error('Docker 버전이 변경됐습니다. codex-userns 프로필 재검증이 필요합니다.');
        const image = await this.runCommand('docker', ['image', 'inspect', c.image, '--format', '{{.Id}}'], { timeoutMs: c.wslDistro ? 30_000 : 5000 });
        if (image.code !== 0) throw new Error(`실행 이미지 ${c.image}을 먼저 빌드해야 합니다.`);
      } else {
        if (!c.context || !c.namespace || !c.authSecret) throw new Error('Kubernetes context·namespace·인증 Secret 설정이 필요합니다.');
        const result = await this.runCommand('kubectl', ['--context', c.context, '-n', c.namespace, 'get', 'secret', c.authSecret, '-o', 'name'], { timeoutMs: 5000 });
        if (result.code !== 0) throw new Error('지정한 Kubernetes 연결 또는 인증 Secret을 확인할 수 없습니다.');
      }
      info.available = true;
      info.message = authenticated ? '실행 환경이 감지됐습니다. 실제 모델·샌드박스 동작은 작업 실행으로 확인됩니다.'
        : c.auth === 'desktop-codex' ? '실행 환경은 준비됐습니다. 앱 설정에서 모델 계정을 연결할 수 있습니다.'
        : '실행 환경은 준비됐습니다. AGENT_AUTH로 모델 인증 방식을 선택해야 합니다.';
    } catch (error) {
      info.message = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${c.mode === 'docker' ? 'Docker' : 'kubectl'} 실행 도구가 없습니다. 에이전트 생성·기억·복제는 사용할 수 있습니다.`
        : error instanceof Error ? error.message : '실행 환경을 확인하지 못했습니다.';
    }
    return info;
  }

  async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    if (this.executingRuns.has(input.run.id)) throw new Error('같은 실행의 worker가 이미 사용 중입니다.');
    this.executingRuns.add(input.run.id);
    this.deploymentActivityRevision++;
    try { return await this.executeSelected(input, hooks); }
    finally { this.executingRuns.delete(input.run.id); }
  }
  private async executeSelected(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    assertEnvironmentRelease(this.configForRun(input.run), input);
    if (this.desktop && !input.environmentBuild) workerAuthentication(this.configForRun(input.run));
    await this.validateRunRelease(input.run);
    const info = this.config.releaseCatalog ? await this.inspectCurrent(this.configForRun(input.run)) : await this.inspect(true);
    if (!info.available || (!input.environmentBuild && !info.authenticated)) throw new Error(info.message);
    await this.recover();
    await this.retryPendingCleanup();
    const signal = AbortSignal.any([hooks.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    if (input.environmentBuild) {
      if (input.run.kind !== 'environment' || input.environment || input.growth) throw new Error('환경 설치 실행 입력이 올바르지 않습니다.');
      const report = await this.environments.build(input, { ...hooks, signal });
      signal.throwIfAborted();
      const result: ExecutionResult = { result: '개인 환경 설치와 격리 검증을 완료했습니다.', memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0, environmentBuild: report };
      await hooks.onCheckpoint?.({ phase: 'complete', previousResult: result });
      return result;
    }
    if (input.environment) {
      if (this.environmentRuns.has(input.run.id)) throw new Error('동일 실행의 개인 환경이 이미 사용 중입니다.');
      const resources = input.collaboration?.tools.some(tool => tool.name === 'browser_open')
        ? browserResources(input.resources ?? { memoryMiB: 2048, cpus: 2 }).worker : input.resources;
      this.environmentRuns.set(input.run.id, { input: { ...input, resources }, signal });
    }
    try { return await this.executeModel(input, { ...hooks, signal }); }
    finally { this.environmentRuns.delete(input.run.id); }
  }

  async callEnvironmentTool(input: ExecutionInput, call: EnvironmentToolCall, signal: AbortSignal): Promise<unknown> {
    this.configForRun(input.run);
    const active = this.environmentRuns.get(input.run.id);
    if (!active || !input.environment || active.input.environment?.revisionId !== input.environment.revisionId) throw new Error('진행 중인 실행에 고정된 개인 환경만 호출할 수 있습니다.');
    if (JSON.stringify(active.input.run.runtimeRelease) !== JSON.stringify(input.run.runtimeRelease)) throw new RuntimeReleaseBlockedError('진행 중인 실행의 고정 이미지가 변경됐습니다.');
    if (this.pendingCleanup.size) throw new RuntimeCleanupPendingError('개인 환경 정리 확인을 기다리고 있습니다.');
    return this.environments.call(active.input, call, AbortSignal.any([signal, active.signal]));
  }

  private async executeModel(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    if (input.run.consultationOfRunId && (input.run.interactionMode !== 'discuss' || input.run.workspaceSourceRunId
      || input.agent.allowWeb || input.agent.repositoryIds.length || input.environment || input.connections.length
      || input.environmentBuild || input.growth || input.repositoryTransport)) throw new Error('별도 상담은 개인 작업공간·환경·외부 연결 없는 읽기 전용 입력이어야 합니다.');
    if (input.objectiveEvaluation && (input.run.interactionMode !== 'discuss' || input.agent.allowWeb || input.agent.repositoryIds.length
      || input.collaboration || input.environment || input.connections.length || input.growth)) throw new Error('목적 평가는 외부 접근 없는 읽기 전용 입력이어야 합니다.');
    // Registered scope is not a working transport. Never silently omit required repositories.
    if (input.agent.repositoryIds.length && !input.growth && input.repositoryTransport !== 'github-app-v1') throw new Error('저장소 접근 범위는 등록됐지만 이 실행에 유효한 저장소 연결·권한이 없습니다. GitHub 연결과 역할별 권한을 확인한 뒤 새 작업을 시작할 수 있습니다.');
    const signal = hooks.signal;
    if (input.growth) return this.executeGrowth(input, { ...hooks, signal });
    const readOnly = input.run.interactionMode === 'auto' || input.run.interactionMode === 'discuss';
    await hooks.onEvent('독립된 작업 컨테이너를 준비합니다.');
    let steering = await hooks.getSteering();
    const savedTask = input.checkpoint?.phase === 'evaluate' ? input.checkpoint.previousResult : undefined;
    if (savedTask) steering = steering.slice(0, input.checkpoint?.appliedSteeringCount ?? savedTask.appliedSteeringCount ?? 0);
    let task = savedTask ? taskResultSchema.parse(savedTask)
      : { ...taskResultSchema.parse(await this.phase('task', input, { ...hooks, signal }, { steering, previousTask: input.previousResult })), learningReview: undefined };
    const readonlyResult = () => ({ ...task, route: input.run.interactionMode === 'auto' && task.route === 'task' ? 'task' as const : 'discuss' as const,
      memories: [], skills: [], artifacts: input.run.consultationOfRunId ? task.artifacts : [], skillConcerns: [], environmentProposal: null, appliedSteeringCount: steering.length });
    if (readOnly) {
      const completed = readonlyResult();
      await hooks.onCheckpoint?.({ phase: 'complete', previousResult: completed, appliedSteeringCount: steering.length });
      return completed;
    }
    let growthProgress = structuredClone(input.checkpoint?.growthProgress ?? {});
    const checkpointTask = async () => hooks.onCheckpoint?.({ phase: 'evaluate', appliedSteeringCount: steering.length,
      previousResult: { ...task, appliedSteeringCount: steering.length, skills: task.skills.map(skill => ({ ...skill, passed: false, evaluation: '독립 평가 대기' })) }, growthProgress });
    await checkpointTask();
    // Exec has no live turn/steer API. Consume additions in a following isolated turn,
    // before committing growth, rather than claiming an undelivered steering succeeded.
    for (;;) {
      const next = await hooks.getSteering();
      if (next.length === steering.length) break;
      steering = next;
      await hooks.onEvent('추가 지시를 후속 실행에 반영합니다.');
      const updated = taskResultSchema.parse(await this.phase('task', input, { ...hooks, signal }, { steering, previousTask: task }));
      task = { ...updated, learningReview: undefined, inputTokens: task.inputTokens + updated.inputTokens, outputTokens: task.outputTokens + updated.outputTokens };
      growthProgress = {};
      await checkpointTask();
    }
    if (!task.learningReview) {
      const frozen = learningInput(input, task, steering);
      if (task.learningProtocol === 1) {
        await hooks.onEvent('작업 결과의 학습 근거와 기억·스킬 제안 또는 보류 이유를 검토합니다.');
        const local: ExecutionInput = { ...this.localGrowthInput(input), environment: undefined, memories: [], skills: [],
          run: { ...input.run, interactionMode: 'discuss', workspaceSourceRunId: null } };
        let learningUsage = { inputTokens: 0, outputTokens: 0 };
        try {
          const reviewed = validateLearning(await this.phase('evaluate', local, { ...hooks, onTool: undefined, onAttempt: async attempt => {
            learningUsage = { inputTokens: attempt.usage.inputTokens ?? 0, outputTokens: attempt.usage.outputTokens ?? 0 };
            await hooks.onAttempt?.(attempt);
          } },
            { kind: 'learning-review', reason: '작업 결과의 학습 근거와 보류 사유 검토', learning: frozen }), frozen);
          task = { ...task, memories: reviewed.memories, skills: reviewed.skills, learningReview: reviewed.review,
            inputTokens: task.inputTokens + reviewed.inputTokens, outputTokens: task.outputTokens + reviewed.outputTokens };
        } catch (error) {
          if (paused(error) || error instanceof WorkerInterruptedError || error instanceof RuntimeReleaseBlockedError || error instanceof RuntimeCleanupPendingError) throw error;
          signal.throwIfAborted();
          growthProgress.learningUnreviewed = { memories: task.memories, skills: task.skills };
          task = { ...task, memories: [], skills: [], inputTokens: task.inputTokens + learningUsage.inputTokens,
            outputTokens: task.outputTokens + learningUsage.outputTokens, learningReview: { inputHash: frozen.inputHash, status: 'deferred',
            reason: `학습 검토를 완료하지 못했습니다: ${error instanceof Error ? error.message.slice(0,1500) : '검토 실패'}`,
            evidence: [], memoryCount: 0, skillCount: 0, completedAt: new Date().toISOString() } };
          // An unverified reflection never publishes its proposed memories or skills.
        }
      } else {
        task = { ...task, learningReview: { inputHash: frozen.inputHash, status: 'deferred',
          reason: '이 작업에 고정된 구형 실행기는 별도 학습 검토를 지원하지 않습니다. 실행 버전을 보존하며 새 실행기에서 시작한 작업부터 검토합니다.',
          evidence: [], memoryCount: task.memories.length, skillCount: task.skills.length, completedAt: new Date().toISOString() } };
      }
      await checkpointTask();
    }
    const compared: ExecutionResult['skills'] = [];
    let inputTokens = task.inputTokens, outputTokens = task.outputTokens;
    for (const proposed of task.skills) {
      const baseline = input.skills.find(skill => skill.status === 'active' && skill.name === proposed.name) ?? null;
      const candidateSkill: Skill = { ...proposed, id: baseline?.id ?? randomUUID(), agentId: input.agent.id, version: (baseline?.version ?? 0) + 1,
        status: 'candidate', evaluation: '', sourceRunId: input.run.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const prompt = growthTaskPrompt(input.run.prompt, steering);
      const comparison = await this.compare(input, { ...hooks, signal }, baseline, candidateSkill, prompt, growthProgress, checkpointTask, proposed.replay);
      inputTokens += comparison.inputTokens; outputTokens += comparison.outputTokens;
      compared.push({ ...proposed, comparison: comparison.evidence, passed: comparison.evidence.verified && comparison.evidence.verdict === 'improved', evaluation: comparison.evidence.reason });
    }
    signal.throwIfAborted();
    const completed: ExecutionResult = { ...task, appliedSteeringCount: steering.length,
      inputTokens, outputTokens, skills: compared,
      skillConcerns: task.skillConcerns?.filter(item => input.skills.some(skill => skill.id === item.skillId && skill.status === 'active')),
    };
    await hooks.onCheckpoint?.({ phase: 'complete', previousResult: completed, appliedSteeringCount: steering.length,
      ...(growthProgress.learningUnreviewed ? { growthProgress: { learningUnreviewed: growthProgress.learningUnreviewed } } : {}) });
    return completed;
  }

  private async executeGrowth(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const growth = input.growth!;
    const growthProgress = structuredClone(input.checkpoint?.growthProgress ?? {});
    let proposed = growth.candidate, inputTokens = 0, outputTokens = 0;
    const persist = async () => hooks.onCheckpoint?.({ phase: 'evaluate', appliedSteeringCount: input.run.steering.length, growthProgress,
      previousResult: { result: '성장 비교 진행 상태를 보존했습니다.', memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0 } });
    // Growth stages have no original/shared writes. Persist their resumable
    // controller state before the first repair or baseline model can be killed.
    await persist();
    if (growth.mode === 'repair') {
      const repair = { baseline: skillContent(growth.baseline), candidate: skillContent(growth.candidate), feedback: growth.feedback, prompt: growth.originalPrompt,
        replay: growth.replay, source: input.growthReplay };
      const key = `repair-${hash(repair)}`;
      const repaired = z.object({ skill: candidate, inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
        .parse(growthProgress[key] ?? await this.phase('repair', this.localGrowthInput(input), { ...hooks, onTool: undefined }, { repair, reason: '유효 개선점을 보존하는 스킬 수정 후보 작성' }));
      growthProgress[key] = repaired; await persist();
      proposed = { ...proposed, ...repaired.skill, version: proposed.version + 1 };
      inputTokens += repaired.inputTokens; outputTokens += repaired.outputTokens;
    }
    const comparison = await this.compare(input, hooks, growth.baseline, proposed, growth.originalPrompt, growthProgress, persist, growth.replay);
    const result: ExecutionResult = { result: comparison.evidence.reason, memories: [], artifacts: [],
      inputTokens: inputTokens + comparison.inputTokens, outputTokens: outputTokens + comparison.outputTokens,
      growthReview: comparison.evidence, skills: growth.mode === 'repair' ? [{ ...skillContent(proposed)!, replay: growth.replay, passed: comparison.evidence.verified && comparison.evidence.verdict === 'improved', evaluation: comparison.evidence.reason, comparison: comparison.evidence }] : [] };
    await hooks.onCheckpoint?.({ phase: 'complete', previousResult: result, appliedSteeringCount: input.run.steering.length });
    return result;
  }

  private localGrowthInput(input: ExecutionInput): ExecutionInput {
    return { ...input, agent: { ...input.agent, allowWeb: false, repositoryIds: [] }, connections: [],
      repositoryTransport: undefined, collaboration: undefined, environment: input.growthReplay ? undefined : input.environment, environmentBuild: undefined,
      objectiveEvaluation: undefined, previousResult: undefined, checkpoint: undefined, growth: undefined };
  }

  private async compare(input: ExecutionInput, hooks: ExecutionHooks, baseline: Skill | null, proposed: Skill, prompt: string, progress: Record<string, unknown>, persist: () => Promise<unknown>, replay?: GrowthReplayProposal | null) {
    const selectedConfig = this.configForRun(input.run), workspaces = this.workspacesFor(input.run);
    const commonSkills = input.skills.filter(skill => skill.status === 'active' && skill.id !== proposed.id && (!baseline || skill.id !== baseline.id) && skill.name !== proposed.name);
    let replayInput: ReturnType<typeof resolveGrowthReplay> | undefined, replayError = '';
    if (input.growthReplay) {
      try {
        if (input.growthReplay.sourceRunId !== (input.growth?.sourceRunId ?? input.run.id)) throw new Error('성장 검사 고정 자료의 원래 실행이 일치하지 않습니다.');
        replayInput = resolveGrowthReplay(input.growthReplay, replay, prompt);
        prompt = replayInput.prompt;
      } catch (error) { replayError = error instanceof Error ? error.message : String(error); }
    } else if (replay) replayError = '로컬 검사 제안의 고정 입력 자료가 없습니다. 후보를 보존했습니다.';
    const sourceRunId = replayInput ? null : input.run.workspaceSourceRunId ?? null;
    const evidence: ComparisonEvidence = {
      fingerprint: { promptHash: hash(prompt), inputHash: hash({ prompt, persona: input.agent.persona, memories: input.memories.map(({ kind, title, content }) => ({ kind, title, content })),
        commonSkills: commonSkills.map(skillContent), sourceRunId, ...(replayInput ? { replayHash: replayInput.replayHash } : {}) }), model: input.agent.model, image: selectedConfig.image,
        baselineSkillHash: baseline ? hash(skillContent(baseline)) : null, candidateSkillHash: hash(skillContent(proposed)), ...(replayInput ? { replayHash: replayInput.replayHash } : {}) },
      ...(replayInput ? { replay: structuredClone(replay!) } : {}),
      baseline: { attemptId: '', resultHash: '', completed: false }, candidate: { attemptId: '', resultHash: '', completed: false }, judgeAttemptId: '',
      verdict: 'inconclusive', reason: '', evidence: [], usefulChanges: [], failures: [], verified: false,
    };
    let inputTokens = 0, outputTokens = 0;
    const key = `comparison-${hash({ ...evidence.fingerprint, ...(input.run.runtimeRelease ? { runtimeRelease: input.run.runtimeRelease } : {}) })}`;
    let saved = progress[key] as ComparisonProgress | undefined;
    if (saved && (saved.fingerprint?.inputHash !== evidence.fingerprint.inputHash || saved.fingerprint?.candidateSkillHash !== evidence.fingerprint.candidateSkillHash || saved.fingerprint?.baselineSkillHash !== evidence.fingerprint.baselineSkillHash)) saved = undefined;
    if (selectedConfig.releaseCatalog && saved && saved.fingerprint.image !== selectedConfig.image) throw new RuntimeReleaseBlockedError('저장된 성장 비교 이미지가 Run pin과 다릅니다.');
    const finish = (reason: string) => ({ evidence: { ...evidence, reason }, inputTokens, outputTokens });
    if (replayError) return finish(replayError.slice(0, 20_000));
    if (this.config.mode !== 'docker' || !this.workspacePersistence) return finish('독립 비교에는 영속 Docker 작업공간이 필요합니다. 후보를 보존했습니다.');
    if (!replayInput && (input.agent.allowWeb || input.collaboration || input.agent.repositoryIds.length)) return finish('웹·동료·저장소 맥락을 재생하는 과제의 독립 비교는 지원하지 않습니다. 후보를 보존했습니다.');
    if (saved?.completed) return saved.completed;
    try {
      await this.retryPendingCleanup();
      const image = await this.runCommand('docker', ['image', 'inspect', saved?.fingerprint.image ?? selectedConfig.image, '--format', '{{.Id}}'], { timeoutMs: 30_000, signal: hooks.signal });
      if (image.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) throw new Error('비교 이미지의 고정 식별자를 확인하지 못했습니다.');
      if (selectedConfig.releaseCatalog && image.stdout.trim() !== selectedConfig.image) throw new RuntimeReleaseBlockedError('성장 비교 이미지가 Run pin과 일치하지 않습니다.');
      evidence.fingerprint.image = image.stdout.trim();
      if (saved && saved.fingerprint.image !== evidence.fingerprint.image) throw new Error('이전 비교와 이미지 식별자가 다릅니다.');
      saved ??= { fingerprint: evidence.fingerprint, trials: [] };
      progress[key] = saved;
      const volumes = sourceRunId ? await workspaces.volumes() : [];
      const source = sourceRunId ? volumes.find(item => item.runId === sourceRunId) : null;
      if (sourceRunId && !source) throw new Error('과제 시작 전 파일 버전을 확인하지 못했습니다.');
      const trials: Array<{ result: ReturnType<typeof qualityOutput>; observations: ModelAttempt['observations'] }> = [];
      for (const [index, selected] of [baseline, proposed].entries()) {
        const prior = saved.trials[index];
        if (prior?.attempt.status === 'succeeded') {
          evidence[index ? 'candidate' : 'baseline'] = { attemptId: prior.attempt.id, resultHash: hash(prior.result), completed: true };
          inputTokens += prior.inputTokens; outputTokens += prior.outputTokens;
          trials.push({ result: prior.result, observations: prior.attempt.observations });
          continue;
        }
        const workspaceRunId = randomUUID(), kind = index ? 'candidate-trial' : 'baseline-trial';
        const release = await hooks.reserveWorkspaceCopy?.(workspaceRunId, source?.bytes ?? 0);
        let lastAttempt: ModelAttempt | undefined;
        try {
          await workspaces.prepare(workspaceRunId, sourceRunId, hooks.signal, input.run.id);
          const trialInput: ExecutionInput = { ...this.localGrowthInput(input), run: { ...input.run, prompt, workspaceSourceRunId: sourceRunId }, memories: structuredClone(input.memories),
            skills: [...commonSkills, ...(selected ? [{ ...selected, status: 'active' as const }] : [])], previousResult: undefined, checkpoint: undefined, collaboration: undefined, growth: undefined };
          const raw = await this.phase('trial', trialInput, { ...hooks, onCheckpoint: undefined, onTool: undefined,
            onAttempt: async attempt => { lastAttempt = attempt; await hooks.onAttempt?.(attempt); } },
          { kind, reason: '같은 과제·파일·기억에서 대상 스킬만 바꾼 독립 실행', workspaceRunId, image: evidence.fingerprint.image });
          const task = taskResultSchema.parse(raw);
          inputTokens += task.inputTokens; outputTokens += task.outputTokens;
          if (!lastAttempt || lastAttempt.status !== 'succeeded') throw new Error('독립 실행 완료 근거가 없습니다.');
          const quality = qualityOutput(task);
          evidence[index ? 'candidate' : 'baseline'] = { attemptId: lastAttempt.id, resultHash: hash(quality), completed: true };
          trials.push({ result: quality, observations: lastAttempt.observations });
          saved.trials[index] = { result: quality, attempt: lastAttempt, inputTokens: task.inputTokens, outputTokens: task.outputTokens };
          await persist();
        } finally {
          // Named UUID belongs only to this temporary trial; original/source Run volumes remain untouched.
          try { await workspaces.remove(workspaceRunId); release?.(); }
          catch {
            this.pendingTrialCopies.set(workspaceRunId, { parentRunId: input.run.id, release });
            throw new RuntimeCleanupPendingError('임시 비교 작업공간의 정리 완료를 기다립니다.');
          }
        }
      }
      let judgeAttempt: ModelAttempt | undefined;
      const judgement = comparisonSchema.parse(await this.phase('evaluate', this.localGrowthInput(input), { ...hooks, onCheckpoint: undefined, onTool: undefined,
        onAttempt: async attempt => { judgeAttempt = attempt; await hooks.onAttempt?.(attempt); } },
      { kind: 'comparison-judge', reason: '두 독립 결과의 품질·완료 여부 비교', image: evidence.fingerprint.image,
        comparison: { prompt, baseline: trials[0], candidate: trials[1], ...(replayInput ? {
          replay: { proposal: replay, sourceHash: replayInput.sourceHash, originalPrompt: input.growthReplay!.taskPrompt, skill: skillContent(proposed) },
        } : {}) } }));
      inputTokens += judgement.inputTokens; outputTokens += judgement.outputTokens;
      if (!judgeAttempt || judgeAttempt.status !== 'succeeded') throw new Error('독립 판정 실행 완료 근거가 없습니다.');
      Object.assign(evidence, { judgeAttemptId: judgeAttempt.id, verdict: judgement.verdict, reason: judgement.reason,
        evidence: judgement.evidence, usefulChanges: judgement.usefulChanges, failures: judgement.failures,
        ...(replayInput ? { replayApplicable: judgement.replayApplicable === true } : {}),
        verified: Boolean(judgement.evidence.some(item => item.trim()) && judgement.reason.trim() && evidence.baseline.completed && evidence.candidate.completed
          && (!replayInput || judgement.replayApplicable === true)) });
      if (replayInput && judgement.replayApplicable !== true) {
        evidence.verdict = 'inconclusive'; evidence.reason = '독립 평가에서 로컬 검사의 적용 가능성을 확인하지 못했습니다. 후보를 보존했습니다.';
      }
      if (evidence.verdict === 'improved' && evidence.baseline.resultHash === evidence.candidate.resultHash) {
        evidence.verdict = 'inconclusive'; evidence.verified = false; evidence.reason = '두 결과 내용이 같아 품질 개선 판정을 채택하지 않았습니다.';
      }
      saved.completed = { evidence, inputTokens, outputTokens }; saved.trials = []; await persist();
      return { evidence, inputTokens, outputTokens };
    } catch (error) {
      if (paused(error) || error instanceof WorkerInterruptedError || error instanceof RuntimeReleaseBlockedError || error instanceof RuntimeCleanupPendingError) throw error;
      hooks.signal.throwIfAborted();
      return finish(error instanceof Error ? error.message.slice(0, 20_000) : '독립 비교를 완료하지 못했습니다.');
    }
  }

  private async phase(phase: ModelPhase, input: ExecutionInput, hooks: ExecutionHooks, extra: object): Promise<unknown> {
    const details = extra as { kind?: string; reason?: string; workspaceRunId?: string; image?: string };
    const c = this.configForRun(input.run), name = resourceName(input.run.id, details.kind ?? phase);
    if (c.releaseCatalog && details.image && details.image !== c.image) throw new RuntimeReleaseBlockedError('모델 단계의 이미지가 Run pin과 다릅니다.');
    if (input.environment) await this.environments.verify(input, hooks.signal);
    const persistent = phase === 'task' && c.mode === 'docker' && !input.run.consultationOfRunId && Boolean(c.persistentWorkspaces && c.workspaceKey);
    const payload: Record<string, unknown> = { phase, input, timeoutMs: c.timeoutMs, persistent, ...extra };
    const interactive = phase === 'task' && c.mode === 'docker' && Boolean(input.collaboration && hooks.onTool);
    payload.interactiveCollaboration = interactive;
    if (c.mode !== 'docker' && input.collaboration) {
      throw new Error('동료 협업 통신은 현재 Docker 실행기에서만 연결했습니다. Kubernetes에서는 아직 지원하지 않습니다.');
    }
    let result: unknown, reportedError = '';
    let phaseSignal = hooks.signal;
    let attempt: ModelAttempt | undefined;
    const publish = async () => { if (attempt) await hooks.onAttempt?.(structuredClone(attempt)); };
    const start = async () => {
      const request = { runId: input.run.id, phase, kind: details.kind ?? phase, reason: details.reason ?? `${phase} 모델 실행` };
      await hooks.beforeModelStart?.(request);
      attempt = { ...request, id: randomUUID(), model: input.agent.model, status: 'started', startedAt: new Date().toISOString(), completedAt: null, durationMs: null,
        usage: unknownUsage(), observations: [], observationsTruncated: false, error: null };
      await publish();
    };
    const finish = async (error?: unknown) => {
      if (!attempt) return;
      attempt.status = phaseSignal.aborted ? 'cancelled' : error ? 'failed' : 'succeeded';
      attempt.completedAt = new Date().toISOString();
      attempt.durationMs = Math.max(0, Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt));
      attempt.error = error ? (error instanceof Error ? error.message : String(error)).slice(0, 2000) : null;
      if (attempt.status !== 'succeeded' && attempt.usage.status !== 'unknown') attempt.usage.status = 'partial';
      await publish();
    };
    const onLine = async (line: string) => {
      if (!line.trim()) return;
      let event: { type?: string; message?: string; result?: unknown; checkpoint?: ExecutionCheckpoint; id?: string; name?: string; arguments?: unknown; usage?: unknown; observations?: unknown; observationsTruncated?: boolean };
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'telemetry' && attempt) {
        const count = z.number().int().nonnegative().safe().nullable();
        const parsed = z.object({ usage: z.object({ status: z.enum(['unknown', 'partial', 'reported']), inputTokens: count, outputTokens: count, cachedInputTokens: count, reasoningOutputTokens: count }),
          observations: z.array(z.object({ id: z.string().min(1).max(1000), kind: z.literal('command_execution'), command: z.string().max(2000), status: z.enum(['completed', 'failed', 'unknown']), exitCode: z.number().int().safe().nullable(), outputExcerpt: z.string().max(4000) })).max(100),
          observationsTruncated: z.boolean() }).safeParse(event);
        if (parsed.success) {
          attempt.usage = parsed.data.usage;
          const observations = new Map(attempt.observations.map(item => [item.id, item]));
          for (const item of parsed.data.observations) {
            const id = `${attempt.id}:${item.id}`;
            if (observations.size < 100 || observations.has(id)) observations.set(id, { ...item, id });
            else attempt.observationsTruncated = true;
          }
          attempt.observations = [...observations.values()];
          attempt.observationsTruncated ||= parsed.data.observationsTruncated;
          await publish();
        }
      }
      if (event.type === 'tool_request') {
        if (!interactive || !hooks.onTool || !event.id || !/^[a-zA-Z0-9-]{1,100}$/.test(event.id)) return;
        try {
          phaseSignal.throwIfAborted();
          const value = await hooks.onTool(event.name ?? '', event.arguments);
          return JSON.stringify({ type: 'tool_response', id: event.id, result: value });
        } catch (error) {
          return JSON.stringify({ type: 'tool_response', id: event.id,
            error: (error instanceof Error ? error.message : '협업 도구 실행에 실패했습니다.').slice(0, 2000) });
        }
      }
      if (event.type === 'result') result = event.result;
      if (event.type === 'error') reportedError = (event.message ?? '실행 오류').slice(0, 2000);
      if (event.type === 'progress') await hooks.onEvent((event.message ?? '').slice(0, 1000));
      if (event.type === 'checkpoint' && persistent && event.checkpoint?.phase === 'task'
        && /^[a-f0-9-]{36}$/i.test(event.checkpoint.sessionId ?? '')) {
        await hooks.onCheckpoint?.({ phase: 'task', sessionId: event.checkpoint.sessionId,
          appliedSteeringCount: (extra as { steering?: string[] }).steering?.length ?? 0 });
      }
    };
    const options = { signal: hooks.signal, timeoutMs: c.timeoutMs, onLine, captureStdout: false };
    if (c.mode === 'docker') {
      if (this.desktop) {
        if (workerAuthentication(c) === 'codex-file-v1') payload.authBinding = 'codex-file-v1';
      }
      else payload.auth = c.auth === 'codex'
        ? { mode: 'codex', content: await readFile(c.authFile, 'utf8') }
        : { mode: 'api-key', content: c.apiKey };
      await this.retryPendingCleanup();
      if (persistent) {
        await this.workspacesFor(input.run).prepare(input.run.id, input.run.workspaceSourceRunId ?? undefined, hooks.signal);
      }
      const workerConfig = { ...await this.dockerWorkerConfig(), image: details.image ?? c.image };
      let failure: unknown, binding: RuntimeAuthBindingLease | undefined, launched = false;
      try {
        binding = await this.desktop?.authentication.acquire(hooks.signal);
        if (binding) {
          if (binding.ownerKey !== this.desktop!.authentication.ownerKey) throw new Error('설치형 인증 파일의 소유권이 일치하지 않습니다.');
          phaseSignal = AbortSignal.any([hooks.signal, binding.signal]);
          await binding.validate();
        }
        const args = dockerArguments(workerConfig, name,
          details.workspaceRunId ? { ...input, run: { ...input.run, id: details.workspaceRunId } } : input,
          persistent || Boolean(details.workspaceRunId), binding);
        await start();
        // Account admission stays locked across budget persistence and this final check.
        // The process adapter repeats the synchronous gate after an installed
        // target finishes its asynchronous path/config validation.
        await binding?.validate();
        phaseSignal.throwIfAborted();
        hooks.assertModelStart?.();
        launched = true;
        let spawnGateFailure: unknown;
        const completed = await this.runCommand('docker', args, { ...options, signal: phaseSignal, interactive, input: JSON.stringify(payload),
          ...(this.desktop ? { beforeSpawn: () => {
            try { phaseSignal.throwIfAborted(); hooks.assertModelStart?.(); }
            catch (error) { spawnGateFailure = error; throw error; }
          } } : {}),
        }).catch(error => {
          // The target redacts command exceptions; retain our own control-plane pause.
          if (spawnGateFailure) throw spawnGateFailure;
          if (!this.desktop) throw error;
          phaseSignal.throwIfAborted();
          throw new Error('설치형 모델 실행 연결이 종료됐습니다.');
        });
        if (completed.code === 137 || completed.code === 143) throw new WorkerInterruptedError(`작업 컨테이너가 중단됐습니다. 종료 코드 ${completed.code}. 저장한 단계부터 재개합니다.`);
        if (completed.code !== 0 || result === undefined) throw new Error(this.desktop
          ? `설치형 모델 실행이 완료되지 않았습니다. 종료 코드 ${completed.code}.`
          : reportedError || `컨테이너 실행이 완료되지 않았습니다. 종료 코드 ${completed.code}. ${completed.stderr.slice(-1200)}`);
        phaseSignal.throwIfAborted();
      } catch (error) { failure = error; throw error;
      } finally {
        try {
          if (launched) {
            try { await this.browser.close(input.run.id); }
            finally { await this.finishWorker(name, hooks); }
          }
        } finally {
          try {
            if (binding) {
              try { await binding.release(); }
              catch (error) {
                const invalid = error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RUNTIME_AUTH_INVALID';
                // Preserve a received result for executeModel's durable checkpoint.
                // An uncertain writer retains the coordinator lease; the next phase
                // and Service.settle must complete cleanup before admitting work.
                await hooks.onEvent(invalid
                  ? '모델 종료 후 인증 파일을 확인하지 못했습니다. 완료된 결과를 보존하고 계정 연결을 다시 확인합니다.'
                  : '인증 파일을 사용한 컨테이너의 종료와 연결 정리를 기다립니다.');
              }
            }
          } finally { await finish(failure); }
        }
      }
    } else {
      const args = ['--context', c.context!, '-n', c.namespace!];
      const manifest = kubernetesResources(c, name, payload);
      await this.retryPendingCleanup();
      await start();
      let failure: unknown;
      try {
        hooks.assertModelStart?.();
        const created = await this.runCommand('kubectl', [...args, 'create', '-f', '-'], { ...options, input: JSON.stringify(manifest), onLine: undefined });
        if (created.code !== 0) throw new Error(`Kubernetes 작업 생성 실패: ${created.stderr.slice(-1200)}`);
        const logs = await this.runCommand('kubectl', [...args, 'logs', '-f', `job/${name}`, '--pod-running-timeout=120s'], options);
        if (logs.code !== 0 || result === undefined) throw new Error(reportedError || `Kubernetes 실행 실패: ${logs.stderr.slice(-1200)}`);
        const completed = await this.runCommand('kubectl', [...args, 'wait', '--for=condition=complete', `job/${name}`, '--timeout=15s'], options);
        if (completed.code !== 0) throw new Error('결과 수신 후 Kubernetes 작업 완료 상태를 확인하지 못했습니다.');
      } catch (error) { failure = error; throw error;
      } finally {
        try { await finish(failure); }
        finally { await this.finishWorker(name, hooks); }
      }
    }
    hooks.signal.throwIfAborted();
    return result;
  }
}
