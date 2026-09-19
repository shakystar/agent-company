import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo, Workspace } from '../shared/types.ts';

const result: ExecutionResult = { result: '완료', memories: [], skills: [], artifacts: [], inputTokens: 1, outputTokens: 1 };
class FileRuntime implements RuntimeDriver {
  readonly workspacePersistence = true;
  readonly files = new Map<string, Record<string, string>>();
  readonly calls: { input: ExecutionInput; resolve: (value: ExecutionResult) => void; reject: (error: Error) => void }[] = [];
  async inspect(): Promise<RuntimeInfo> {
    return { mode: 'docker', available: true, authenticated: true, image: 'fake-file-runtime', model: 'test', version: 'test', message: '파일 버전 연결 테스트 실행기입니다.' };
  }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const source = input.run.workspaceSourceRunId;
    assert.ok(!source || this.files.has(source), 'a source must refer to a real completed file version');
    this.files.set(input.run.id, structuredClone(source ? this.files.get(source)! : {}));
    return new Promise((resolve, reject) => {
      this.calls.push({ input, resolve, reject });
      hooks.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  }
  async listWorkspace(runId: string) {
    return { path: '', entries: Object.entries(this.files.get(runId)!).map(([path, text]) => ({ path, name: path, type: 'file', size: Buffer.byteLength(text) })), truncated: false };
  }
  async readWorkspace(runId: string, path: string) {
    const text = this.files.get(runId)![path];
    assert.notEqual(text, undefined);
    return { path, text, bytes: Buffer.byteLength(text) };
  }
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error('workspace lifecycle test timed out');
    await setTimeout(5);
  }
}

async function fixture(t: TestContext) {
  const runtime = new FileRuntime();
  const service = await AgentService.create({ runtime, recovery: { maxAttempts: 1 } });
  t.after(async () => {
    for (const call of runtime.calls) call.reject(new Error('test cleanup'));
    await service.close();
  });
  const agent = await service.createAgent({ name: '원본', persona: '파일 버전을 검증합니다.' });
  const started = async (agentId: string, prompt = '파일 작업') => {
    const run = await service.startRun(agentId, prompt);
    await until(async () => runtime.calls, calls => calls.some(call => call.input.run.id === run.id));
    return runtime.calls.find(call => call.input.run.id === run.id)!;
  };
  const finished = (runId: string) => until(() => service.workspace(), state => {
    const run = state.runs.find(item => item.id === runId)!;
    return ['succeeded', 'failed', 'cancelled'].includes(run.status) && state.agents.find(item => item.id === run.agentId)!.status !== 'running';
  });
  const complete = async (call: FileRuntime['calls'][number], text: string): Promise<Workspace> => {
    runtime.files.get(call.input.run.id)!['result.txt'] = text;
    call.resolve(result);
    return finished(call.input.run.id);
  };
  return { runtime, service, agent, started, finished, complete };
}

test('completed file version is pinned into the next run and active files remain unpublished', async t => {
  const { runtime, service, agent, started, complete } = await fixture(t);
  const first = await started(agent.id);
  assert.equal(first.input.run.workspaceSourceRunId, null);
  let state = await complete(first, 'version one');
  assert.equal(state.agents.find(item => item.id === agent.id)!.workspaceRunId, first.input.run.id);
  assert.equal(state.snapshots.find(item => item.sourceRunId === first.input.run.id)!.agent.workspaceRunId, first.input.run.id);
  const second = await started(agent.id);
  assert.equal(second.input.run.workspaceSourceRunId, first.input.run.id);
  assert.equal(runtime.files.get(second.input.run.id)!['result.txt'], 'version one');
  runtime.files.get(second.input.run.id)!['result.txt'] = 'uncommitted version two';
  assert.deepEqual(await service.workspaceFiles(agent.id, 'result.txt', true), { path: 'result.txt', text: 'version one', bytes: 11 });
  const duringRun = await service.createSnapshot(agent.id, '작업 중 스냅샷');
  assert.equal(duringRun.agent.workspaceRunId, first.input.run.id);
  state = await complete(second, 'version two');
  assert.equal(state.agents.find(item => item.id === agent.id)!.workspaceRunId, second.input.run.id);
  assert.equal(runtime.files.get(first.input.run.id)!['result.txt'], 'version one');
});

test('forking a chosen historical snapshot branches from its files without mutating source or history', async t => {
  const { runtime, service, agent, started, complete } = await fixture(t);
  const first = await started(agent.id);
  await complete(first, 'historical');
  const snapshot = await service.createSnapshot(agent.id, '선택한 파일 버전');
  const second = await started(agent.id);
  await complete(second, 'current original');
  const fork = await service.forkAgent(agent.id, { name: '복제본', snapshotId: snapshot.id });
  assert.equal(fork.workspaceRunId, first.input.run.id);
  assert.equal((await service.workspaceFiles(fork.id, 'result.txt', true) as { text: string }).text, 'historical');
  const forkRun = await started(fork.id);
  assert.equal(forkRun.input.run.workspaceSourceRunId, first.input.run.id);
  const state = await complete(forkRun, 'independent fork');
  assert.equal(state.agents.find(item => item.id === agent.id)!.workspaceRunId, second.input.run.id);
  assert.equal(state.agents.find(item => item.id === fork.id)!.workspaceRunId, forkRun.input.run.id);
  assert.equal(runtime.files.get(first.input.run.id)!['result.txt'], 'historical');
  assert.equal(runtime.files.get(second.input.run.id)!['result.txt'], 'current original');
  assert.equal((await service.workspaceFiles(fork.id, 'result.txt', true) as { text: string }).text, 'independent fork');
});

