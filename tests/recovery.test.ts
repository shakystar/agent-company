import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';
import { AgentService } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';

const result = (text = '완료'): ExecutionResult => ({ result: text, appliedSteeringCount: 0,
  memories: [{ kind: 'fact', title: '보존된 결과', content: text }], skills: [], artifacts: [], inputTokens: 10, outputTokens: 5 });
const scheduler = () => new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
  defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });

class Runtime implements RuntimeDriver {
  resumable = true;
  rejectOnAbort = true;
  cleanupBlocked = false;
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; resolve: (output: ExecutionResult) => void; reject: (error: Error) => void }> = [];
  async inspect(): Promise<RuntimeInfo> {
    return { mode: 'docker', available: true, authenticated: true, image: 'test-only', model: 'test-only',
      message: '명시적 테스트 실행기', version: 'test-only' };
  }
  async canResume(input: ExecutionInput): Promise<boolean> {
    return this.resumable && Boolean(input.checkpoint || input.previousResult);
  }
  async settle(): Promise<void> {
    if (this.cleanupBlocked) throw new Error('실행 환경 종료 확인 실패');
  }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolveOutput, reject) => {
      const abort = () => { if (this.rejectOnAbort) reject(new Error('컨트롤러 연결 중단')); };
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks,
        resolve: (output) => { hooks.signal.removeEventListener('abort', abort); resolveOutput(output); },
        reject: (error) => { hooks.signal.removeEventListener('abort', abort); reject(error); } });
    });
  }
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('테스트 상태 대기 초과');
    await delay(5);
  }
}

async function removeTestDirectory(directory: string): Promise<void> {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(directory, /agent-company-recovery-[^\\/]+$/);
  await rm(directory, { recursive: true, force: true });
}

for (const boundary of ['before-lease', 'after-lease', 'cancel-after-lease'] as const) {
  test(`session probe cleanup retries without a resource lease and preserves continuation: ${boundary}`, async () => {
    class ProbeRuntime extends Runtime {
      probeBlocked = false;
      pendingProbe = false;
      cleanupRetries = 0;
      override async canResume(input: ExecutionInput): Promise<boolean> {
        if (this.probeBlocked) {
          this.pendingProbe = true;
          throw Object.assign(new Error('세션 확인 환경 정리 대기'), { code: 'RUNTIME_CLEANUP_PENDING' });
        }
        assert.equal(this.pendingProbe, false, 'Do not probe again until cleanup is confirmed');
        return super.canResume(input);
      }
      override async settle(): Promise<void> {
        if (this.pendingProbe) {
          this.cleanupRetries++;
          if (this.probeBlocked) throw new Error('세션 확인 환경 종료 확인 실패');
          this.pendingProbe = false;
        }
        await super.settle();
      }
    }
    const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
    const runtime = new ProbeRuntime();
    let resources = scheduler(), service: AgentService | undefined;
    try {
      service = await AgentService.create({ runtime, scheduler: resources, dataDir: directory });
      const agent = await service.createAgent({ name: '자원 없는 세션 정리', persona: '상태 보존' });
      const run = await service.startRun(agent.id, '세션 그대로 재개');
      await until(async () => runtime.calls.length === 1);
      await runtime.calls[0].hooks.onCheckpoint!({ phase: 'task', sessionId: 'preserved-session', appliedSteeringCount: 0 });
      if (boundary === 'before-lease') {
        await service.close(); service = undefined;
        resources = scheduler(); runtime.probeBlocked = true;
        service = await AgentService.create({ runtime, scheduler: resources, dataDir: directory });
      } else {
        runtime.probeBlocked = true;
        runtime.calls[0].reject(new Error('worker connection interrupted'));
      }
      await until(async () => Boolean((await service!.workspace()).runs[0].cleanupPending));
      const queued = (await service.workspace()).runs[0];
      assert.equal(queued.status, 'queued'); assert.equal(queued.error, null); assert.equal(queued.completedAt, null);
      assert.equal(resources.snapshot().reserved.memoryMiB, 0);
      assert.equal(runtime.calls.length, 1); assert.equal(runtime.cleanupRetries, 1);
      if (boundary === 'cancel-after-lease') await service.cancelRun(run.id);
      runtime.probeBlocked = false;
      await until(async () => runtime.cleanupRetries >= 2 && !runtime.pendingProbe);
      if (boundary === 'cancel-after-lease') {
        await until(async () => !(await service!.workspace()).runs[0].cleanupPending);
        assert.equal((await service.workspace()).runs[0].status, 'cancelled');
        assert.equal(runtime.calls.length, 1);
      } else {
        await until(async () => runtime.calls.length === 2);
        assert.equal(runtime.calls[1].input.run.id, run.id);
        assert.equal(runtime.calls[1].input.checkpoint!.sessionId, 'preserved-session');
        runtime.calls[1].resolve(result());
        await until(async () => (await service!.workspace()).runs[0].status === 'succeeded');
        assert.equal((await service.workspace()).runs.length, 1);
      }
    } finally {
      runtime.probeBlocked = false;
      await service?.close(); await removeTestDirectory(directory);
    }
  });
}

