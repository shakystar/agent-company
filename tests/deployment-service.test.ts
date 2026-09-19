import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { WorkspaceStore } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, Run, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';

const output: ExecutionResult = { result: '보존된 결과', artifacts: [], memories: [], skills: [], inputTokens: 10, outputTokens: 2, appliedSteeringCount: 0 };
const pin = { image: `sha256:${'1'.repeat(64)}`, manifestId: '2'.repeat(64) };
class Runtime implements RuntimeDriver {
  defaultReleasePin = pin;
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; resolve: (value: ExecutionResult) => void; reject: (error: Error) => void }> = [];
  idleError: string | null = null;
  pinError = false;
  confirmations = 0;
  settlements = 0;
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', simulation: true, available: true, authenticated: true, image: pin.image, model: 'test', message: 'simulation', version: 'test' }; }
  async validateRunRelease(run: Run) {
    if (this.pinError || !run.runtimeRelease) throw Object.assign(new Error('고정 이미지가 없습니다.'), { code: 'RUNTIME_RELEASE_BLOCKED' });
  }
  async confirmDeploymentIdle() { this.confirmations++; if (this.idleError) throw new Error(this.idleError); }
  async settle() { this.settlements++; }
  async canResume(input: ExecutionInput) { return Boolean(input.checkpoint || input.previousResult); }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      hooks.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
      this.calls.push({ input, hooks, resolve, reject });
    });
  }
}
const scheduler = () => new ResourceScheduler({ capacity: { cpus: 1, memoryMiB: 1024 }, defaultRequest: {
  minimum: { cpus: 1, memoryMiB: 1024 }, preferred: { cpus: 1, memoryMiB: 1024 },
} });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('state timeout'); await delay(10); }
}

test('deployment drains the admitted turn, preserves queued work, and prevents the next model phase', async () => {
  const runtime = new Runtime(), resources = scheduler();
  const service = await AgentService.create({ runtime, scheduler: resources });
  try {
    const a = await service.createAgent({ name: '실행 중', persona: 'test' });
    const b = await service.createAgent({ name: '입장 대기', persona: 'test' });
    const first = await service.startRun(a.id, '현재 턴'), queued = await service.startRun(b.id, '다음 작업');
    await until(() => runtime.calls.length === 1 && resources.snapshot().waiting.length === 1);
    const call = runtime.calls[0];
    await call.hooks.beforeModelStart!({ runId: first.id, phase: 'task', kind: 'test', reason: 'test' });
    assert.equal((await service.prepareDeployment()).phase, 'draining');
    assert.throws(() => call.hooks.assertModelStart!(), { code: 'DEPLOYMENT_PAUSED' });
    assert.equal(call.hooks.signal.aborted, false, 'admitted worker must finish its turn');
    await until(() => resources.snapshot().waiting.length === 0);
    await call.hooks.onCheckpoint!({ phase: 'evaluate', sessionId: 'original-session', previousResult: output, appliedSteeringCount: 0 });
    try {
      await call.hooks.beforeModelStart!({ runId: first.id, phase: 'evaluate', kind: 'test', reason: 'next phase' });
      assert.fail('new model phase was admitted');
    } catch (error) { assert.equal((error as { code: string }).code, 'DEPLOYMENT_PAUSED'); call.reject(error as Error); }
    await until(async () => (await service.deploymentStatus()).phase === 'ready');
    const state = await service.workspace();
    for (const id of [first.id, queued.id]) {
      const run = state.runs.find(item => item.id === id)!;
      assert.equal(run.status, 'queued'); assert.equal(run.error, null); assert.equal(run.completedAt, null);
      assert.deepEqual(run.runtimeRelease, pin);
    }
    assert.equal(state.runs.length, 2); assert.equal(resources.snapshot().reserved.memoryMiB, 0);
    assert.equal(runtime.calls.length, 1); assert.equal(state.deployment!.pendingRunCount, 2);
    await service.resumeDeployment();
    await until(() => runtime.calls.length === 2);
    const next = runtime.calls[1];
    if (next.input.run.id === first.id) assert.equal(next.input.checkpoint!.sessionId, 'original-session');
  } finally { await service.close(); }
});

