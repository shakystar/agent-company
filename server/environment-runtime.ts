import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { environmentCallSchema, environmentSpecSchema, type EnvironmentBuildReport, type EnvironmentSelection, type EnvironmentToolCall } from '../shared/environment.ts';
import type { ExecutionHooks, ExecutionInput, ResourceAllocation } from '../shared/types.ts';
import type { Command } from './process.ts';
import type { RuntimeConfig } from './runtime.ts';
import type { DockerWorkspaces } from './workspaces.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bundleSchema = z.object({ contentHash: hash, lockfileHash: hash, packages: environmentSpecSchema.shape.packages });
const toolSchema = z.object({ server: z.string().min(1).max(40), name: z.string().min(1).max(100), description: z.string().max(4000), inputSchema: z.record(z.string(), z.unknown()) });
const calledSchema = bundleSchema.extend({ tools: z.array(toolSchema).max(100), result: z.object({ content: z.array(z.unknown()), isError: z.boolean().optional() }).passthrough(), sessionMode: z.literal('stateless-per-call') });

/** A single serialized MCP helper shares a lease with the model worker. */
export function environmentResources(resources?: ResourceAllocation): { worker: ResourceAllocation; helper: ResourceAllocation } {
  const total = resources ?? { memoryMiB: 2048, cpus: 2 };
  if (!Number.isSafeInteger(total.memoryMiB) || total.memoryMiB < 256 || !Number.isFinite(total.cpus) || total.cpus < 0.2) throw new Error('개인 MCP에는 최소 256MiB·0.2 CPU 실행 할당이 필요합니다.');
  const helper = { memoryMiB: Math.floor(total.memoryMiB / 2), cpus: total.cpus / 2 };
  return { helper, worker: { memoryMiB: total.memoryMiB - helper.memoryMiB, cpus: total.cpus - helper.cpus } };
}

export class DockerEnvironments {
  private readonly owners = new Map<string, string>();
  private readonly calls = new Map<string, Promise<void>>();
  get busy(): boolean { return this.owners.size > 0 || this.calls.size > 0; }
  constructor(private readonly config: RuntimeConfig, private readonly command: Command, private readonly workspaces: (input?: ExecutionInput) => DockerWorkspaces,
    private readonly volume: (runId: string) => string, private readonly cleanup: (name: string) => Promise<boolean>,
    private readonly runConfig: (input: ExecutionInput) => RuntimeConfig = () => config) {}

  namesFor(runId: string): string[] { return [...this.owners].filter(([, owner]) => owner === runId).map(([name]) => name); }
  forget(name: string) { this.owners.delete(name); }

  private supported() {
    if (this.config.mode !== 'docker' || !this.config.workspaceKey || !this.config.persistentWorkspaces) throw new Error('개인 환경은 현재 Docker 영속 작업공간에서 지원합니다.');
  }