test('probe cleanup pauses cannot bypass the default three-failure model retry bound', async () => {
  class ProbeRuntime extends Runtime {
    probeBlocked = false;
    pendingProbe = false;
    override async canResume(input: ExecutionInput): Promise<boolean> {
      if (this.probeBlocked) {
        this.pendingProbe = true;
        throw Object.assign(new Error('세션 확인 환경 정리 대기'), { code: 'RUNTIME_CLEANUP_PENDING' });
      }
      assert.equal(this.pendingProbe, false);
      return super.canResume(input);
    }
    override async settle(): Promise<void> {
      if (this.pendingProbe && this.probeBlocked) throw new Error('세션 확인 환경 종료 확인 실패');
      this.pendingProbe = false;
      await super.settle();
    }
  }
  const runtime = new ProbeRuntime(), resources = scheduler();
  const service = await AgentService.create({ runtime, scheduler: resources });
  try {
    const agent = await service.createAgent({ name: '재시도 상한', persona: '상태 보존' });
    const run = await service.startRun(agent.id, '정리 대기에도 재시도 횟수 보존');
    for (let index = 0; index < 3; index++) {
      await until(async () => runtime.calls.length === index + 1);
      await runtime.calls[index].hooks.onCheckpoint!({ phase: 'task', sessionId: 'same-session', appliedSteeringCount: 0 });
      runtime.probeBlocked = true;
      runtime.calls[index].reject(new Error(`모델 실행 실패 ${index + 1}`));
      await until(async () => Boolean((await service.workspace()).runs[0].cleanupPending));
      assert.equal((await service.workspace()).runs[0].status, 'queued');
      assert.equal(resources.snapshot().reserved.memoryMiB, 0);
      runtime.probeBlocked = false;
      await until(async () => !(await service.workspace()).runs[0].cleanupPending);
    }
    await until(async () => (await service.workspace()).runs[0].status === 'failed');
    const stopped = (await service.workspace()).runs[0];
    assert.equal(stopped.id, run.id); assert.equal(stopped.attempt, 3);
    assert.match(stopped.error!, /3회 시도 한도/);
    assert.equal(runtime.calls.length, 3); assert.equal(resources.snapshot().reserved.memoryMiB, 0);
    assert.equal(runtime.calls.slice(1).every(call => call.input.checkpoint?.sessionId === 'same-session'), true);
  } finally { runtime.probeBlocked = false; await service.close(); }
});