test('completed current turn is committed during hold without waiting for every task to finish', async () => {
  const runtime = new Runtime(); const service = await AgentService.create({ runtime });
  try {
    const a = await service.createAgent({ name: '완료', persona: 'test' });
    const run = await service.startRun(a.id, '완료 저장');
    await until(() => runtime.calls.length === 1); await service.prepareDeployment();
    runtime.calls[0].resolve(output);
    await until(async () => (await service.deploymentStatus()).phase === 'ready');
    const saved = (await service.workspace()).runs.find(item => item.id === run.id)!;
    assert.equal(saved.status, 'succeeded'); assert.equal(saved.result, output.result); assert.equal(saved.error, null);
  } finally { await service.close(); }
});

test('cleanup uncertainty prevents ready and retries without starting a model', async () => {
  const runtime = new Runtime(); runtime.idleError = '이전 helper 종료 확인 대기';
  const service = await AgentService.create({ runtime, prepareDeployment: true });
  try {
    await until(async () => (await service.deploymentStatus()).phase === 'blocked');
    assert.equal((await service.deploymentStatus()).readyAt, null); assert.equal(runtime.calls.length, 0);
    runtime.idleError = null;
    await until(async () => (await service.deploymentStatus()).phase === 'ready');
    assert.ok(runtime.confirmations >= 2);
  } finally { await service.close(); }
});

test('existing external helper must finish before readiness; new external admission is refused', async () => {
  const runtime = new Runtime(); const service = await AgentService.create({ runtime });
  try {
    const release = service.admitExternalRequest(); await service.prepareDeployment();
    assert.throws(() => service.admitExternalRequest(), /배포 준비/);
    await delay(350); assert.equal((await service.deploymentStatus()).phase, 'draining');
    assert.equal(runtime.confirmations, 0); release(); release();
    await until(async () => (await service.deploymentStatus()).phase === 'ready');
  } finally { await service.close(); }
});

test('hold and original checkpoint survive restart and require explicit resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-deployment-'));
  const runtime = new Runtime(); let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, dataDir: directory });
    const agent = await service.createAgent({ name: '재시작', persona: 'test' });
    const run = await service.startRun(agent.id, '고정 입력');
    await until(() => runtime.calls.length === 1);
    await runtime.calls[0].hooks.onCheckpoint!({ phase: 'task', sessionId: 'retained' });
    await service.prepareDeployment(); await service.close(); service = undefined;
    const store = await WorkspaceStore.open(directory);
    const before = await store.read(); await store.close();
    assert.ok(before.deploymentHold); assert.equal(before.runs[0].status, 'queued');
    const replacement = new Runtime(); replacement.idleError = 'new controller must recheck';
    service = await AgentService.create({ runtime: replacement, dataDir: directory });
    await until(async () => (await service!.deploymentStatus()).phase === 'blocked');
    assert.equal(replacement.calls.length, 0); assert.equal((await service.workspace()).runs[0].snapshotId, run.snapshotId);
    replacement.idleError = null;
    await until(async () => (await service!.deploymentStatus()).phase === 'ready');
    await service.resumeDeployment(); await until(() => replacement.calls.length === 1);
    assert.equal(replacement.calls[0].input.run.id, run.id);
    assert.equal(replacement.calls[0].input.checkpoint!.sessionId, 'retained');
    assert.deepEqual(replacement.calls[0].input.run.runtimeRelease, pin);
  } finally {
    await service?.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /agent-company-deployment-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
  }
});

test('missing image is held without model failure retries; resume cannot reopen until validated', async () => {
  const runtime = new Runtime(); runtime.pinError = true;
  const service = await AgentService.create({ runtime });
  try {
    const agent = await service.createAgent({ name: '이미지 검사', persona: 'test' });
    await service.startRun(agent.id, '보존');
    await until(async () => Boolean((await service.workspace()).runs[0].runtimeReleaseBlockedReason));
    await delay(50);
    const run = (await service.workspace()).runs[0];
    assert.equal(run.status, 'queued'); assert.equal(run.attempt, 0); assert.equal(run.error, null); assert.equal(runtime.calls.length, 0);
    await service.prepareDeployment(); await assert.rejects(service.resumeDeployment(), /고정 이미지/);
    assert.notEqual((await service.deploymentStatus()).phase, 'running');
    runtime.pinError = false; await service.resumeDeployment(); await until(() => runtime.calls.length === 1);
  } finally { await service.close(); }
});