  private async imageId(image = this.config.image, signal?: AbortSignal) {
    const result = await this.command('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 30_000, signal });
    if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())) throw new Error('개인 환경 실행 이미지의 고정 식별자를 확인하지 못했습니다.');
    return result.stdout.trim();
  }

  private async owned(runId: string, signal?: AbortSignal) {
    const result = await this.command('docker', ['volume', 'inspect', this.volume(runId), '--format', '{{json .Labels}}'], { timeoutMs: 30_000, signal });
    if (result.code !== 0) throw new Error('개인 환경 볼륨을 확인하지 못했습니다.');
    const labels = z.record(z.string(), z.string()).parse(JSON.parse(result.stdout));
    if (labels.app !== 'agent-company' || labels['agent-company.workspace'] !== this.config.workspaceKey || labels['agent-company.run'] !== runId) throw new Error('개인 환경 볼륨 소유권이 일치하지 않습니다.');
    // Read-only consumers may share this immutable bundle; a writable mount may not.
    const active = await this.command('docker', ['ps', '-q', '--filter', `volume=${this.volume(runId)}`], { timeoutMs: 30_000, signal });
    if (active.code !== 0) throw new Error('개인 환경 마운트 상태를 확인하지 못했습니다.');
    for (const id of active.stdout.trim().split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('개인 환경 컨테이너 식별자가 올바르지 않습니다.');
      const inspected = await this.command('docker', ['inspect', id, '--format', '{{json .Mounts}}'], { timeoutMs: 30_000, signal });
      if (inspected.code !== 0) throw new Error('개인 환경 마운트 권한을 확인하지 못했습니다.');
      const mounts = z.array(z.object({ Name: z.string().optional(), RW: z.boolean() }).passthrough()).parse(JSON.parse(inspected.stdout));
      if (mounts.some(mount => mount.Name === this.volume(runId) && mount.RW)) throw new Error('쓰기 중인 환경은 사용할 수 없습니다.');
    }
  }

  private async helper(input: ExecutionInput, buildRunId: string, image: string, operation: 'install' | 'verify' | 'call', request: object, signal: AbortSignal) {
    this.supported(); signal.throwIfAborted();
    const name = `ac-env-${createHash('sha256').update(input.run.id).digest('hex').slice(0, 24)}-${operation}-${randomUUID().slice(0, 8)}`;
    const id = randomUUID(), resources = operation === 'install' ? input.resources ?? { memoryMiB: 2048, cpus: 2 } : environmentResources(input.resources).helper;
    if (!Number.isSafeInteger(resources.memoryMiB) || resources.memoryMiB < 64 || !Number.isFinite(resources.cpus) || resources.cpus <= 0) throw new Error('환경 실행 자원 할당이 올바르지 않습니다.');
    const args = ['run', '--rm', '-i', '--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${this.config.workspaceKey}`,
      '--label', `agent-company.run=${input.run.id}`, '--label', `agent-company.helper=environment-${operation}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--user=1000:1000', '--pids-limit=64', `--memory=${resources.memoryMiB}m`, `--cpus=${resources.cpus}`, `--network=${operation === 'install' ? 'bridge' : 'none'}`,
      '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000', '--env=HOME=/tmp', '--workdir=/tmp',
      '--mount', `type=volume,source=${this.volume(buildRunId)},target=${operation === 'install' ? '/workspace' : '/opt/agent-environment'}${operation === 'install' ? '' : ',readonly,volume-nocopy'}`,
      '--entrypoint=node', image, '/app/environment.mjs'];
    this.owners.set(name, input.run.id);
    try {
      const result = await this.command('docker', args, { input: JSON.stringify({ ...request, operation, id }), signal, timeoutMs: operation === 'install' ? Math.min(this.config.timeoutMs, 660_000) : 90_000 });
      if (result.code !== 0) {
        const error = new Error(`개인 환경 ${operation} 실패 (${result.code}): ${result.stderr.slice(-2000)}`);
        Object.assign(error, { code: [137, 143].includes(result.code) ? 'ENVIRONMENT_INTERRUPTED' : 'ENVIRONMENT_REJECTED' });
        throw error;
      }
      if (Buffer.byteLength(result.stdout) > 512_000) throw new Error('개인 환경 응답 한도를 초과했습니다.');
      const response = z.object({ id: z.literal(id), value: z.unknown() }).strict().parse(JSON.parse(result.stdout));
      signal.throwIfAborted(); return response.value;
    } finally {
      if (await this.cleanup(name)) this.owners.delete(name);
      else { const error = new Error(`개인 환경 종료를 확인하지 못했습니다: ${name}`); Object.assign(error, { code: 'RUNTIME_CLEANUP_PENDING' }); throw error; }
    }
  }

  async build(input: ExecutionInput, hooks: ExecutionHooks): Promise<EnvironmentBuildReport> {
    this.supported(); const spec = environmentSpecSchema.parse(input.environmentBuild?.spec);
    const config = this.runConfig(input), imageId = await this.imageId(config.image, hooks.signal);
    if (config.releaseCatalog && imageId !== config.image) throw new Error('개인 환경 구축 이미지가 Run pin과 다릅니다.');
    await this.workspaces(input).prepare(input.run.id, null, hooks.signal);
    await hooks.onEvent('인증·사용자 파일 없이 고정 버전 패키지를 설치합니다.');
    const installed = bundleSchema.parse(await this.helper(input, input.run.id, imageId, 'install', { spec }, hooks.signal));
    if (JSON.stringify(installed.packages) !== JSON.stringify(spec.packages)) throw new Error('설치 패키지가 제안 명세와 다릅니다.');
    const tools: EnvironmentBuildReport['tools'] = [], checks: EnvironmentBuildReport['checks'] = [
      { name: 'locked-install', passed: true, detail: '공개 npm 레지스트리·고정 버전·SHA-512 lockfile, install scripts 및 bin links 비활성' },
    ];
    await this.owned(input.run.id, hooks.signal);
    bundleSchema.parse(await this.helper(input, input.run.id, imageId, 'verify', { spec, expected: installed }, hooks.signal));
    checks.push({ name: 'immutable-content', passed: true, detail: '읽기 전용 마운트에서 전체 콘텐츠·lockfile SHA-256 확인' });
    for (const server of spec.servers) {
      await hooks.onEvent(`${server.name} MCP를 네트워크·인증·사용자 작업공간 없이 검증합니다.`);
      const called = calledSchema.parse(await this.helper(input, input.run.id, imageId, 'call', { spec, expected: installed, call: { server: server.name, ...server.probe } }, hooks.signal));
      if (called.tools.some(tool => tool.server !== server.name) || called.result.isError) throw new Error('MCP 검증 결과가 선언과 다릅니다.');
      tools.push(...called.tools); checks.push({ name: `mcp:${server.name}`, passed: true, detail: `initialize·tools/list·${server.probe.tool} 실제 호출 통과; 호출별 새 세션` });
    }
    return { imageId, ...installed, tools, checks, createdAt: new Date().toISOString() };
  }

  private selection(input: ExecutionInput): EnvironmentSelection {
    this.supported(); const selection = input.environment, config = this.runConfig(input);
    if (!selection || !/^[a-zA-Z0-9-]{1,60}$/.test(selection.buildRunId) || !/^sha256:[a-f0-9]{64}$/.test(selection.report.imageId)) throw new Error('고정된 개인 환경 선택 정보가 없습니다.');
    environmentSpecSchema.parse(selection.spec); bundleSchema.parse(selection.report);
    // runConfig selects one homogeneous historical catalog. Never consume a
    // bundle built on another runtime base merely because both are registered.
    if (config.releaseCatalog && !config.releaseCatalog.manifests.some(item => item.image === selection.report.imageId)) throw new Error('선택된 환경과 Run이 같은 동종 worker catalog에 속하지 않습니다.');
    return selection;
  }

  async verify(input: ExecutionInput, signal: AbortSignal) {
    const selected = this.selection(input); await this.owned(selected.buildRunId, signal);
    if (await this.imageId(selected.report.imageId, signal) !== selected.report.imageId) throw new Error('선택된 환경 이미지가 일치하지 않습니다.');
    const checked = bundleSchema.parse(await this.helper(input, selected.buildRunId, selected.report.imageId, 'verify', { spec: selected.spec, expected: selected.report }, signal));
    if (checked.contentHash !== selected.report.contentHash || checked.lockfileHash !== selected.report.lockfileHash) throw new Error('선택된 환경 콘텐츠가 변경됐습니다.');
  }

  async canResumeBuild(input: ExecutionInput): Promise<boolean> {
    const config = this.runConfig(input);
    try {
      this.supported(); const spec = environmentSpecSchema.parse(input.environmentBuild?.spec);
      const signal = AbortSignal.timeout(90_000); await this.owned(input.run.id, signal);
      const imageId = await this.imageId(config.image, signal);
      if (config.releaseCatalog && imageId !== config.image) throw new Error('환경 재개 이미지가 Run pin과 다릅니다.');
      // Recovery probes precede the model lease, just like the session probe.
      // Never infer a full default model allocation for this read-only check.
      const probeInput = { ...input, resources: { memoryMiB: 256, cpus: 0.2 } };
      bundleSchema.parse(await this.helper(probeInput, input.run.id, imageId, 'verify', { spec }, signal));
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RUNTIME_CLEANUP_PENDING') throw error;
      return false;
    }
  }

  call(input: ExecutionInput, raw: EnvironmentToolCall, signal: AbortSignal): Promise<unknown> {
    const selected = this.selection(input), call = environmentCallSchema.parse(raw);
    if (!selected.spec.servers.some(server => server.name === call.server) || !selected.report.tools.some(tool => tool.server === call.server && tool.name === call.tool)) throw new Error('선택된 환경에 없는 MCP 도구입니다.');
    const runId = input.run.id;
    const pending = (this.calls.get(runId) ?? Promise.resolve()).then(async () => {
      signal.throwIfAborted(); await this.owned(selected.buildRunId, signal);
      if (await this.imageId(selected.report.imageId, signal) !== selected.report.imageId) throw new Error('선택된 환경 이미지가 일치하지 않습니다.');
      const value = calledSchema.parse(await this.helper(input, selected.buildRunId, selected.report.imageId, 'call', { spec: selected.spec, expected: selected.report, call }, signal));
      if (value.contentHash !== selected.report.contentHash || value.lockfileHash !== selected.report.lockfileHash) throw new Error('MCP 환경 콘텐츠가 변경됐습니다.');
      return { ...value.result, sessionMode: value.sessionMode };
    });
    const settled = pending.then(() => undefined, () => undefined); this.calls.set(runId, settled);
    return pending.finally(() => { if (this.calls.get(runId) === settled) this.calls.delete(runId); });
  }
}