test('resource queue cancellation and worker cleanup preserve the shared budget', async () => {
  const runtime = new Runtime(); runtime.rejectOnAbort = false;
  const resources = scheduler();
  const service = await AgentService.create({ runtime, scheduler: resources });
  try {
    const agents = await Promise.all(['첫째', '둘째', '셋째'].map((name) => service.createAgent({ name, persona: name })));
    const first = await service.startRun(agents[0].id, '먼저 실행');
    await until(async () => runtime.calls.length === 1);
    assert.deepEqual(runtime.calls[0].input.resources, { memoryMiB: 1024, cpus: 1 });
    const second = await service.startRun(agents[1].id, '대기 중 취소');
    await until(async () => resources.snapshot().waiting.length === 1);
    assert.equal((await service.workspace()).runs.find(run => run.id === second.id)!.status, 'queued');
    await service.cancelRun(second.id);
    await until(async () => resources.snapshot().waiting.length === 0);
    assert.equal(runtime.calls.length, 1);
    const third = await service.startRun(agents[2].id, '정리 이후 실행');
    await until(async () => resources.snapshot().waiting.length === 1);
    await service.cancelRun(first.id);
    assert.equal(resources.snapshot().reserved.memoryMiB, 1024);
    assert.equal(runtime.calls.length, 1);
    runtime.calls[0].reject(new Error('정리 완료'));
    await until(async () => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.run.id, third.id);
    runtime.calls[1].resolve(result());
    await until(async () => (await service.workspace()).runs.find(run => run.id === third.id)!.status === 'succeeded');
    assert.equal(resources.snapshot().reserved.memoryMiB, 0);
    assert.equal('executionStates' in await service.workspace(), false);
  } finally {
    runtime.rejectOnAbort = true;
    for (const call of runtime.calls) call.reject(new Error('테스트 정리'));
    await service.close();
  }
});

test('controller shutdown preserves checkpoint, immutable input and progress for automatic continuation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
  const runtime = new Runtime();
  let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler(), recovery: { maxAttempts: 1 } });
    const agent = await service.createAgent({ name: '복구', persona: '실행 시작 당시 페르소나' });
    const run = await service.startRun(agent.id, '진행 상태 보존');
    await until(async () => runtime.calls.length === 1);
    await runtime.calls[0].hooks.onEvent('파일 저장까지 완료');
    await runtime.calls[0].hooks.onCheckpoint!({ phase: 'task', sessionId: 'session-1', appliedSteeringCount: 0 });
    await service.updateAgent(agent.id, { persona: '다음 작업용 페르소나' });
    await service.close(); service = undefined;
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler(), recovery: { maxAttempts: 1 } });
    await until(async () => runtime.calls.length === 2);
    const resumed = runtime.calls[1];
    assert.equal(resumed.input.run.id, run.id);
    assert.equal(resumed.input.agent.persona, '실행 시작 당시 페르소나');
    assert.equal(resumed.input.checkpoint!.sessionId, 'session-1');
    assert.equal(resumed.input.run.progress!.message, '파일 저장까지 완료');
    assert.equal(resumed.input.run.attempt, 2);
    resumed.resolve(result());
    await until(async () => (await service!.workspace()).runs[0].status === 'succeeded');
    const state = await service.workspace();
    assert.equal(state.memories.length, 1);
    assert.equal(state.snapshots.filter(item => item.sourceRunId === run.id).length, 1);
  } finally { await service?.close(); await removeTestDirectory(directory); }
});

test('unstarted queued jobs resume without a model checkpoint and retain steering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
  const runtime = new Runtime();
  const resources = scheduler();
  const occupied = await resources.acquire('test-budget-holder');
  let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: resources });
    const agent = await service.createAgent({ name: '대기 복구', persona: '대기 복구' });
    const run = await service.startRun(agent.id, '아직 실행하지 않은 작업');
    await service.steerRun(run.id, '첫 실행에 포함');
    await until(async () => resources.snapshot().waiting.length === 1);
    await service.close(); service = undefined; occupied.release();
    assert.equal(runtime.calls.length, 0);
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    await until(async () => runtime.calls.length === 1);
    assert.deepEqual(runtime.calls[0].input.run.steering, ['첫 실행에 포함']);
    assert.equal(runtime.calls[0].input.run.attempt, 1);
    runtime.calls[0].resolve({ ...result(), appliedSteeringCount: 1 });
    await until(async () => (await service!.workspace()).runs[0].status === 'succeeded');
  } finally { occupied.release(); await service?.close(); await removeTestDirectory(directory); }
});