test('restore selects the snapshot file version and preserves a pre-restore pointer; disabling file restore preserves current files', async t => {
  const { service, agent, started, complete } = await fixture(t);
  const first = await started(agent.id);
  await complete(first, 'old files');
  const snapshot = await service.createSnapshot(agent.id, '과거 파일 버전');
  const second = await started(agent.id);
  await complete(second, 'latest files');
  const retained = await service.restoreAgent(agent.id, { snapshotId: snapshot.id, restoreFiles: false });
  assert.equal(retained.workspaceRunId, second.input.run.id);
  const restored = await service.restoreAgent(agent.id, { snapshotId: snapshot.id });
  assert.equal(restored.workspaceRunId, first.input.run.id);
  const state = await service.workspace();
  assert.equal(state.snapshots.find(item => item.label === '복원 전')!.agent.workspaceRunId, second.input.run.id);
  const continuation = await started(agent.id);
  assert.equal(continuation.input.run.workspaceSourceRunId, first.input.run.id);
  await complete(continuation, 'restored continuation');
});

test('failed and explicitly cancelled work preserve partial volumes without promoting the committed pointer', async t => {
  const { runtime, service, agent, started, finished, complete } = await fixture(t);
  const good = await started(agent.id);
  await complete(good, 'committed');
  const failed = await started(agent.id);
  runtime.files.get(failed.input.run.id)!['result.txt'] = 'partial failed';
  failed.reject(new Error('deliberate failure'));
  let state = await finished(failed.input.run.id);
  assert.equal(state.runs.find(item => item.id === failed.input.run.id)!.status, 'failed');
  assert.equal(state.agents.find(item => item.id === agent.id)!.workspaceRunId, good.input.run.id);
  const cancelled = await started(agent.id);
  assert.equal(cancelled.input.run.workspaceSourceRunId, good.input.run.id);
  runtime.files.get(cancelled.input.run.id)!['result.txt'] = 'partial cancelled';
  await service.cancelRun(cancelled.input.run.id);
  state = await finished(cancelled.input.run.id);
  assert.equal(state.runs.find(item => item.id === cancelled.input.run.id)!.status, 'cancelled');
  assert.equal(state.agents.find(item => item.id === agent.id)!.workspaceRunId, good.input.run.id);
  assert.equal(runtime.files.get(failed.input.run.id)!['result.txt'], 'partial failed');
  assert.equal(runtime.files.get(cancelled.input.run.id)!['result.txt'], 'partial cancelled');
  assert.equal((await service.workspaceFiles(agent.id, 'result.txt', true) as { text: string }).text, 'committed');
});

test('a pre-work snapshot forks and restores a genuinely empty personal workspace', async t => {
  const { service, agent, started, complete } = await fixture(t);
  const initial = await service.createSnapshot(agent.id, '빈 작업공간');
  const first = await started(agent.id);
  await complete(first, 'later file');
  const fork = await service.forkAgent(agent.id, { name: '빈 복제본', snapshotId: initial.id });
  assert.equal(fork.workspaceRunId ?? null, null);
  assert.deepEqual(await service.workspaceFiles(fork.id), { path: '', entries: [], truncated: false });
  const restored = await service.restoreAgent(agent.id, { snapshotId: initial.id });
  assert.equal(restored.workspaceRunId, null);
  const next = await started(agent.id);
  assert.equal(next.input.run.workspaceSourceRunId, null);
  await complete(next, 'fresh start');
});

test('a runtime with file methods but disabled persistence never publishes a nonexistent file version', async t => {
  const runtime = new FileRuntime();
  const ephemeral: RuntimeDriver = {
    workspacePersistence: false,
    inspect: () => runtime.inspect(),
    execute: (input, hooks) => runtime.execute(input, hooks),
    listWorkspace: id => runtime.listWorkspace(id),
    readWorkspace: (id, path) => runtime.readWorkspace(id, path),
  };
  const service = await AgentService.create({ runtime: ephemeral });
  t.after(async () => {
    for (const call of runtime.calls) call.reject(new Error('test cleanup'));
    await service.close();
  });
  const agent = await service.createAgent({ name: '비영속 실행', persona: '파일 버전 미지원입니다.' });
  const run = await service.startRun(agent.id, '일회성 작업');
  await until(async () => runtime.calls, calls => calls.length === 1);
  runtime.calls[0].resolve(result);
  const state = await until(() => service.workspace(), state => state.runs.find(item => item.id === run.id)!.status === 'succeeded');
  assert.equal(state.agents.find(item => item.id === agent.id)!.workspaceRunId ?? null, null);
  assert.equal(state.snapshots.find(item => item.sourceRunId === run.id)!.agent.workspaceRunId ?? null, null);
});