test('HTTP hold permits status and resume, refuses new work and malformed or cross-site prepare', async () => {
  const runtime = new Runtime(); const app = await createApp({ runtime });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/deployment/prepare', payload: { force: true } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/deployment/prepare', headers: { origin: 'https://outside.example' }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/deployment/prepare', payload: {} })).statusCode, 200);
    assert.equal((await app.inject('/api/workspace')).statusCode, 200);
    assert.equal((await app.inject('/api/deployment')).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'blocked', persona: 'test' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/deployment/resume', payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'accepted', persona: 'test' } })).statusCode, 201);
    assert.equal(runtime.calls.length, 0);
  } finally { await app.close(); }
});

test('restoring a held backup rechecks readiness and does not clear the separate restore pause', async () => {
  class RestoreRuntime extends StorageFixtureRuntime {
    async confirmDeploymentIdle() {}
    override forkWorkspace(key: string) { return new RestoreRuntime(key, this.spaces, this.calls); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-deployment-'));
  const ownerKey = randomUUID(), runtime = new RestoreRuntime(ownerKey);
  const storage = { rootDir: join(directory, 'workspace'), backupDir: join(directory, 'backups'), ownerKey, freeSpace: async () => 100 * 1024 ** 3 };
  const service = await AgentService.create({ runtime, storage, dataDir: join(storage.rootDir, 'db') });
  try {
    const agent = await service.createAgent({ name: '보존 원본', persona: 'test' });
    await service.prepareDeployment(); await until(async () => (await service.deploymentStatus()).phase === 'ready');
    const originalReady = (await service.deploymentStatus()).readyAt;
    const backup = (await service.createBackup()).backups[0];
    await service.resumeDeployment(); await service.updateAgent(agent.id, { name: '복원 전' });
    const staged = await service.prepareRestore(backup.id); await service.activateRestore(staged.id);
    await until(async () => (await service.deploymentStatus()).phase === 'ready');
    assert.notEqual((await service.deploymentStatus()).readyAt, originalReady);
    assert.equal((await service.workspace()).agents[0].name, '보존 원본');
    await service.resumeDeployment(); assert.equal((await service.storageStatus()).paused, true);
    assert.equal(runtime.calls.length, 0);
  } finally {
    await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /agent-company-deployment-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
  }
});

test('deployment cancels storage inventory admission without starting or failing the preserved Run', async () => {
  class AdmissionRuntime extends StorageFixtureRuntime {
    admissionSignal?: AbortSignal;
    override forkWorkspace(key: string): StorageFixtureRuntime { return key === this.key ? this : super.forkWorkspace(key); }
    override async listWorkspaceVolumes(signal?: AbortSignal) {
      if (!signal) return super.listWorkspaceVolumes();
      this.admissionSignal = signal; signal.throwIfAborted();
      return new Promise<Array<{ runId: string; bytes: number; files: number }>>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    async confirmDeploymentIdle() { assert.equal(this.admissionSignal?.aborted, true); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-deployment-'));
  const ownerKey = randomUUID(), runtime = new AdmissionRuntime(ownerKey);
  const storage = { rootDir: join(directory, 'workspace'), backupDir: join(directory, 'backups'), ownerKey, freeSpace: async () => 100 * 1024 ** 3 };
  const service = await AgentService.create({ runtime, storage, dataDir: join(storage.rootDir, 'db') });
  try {
    const agent = await service.createAgent({ name: '입장 조사', persona: 'test' });
    const run = await service.startRun(agent.id, '보존되는 작업');
    await until(() => Boolean(runtime.admissionSignal));
    await service.prepareDeployment();
    await until(async () => (await service.deploymentStatus()).phase === 'ready');
    const saved = (await service.workspace()).runs.find(item => item.id === run.id)!;
    assert.equal(runtime.calls.length, 0); assert.equal(saved.status, 'queued'); assert.equal(saved.error, null);
    assert.equal(saved.startedAt, null); assert.equal(saved.attempt ?? 0, 0);
  } finally {
    await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /agent-company-deployment-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
  }
});