test('completed checkpoint commits once without repeating the model, including after a second restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
  const runtime = new Runtime();
  let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    const agent = await service.createAgent({ name: '완료 복구', persona: '완료 복구' });
    const run = await service.startRun(agent.id, '모델 재호출 금지');
    await until(async () => runtime.calls.length === 1);
    await runtime.calls[0].hooks.onCheckpoint!({ phase: 'complete', previousResult: result(), appliedSteeringCount: 0 });
    await service.close(); service = undefined;
    runtime.resumable = false;
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    await until(async () => (await service!.workspace()).runs[0].status === 'succeeded');
    assert.equal(runtime.calls.length, 1);
    assert.equal((await service.workspace()).runs[0].inputTokens, 10);
    await service.close(); service = undefined;
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    const state = await service.workspace();
    assert.equal(state.snapshots.filter(item => item.sourceRunId === run.id).length, 1);
    assert.equal(state.memories.length, 1); assert.equal(runtime.calls.length, 1);
  } finally { await service?.close(); await removeTestDirectory(directory); }
});

test('steering accepted after a complete checkpoint continues the saved result on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
  const runtime = new Runtime();
  let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    const agent = await service.createAgent({ name: '추가 지시 복구', persona: '추가 지시 복구' });
    const run = await service.startRun(agent.id, '최초 작업');
    await until(async () => runtime.calls.length === 1);
    await runtime.calls[0].hooks.onCheckpoint!({ phase: 'complete', previousResult: result('최초 완료'), appliedSteeringCount: 0 });
    await service.steerRun(run.id, '새 지시');
    await service.close(); service = undefined;
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    await until(async () => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.previousResult!.result, '최초 완료');
    assert.deepEqual(runtime.calls[1].input.run.steering, ['새 지시']);
    runtime.calls[1].resolve({ ...result('최종 완료'), appliedSteeringCount: 1 });
    await until(async () => (await service!.workspace()).runs[0].status === 'succeeded');
    const state = await service.workspace();
    assert.equal(state.runs[0].inputTokens, 20);
    assert.deepEqual(state.memories.map(item => item.content), ['최종 완료']);
  } finally { await service?.close(); await removeTestDirectory(directory); }
});

test('checkpoint-backed failures retry with a bound, preserving progress and returning leases', async () => {
  const runtime = new Runtime(); const resources = scheduler();
  const service = await AgentService.create({ runtime, scheduler: resources, recovery: { maxAttempts: 3, retryDelayMs: 10 } });
  try {
    const agent = await service.createAgent({ name: '재시도', persona: '재시도' });
    await service.startRun(agent.id, '복구 시도');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await until(async () => runtime.calls.length === attempt + 1);
      await runtime.calls[attempt].hooks.onCheckpoint!({ phase: 'task', sessionId: 'session-1' });
      await runtime.calls[attempt].hooks.onEvent(`시도 ${attempt + 1}`);
      runtime.calls[attempt].reject(new Error('전송 중단'));
    }
    await until(async () => (await service.workspace()).runs[0].status === 'failed');
    const state = await service.workspace();
    assert.equal(state.runs[0].attempt, 3);
    assert.equal(state.runs[0].progress!.message, '시도 3');
    assert.equal(state.memories.length, 0);
    assert.equal(resources.snapshot().running.length, 0);
    assert.equal(state.activities.filter(item => item.title === '자동 재개 대기').length, 2);
  } finally { await service.close(); }
});

test('explicit cancellation survives restart even when a valid checkpoint exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
  const runtime = new Runtime();
  let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    const agent = await service.createAgent({ name: '취소 보존', persona: '취소 보존' });
    const run = await service.startRun(agent.id, '취소할 작업');
    await until(async () => runtime.calls.length === 1);
    await runtime.calls[0].hooks.onCheckpoint!({ phase: 'task', sessionId: 'session-1' });
    await service.cancelRun(run.id);
    await service.close(); service = undefined;
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    assert.equal((await service.workspace()).runs[0].status, 'cancelled');
    assert.equal(runtime.calls.length, 1);
  } finally { await service?.close(); await removeTestDirectory(directory); }
});

test('unconfirmed recovery state is preserved but never replays the original task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
  const runtime = new Runtime();
  let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    const agent = await service.createAgent({ name: '검증되지 않은 세션', persona: '검증되지 않은 세션' });
    await service.startRun(agent.id, '반복하면 안 되는 작업');
    await until(async () => runtime.calls.length === 1);
    await runtime.calls[0].hooks.onCheckpoint!({ phase: 'task', sessionId: 'missing-workspace' });
    await runtime.calls[0].hooks.onEvent('마지막 확인된 진행 상태');
    await service.close(); service = undefined;
    runtime.resumable = false;
    service = await AgentService.create({ runtime, dataDir: directory, scheduler: scheduler() });
    await until(async () => (await service!.workspace()).runs[0].status === 'failed');
    const state = await service.workspace();
    assert.equal(runtime.calls.length, 1);
    assert.match(state.runs[0].error!, /안전하게 재개할 수 없습니다/);
    assert.equal(state.runs[0].progress!.message, '마지막 확인된 진행 상태');
    assert.equal(state.memories.length, 0);
  } finally { await service?.close(); await removeTestDirectory(directory); }
});

test('uncertain cleanup quarantines capacity and agents until background confirmation without replay', async () => {
  const runtime = new Runtime(); const resources = scheduler();
  const service = await AgentService.create({ runtime, scheduler: resources });
  try {
    const firstAgent = await service.createAgent({ name: '정리 격리', persona: '정리 격리' });
    const secondAgent = await service.createAgent({ name: '자원 대기', persona: '자원 대기' });
    const first = await service.startRun(firstAgent.id, '완료 결과 보존');
    await until(async () => runtime.calls.length === 1);
    runtime.cleanupBlocked = true;
    runtime.calls[0].resolve(result());
    await until(async () => (await service.workspace()).runs.find(run => run.id === first.id)!.status === 'succeeded');
    let state = await service.workspace();
    assert.equal(state.agents.find(agent => agent.id === firstAgent.id)!.status, 'running');
    assert.match(state.runs.find(run => run.id === first.id)!.cleanupPending!, /종료 확인 실패/);
    assert.equal(resources.snapshot().reserved.memoryMiB, 1024);
    await assert.rejects(service.startRun(firstAgent.id, '정리 전에 같은 에이전트 실행'), /실행 중인 작업/);
    const second = await service.startRun(secondAgent.id, '자원 반환 후 실행');
    await until(async () => resources.snapshot().waiting.length === 1);
    assert.equal(runtime.calls.length, 1);
    runtime.cleanupBlocked = false;
    await until(async () => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.run.id, second.id);
    state = await service.workspace();
    assert.equal(state.runs.find(run => run.id === first.id)!.cleanupPending, null);
    assert.equal(state.agents.find(agent => agent.id === firstAgent.id)!.status, 'idle');
    runtime.calls[1].resolve(result());
    await until(async () => (await service.workspace()).runs.find(run => run.id === second.id)!.status === 'succeeded');
    assert.equal(runtime.calls.filter(call => call.input.run.id === first.id).length, 1);
  } finally { runtime.cleanupBlocked = false; await service.close(); }
});

test('late steering continuation waits for quarantined cleanup instead of rerunning or losing instructions', async () => {
  const runtime = new Runtime(); const resources = scheduler();
  const service = await AgentService.create({ runtime, scheduler: resources });
  try {
    const agent = await service.createAgent({ name: '정리 중 지시', persona: '정리 중 지시' });
    const run = await service.startRun(agent.id, '최초 작업');
    await until(async () => runtime.calls.length === 1);
    await service.steerRun(run.id, '늦은 지시');
    runtime.cleanupBlocked = true;
    runtime.calls[0].resolve(result('최초 완료'));
    await until(async () => (await service.workspace()).runs[0].status === 'queued');
    assert.equal(runtime.calls.length, 1);
    assert.equal(resources.snapshot().reserved.memoryMiB, 1024);
    runtime.cleanupBlocked = false;
    await until(async () => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.previousResult!.result, '최초 완료');
    assert.deepEqual(runtime.calls[1].input.run.steering, ['늦은 지시']);
    runtime.calls[1].resolve({ ...result('지시 반영'), appliedSteeringCount: 1 });
    await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
    assert.equal((await service.workspace()).runs[0].inputTokens, 20);
    assert.equal(resources.snapshot().reserved.memoryMiB, 0);
  } finally { runtime.cleanupBlocked = false; await service.close(); }
});

test('startup cleanup gates resume probes, completed checkpoints and new runs while keeping reads available', async () => {
  class RecoveringRuntime extends Runtime {
    recoveryBlocked = true;
    recoverCalls = 0;
    resumeCalls = 0;
    async recover(): Promise<void> {
      this.recoverCalls += 1;
      if (this.recoveryBlocked) throw new Error('이전 컨테이너 종료 미확인');
    }
    override async canResume(input: ExecutionInput): Promise<boolean> {
      this.resumeCalls += 1;
      return super.canResume(input);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-recovery-'));
  const previous = new Runtime();
  const restored = new RecoveringRuntime();
  let service: AgentService | undefined;
  try {
    const twoWorkers = new ResourceScheduler({ capacity: { memoryMiB: 2048, cpus: 2 },
      defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });
    service = await AgentService.create({ runtime: previous, dataDir: directory, scheduler: twoWorkers });
    const taskAgent = await service.createAgent({ name: '세션 재개 대기', persona: '세션 재개 대기' });
    const completeAgent = await service.createAgent({ name: '완료 저장 대기', persona: '완료 저장 대기' });
    const task = await service.startRun(taskAgent.id, '세션 이어가기');
    const complete = await service.startRun(completeAgent.id, '완료 체크포인트 저장');
    await until(async () => previous.calls.length === 2);
    const taskCall = previous.calls.find(call => call.input.run.id === task.id)!;
    const completeCall = previous.calls.find(call => call.input.run.id === complete.id)!;
    await taskCall.hooks.onCheckpoint!({ phase: 'task', sessionId: 'preserved-session' });
    await completeCall.hooks.onCheckpoint!({ phase: 'complete', previousResult: result('이미 완료'), appliedSteeringCount: 0 });
    previous.cleanupBlocked = true;
    await service.close(); service = undefined;

    service = await AgentService.create({ runtime: restored, dataDir: directory, scheduler: scheduler() });
    let state = await service.workspace();
    assert.equal(state.runtime.available, false);
    assert.match(state.runtime.message, /이전 컨테이너 종료 미확인/);
    assert.equal(state.runs.every(run => run.status === 'queued'), true);
    assert.equal(state.runs.every(run => Boolean(run.cleanupPending)), true);
    assert.equal(state.memories.length, 0);
    assert.equal(restored.resumeCalls, 0);
    assert.equal(restored.calls.length, 0);
    const newAgent = await service.createAgent({ name: '정리 중 생성 가능', persona: '정리 중 생성 가능' });
    await assert.rejects(service.startRun(newAgent.id, '정리 전에 실행 금지'), /정리 확인 전/);
    // Workspace reads never trigger infrastructure cleanup or recovery probes.
    await service.workspace(); await service.workspace();
    assert.equal(restored.recoverCalls, 1);

    restored.recoveryBlocked = false;
    await until(async () => restored.calls.length === 1);
    assert.equal(restored.calls[0].input.run.id, task.id);
    assert.equal(restored.calls[0].input.checkpoint!.sessionId, 'preserved-session');
    await until(async () => (await service!.workspace()).runs.find(run => run.id === complete.id)!.status === 'succeeded');
    state = await service.workspace();
    assert.equal(state.runtime.available, true);
    assert.equal(state.runs.every(run => run.cleanupPending === null), true);
    assert.equal(restored.recoverCalls, 2);
    assert.equal(restored.resumeCalls, 1);
    assert.equal(restored.calls.filter(call => call.input.run.id === complete.id).length, 0);
    restored.calls[0].resolve(result('재개 완료'));
    await until(async () => (await service!.workspace()).runs.find(run => run.id === task.id)!.status === 'succeeded');
    const newRun = await service.startRun(newAgent.id, '정리 확인 후 실행');
    await until(async () => restored.calls.length === 2);
    assert.equal(restored.calls[1].input.run.id, newRun.id);
    restored.calls[1].resolve(result());
    await until(async () => (await service!.workspace()).runs.find(run => run.id === newRun.id)!.status === 'succeeded');
  } finally { await service?.close(); await removeTestDirectory(directory); }
});
