import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Agent, ExecutionHooks, ExecutionInput, ExecutionResult, Memory, Run, RuntimeDriver, RuntimeInfo, Workspace } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { WorkspaceStore } from '../server/store.ts';

const emptyResult = (): ExecutionResult => ({ result: '검증 결과', memories: [], skills: [], artifacts: [], inputTokens: 10, outputTokens: 5 });

class ControlledRuntime implements RuntimeDriver {
  available = true;
  readonly calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; resolve: (result: ExecutionResult) => void; reject: (error: Error) => void }> = [];
  async inspect(): Promise<RuntimeInfo> {
    return { mode: 'docker', available: this.available, authenticated: true,
      image: 'explicit-test-runtime', model: 'test-model', message: this.available ? '명시적으로 주입한 테스트 실행기' : 'Docker 준비가 필요합니다.', version: 'test' };
  }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => { this.calls.push({ input, hooks, resolve, reject }); });
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const result = await read();
    if (done(result)) return result;
    if (Date.now() > deadline) throw new Error('테스트 상태 대기 시간이 초과되었습니다.');
    await setTimeout(5);
  }
}

const workspace = async (app: FastifyInstance): Promise<Workspace> => (await app.inject({ method: 'GET', url: '/api/workspace' })).json();
async function post<T>(app: FastifyInstance, url: string, payload: unknown, status = 201): Promise<T> {
  const response = await app.inject({ method: 'POST', url, payload: payload as object });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}
async function patch<T>(app: FastifyInstance, url: string, payload: unknown): Promise<T> {
  const response = await app.inject({ method: 'PATCH', url, payload: payload as object });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function createAgent(app: FastifyInstance, name = '테스트 에이전트'): Promise<Agent> {
  return post(app, '/api/agents', { name, persona: '검증을 위한 페르소나입니다.' });
}
async function finished(app: FastifyInstance, id: string): Promise<Workspace> {
  return until(() => workspace(app), (state) => {
    const run = state.runs.find((run) => run.id === id)!;
    return ['succeeded', 'failed', 'cancelled'].includes(run.status)
      && state.agents.find((agent) => agent.id === run.agentId)!.status !== 'running';
  });
}

test('personal lifecycle API and invariants', async (t) => {
  const runtime = new ControlledRuntime();
  const app = await createApp({ runtime });
  t.after(async () => {
    for (const call of runtime.calls) call.reject(new Error('테스트 정리'));
    await app.close();
  });

  await t.test('validates input, origin and DNS rebinding without writing state', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/agents', payload: { name: ' ', persona: 'x' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/agents', headers: { origin: 'https://attacker.test' }, payload: { name: 'x', persona: 'x' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspace', headers: { host: 'attacker.test' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspace', headers: { origin: 'null' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'x', persona: 'x', secretlyGrantAll: true } })).statusCode, 400);
    assert.equal((await workspace(app)).agents.length, 0);
  });

  await t.test('pins run input, retains active skills and preserves unverified candidates', async () => {
    const agent = await createAgent(app);
    await post(app, `/api/agents/${agent.id}/skills`, { name: '구조 검토', description: '구조 검사', content: '입력 구조를 검사합니다.' });
    const run = await post<Run>(app, `/api/agents/${agent.id}/runs`, { prompt: '기억과 스킬을 검증합니다.' }, 202);
    await until(async () => runtime.calls, (calls) => calls.length === 1);
    const call = runtime.calls[0];
    const next = await patch<Agent>(app, `/api/agents/${agent.id}`, { persona: '다음 실행용 페르소나입니다.' });
    assert.equal(next.version, 3);
    assert.equal(call.input.agent.persona, agent.persona);
    assert.equal(call.input.run.agentVersion, 2);
    assert.equal((await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/runs`, payload: { prompt: '중복 실행' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/memories`, payload: { kind: 'fact', title: '경합', content: '경합' } })).statusCode, 409);
    await post(app, `/api/runs/${run.id}/steer`, { message: '추가 검증 지시' }, 200);
    assert.deepEqual(await call.hooks.getSteering(), ['추가 검증 지시']);
    await call.hooks.onEvent('독립 평가를 실행합니다.');
    call.resolve({ ...emptyResult(), appliedSteeringCount: 1, memories: [{ kind: 'fact', title: '사용 언어', content: '한국어' }],
      skills: [
        { name: '구조 검토', description: '구조 검사', content: '입력 구조를 검사합니다.', passed: true, evaluation: '독립 검증 통과' },
        { name: '무근거 확장', description: '', content: '항상 확장합니다.', passed: false, evaluation: '회귀 검사 실패' },
      ], artifacts: [{ name: 'report.md', content: '# 검증', mediaType: 'text/markdown' }] });
    const state = await finished(app, run.id);
    assert.equal(state.runs.find((item) => item.id === run.id)!.status, 'succeeded');
    assert.equal(state.agents.find((item) => item.id === agent.id)!.version, 3);
    assert.equal(state.memories.filter((item) => item.agentId === agent.id).length, 1);
    assert.equal(state.skills.filter((item) => item.agentId === agent.id && item.status === 'active').length, 1);
    assert.equal(state.skillRevisions!.filter(item => item.agentId === agent.id && item.origin === 'candidate').length, 2);
    assert.equal(state.growthReviews!.filter(item => item.agentId === agent.id && item.decision === 'kept').length, 2);
    assert.equal(state.snapshots.find((item) => item.id === run.snapshotId)!.memories.length, 0);
    assert.equal(state.snapshots.find((item) => item.sourceRunId === run.id)!.memories.length, 1);
    assert.equal(state.runs.find((item) => item.id === run.id)!.artifacts[0].content, '# 검증');
    const followup = await post<Run>(app, `/api/agents/${agent.id}/runs`, { prompt: '다음 실행 검증' }, 202);
    await until(async () => runtime.calls, (calls) => calls.length === 2);
    assert.equal(runtime.calls[1].input.memories[0].content, '한국어');
    assert.deepEqual(runtime.calls[1].input.skills.map((item) => item.name), ['구조 검토']);
    runtime.calls[1].resolve({ ...emptyResult(), skills: [{
      name: '구조 검토', description: '실패한 수정', content: '회귀가 생기는 수정입니다.', passed: false, evaluation: '기존 동작 회귀',
    }] });
    const followupState = await finished(app, followup.id);
    assert.equal(followupState.skills.find((item) => item.agentId === agent.id && item.name === '구조 검토' && item.status === 'active')!.content, '입력 구조를 검사합니다.');
    assert.equal(followupState.agents.find((item) => item.id === agent.id)!.version, 3);
  });

  await t.test('clones independent memory identities and restores without mutating the source', async () => {
    const source = (await workspace(app)).agents[0];
    const saved = await post<{ id: string }>(app, `/api/agents/${source.id}/snapshots`, { label: '분기 검증' });
    const clone = await post<Agent>(app, `/api/agents/${source.id}/fork`, { name: '분기 에이전트', snapshotId: saved.id, persona: '독립 페르소나' });
    let state = await workspace(app);
    const originalMemory = state.memories.find((item) => item.agentId === source.id)!;
    const forkedMemory = state.memories.find((item) => item.agentId === clone.id)!;
    assert.notEqual(originalMemory.id, forkedMemory.id);
    assert.equal(clone.parentId, source.id); assert.equal(clone.generation, source.generation + 1);
    await patch(app, `/api/memories/${forkedMemory.id}`, { content: '복제본의 새 기억' });
    state = await workspace(app);
    assert.equal(state.memories.find((item) => item.id === originalMemory.id)!.content, '한국어');
    assert.equal(state.memories.find((item) => item.id === forkedMemory.id)!.content, '복제본의 새 기억');
    assert.equal((await app.inject({ method: 'POST', url: `/api/agents/${clone.id}/restore`, payload: { snapshotId: saved.id } })).statusCode, 400);
    const cloneInitial = state.snapshots.find((item) => item.agentId === clone.id && item.label.includes('에서 분기'))!;
    await post(app, `/api/agents/${clone.id}/restore`, { snapshotId: cloneInitial.id, restoreMemory: true, restoreSkills: false }, 200);
    state = await workspace(app);
    assert.equal(state.memories.find((item) => item.id === forkedMemory.id)!.content, '한국어');
    assert.equal(state.agents.find((item) => item.id === source.id)!.version, source.version);
    const beforeRestore = state.snapshots.find((item) => item.agentId === clone.id && item.label === '복원 전')!;
    assert.equal(beforeRestore.memories.find((item) => item.id === forkedMemory.id)!.content, '복제본의 새 기억');
  });

  await t.test('historic cloning and restoring cannot re-grant revoked access', async () => {
    const connection = await post<{ id: string }>(app, '/api/connections', { repository: 'owner/repository', access: 'read' });
    const agent = await createAgent(app, '권한 검증');
    await patch(app, `/api/agents/${agent.id}`, { allowWeb: true, repositoryIds: [connection.id] });
    const saved = await post<{ id: string }>(app, `/api/agents/${agent.id}/snapshots`, { label: '권한 부여 시점' });
    await patch(app, `/api/agents/${agent.id}`, { allowWeb: false, repositoryIds: [] });
    const clone = await post<Agent>(app, `/api/agents/${agent.id}/fork`, { name: '제한된 복제', snapshotId: saved.id });
    assert.equal(clone.allowWeb, false); assert.deepEqual(clone.repositoryIds, []);
    const restored = await post<Agent>(app, `/api/agents/${agent.id}/restore`, { snapshotId: saved.id }, 200);
    assert.equal(restored.allowWeb, false); assert.deepEqual(restored.repositoryIds, []);
  });

  await t.test('cancellation wins over late success and waits for worker shutdown', async () => {
    const agent = await createAgent(app, '취소 검증');
    const before = runtime.calls.length;
    const run = await post<Run>(app, `/api/agents/${agent.id}/runs`, { prompt: '취소할 실행' }, 202);
    await until(async () => runtime.calls, (calls) => calls.length === before + 1);
    const call = runtime.calls[before];
    const cancelled = await post<Run>(app, `/api/runs/${run.id}/cancel`, {}, 200);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(call.hooks.signal.aborted, true);
    for (let index = 0; index < 25; index += 1) await call.hooks.onEvent(`취소 후 컨테이너 정리 기록 ${index}`);
    const cleanup = (await workspace(app)).activities.filter((item) => item.runId === run.id && item.type === 'system');
    assert.equal(cleanup.length, 20);
    assert.ok(cleanup.some((item) => item.detail === '취소 후 컨테이너 정리 기록 0'));
    assert.equal((await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/runs`, payload: { prompt: '아직 종료 중' } })).statusCode, 409);
    call.resolve({ ...emptyResult(), memories: [{ kind: 'fact', title: '적용 금지', content: '적용 금지' }] });
    const state = await finished(app, run.id);
    assert.equal(state.runs.find((item) => item.id === run.id)!.status, 'cancelled');
    assert.equal(state.memories.filter((item) => item.agentId === agent.id).length, 0);
    assert.equal(state.snapshots.filter((item) => item.sourceRunId === run.id).length, 0);
  });

  await t.test('runtime errors and invalid growth payloads never partially commit', async () => {
    const agent = await createAgent(app, '실패 검증');
    for (const invalid of [false, true]) {
      const before = runtime.calls.length;
      const run = await post<Run>(app, `/api/agents/${agent.id}/runs`, { prompt: '실패 실행' }, 202);
      await until(async () => runtime.calls, (calls) => calls.length === before + 1);
      if (invalid) runtime.calls[before].resolve({ ...emptyResult(), memories: [{ kind: 'fact', title: '먼저 쓰지 않음', content: '내용' }], inputTokens: -1 });
      else runtime.calls[before].reject(new Error('컨테이너가 종료되었습니다.'));
      const state = await finished(app, run.id);
      assert.equal(state.runs.find((item) => item.id === run.id)!.status, 'failed');
      assert.equal(state.memories.filter((item) => item.agentId === agent.id).length, 0);
      assert.equal(state.agents.find((item) => item.id === agent.id)!.version, 1);
    }
  });

  await t.test('steering accepted after the last runtime read continues atomically without repeating the original task', async () => {
    const agent = await createAgent(app, '최종 저장 경합 검증');
    const before = runtime.calls.length;
    const run = await post<Run>(app, `/api/agents/${agent.id}/runs`, { prompt: '원본 작업' }, 202);
    await until(async () => runtime.calls, (calls) => calls.length === before + 1);
    const first = runtime.calls[before];
    assert.deepEqual(await first.hooks.getSteering(), []);
    await post(app, `/api/runs/${run.id}/steer`, { message: '평가 중 도착한 지시' }, 200);
    await patch(app, `/api/agents/${agent.id}`, { persona: '다음 실행용 설정' });
    first.resolve({ ...emptyResult(), result: '기존 작업은 이미 끝났습니다.', appliedSteeringCount: 0,
      memories: [{ kind: 'fact', title: '아직 적용하지 않음', content: '최종 결과 전에 쓰지 않습니다.' }] });
    await until(async () => runtime.calls, (calls) => calls.length === before + 2);
    const second = runtime.calls[before + 1];
    assert.equal(second.input.previousResult!.result, '기존 작업은 이미 끝났습니다.');
    assert.equal(second.input.previousResult!.appliedSteeringCount, 0);
    assert.equal(second.input.agent.persona, agent.persona);
    assert.equal(second.input.run.snapshotId, first.input.run.snapshotId);
    assert.equal(second.input.run.prompt, '원본 작업');
    assert.deepEqual(second.input.run.steering, ['평가 중 도착한 지시']);
    let state = await workspace(app);
    assert.equal(state.memories.filter((item) => item.agentId === agent.id).length, 0);
    assert.equal(state.runs.find((item) => item.id === run.id)!.status, 'running');
    await post(app, `/api/runs/${run.id}/steer`, { message: '후속 평가 중 도착한 지시' }, 200);
    second.resolve({ ...emptyResult(), result: '첫 후속 결과', appliedSteeringCount: 1 });
    await until(async () => runtime.calls, (calls) => calls.length === before + 3);
    const third = runtime.calls[before + 2];
    assert.equal(third.input.previousResult!.result, '첫 후속 결과');
    assert.deepEqual(third.input.run.steering, ['평가 중 도착한 지시', '후속 평가 중 도착한 지시']);
    // An older driver without an explicit acknowledgement covers only its starting input.
    third.resolve({ ...emptyResult(), result: '모든 추가 지시를 반영한 결과',
      memories: [{ kind: 'fact', title: '최종 기억', content: '확정된 내용' }] });
    state = await finished(app, run.id);
    const completed = state.runs.find((item) => item.id === run.id)!;
    assert.equal(completed.result, '모든 추가 지시를 반영한 결과');
    assert.equal(completed.inputTokens, 30); assert.equal(completed.outputTokens, 15);
    assert.deepEqual(state.memories.filter((item) => item.agentId === agent.id).map((item) => item.title), ['최종 기억']);
    assert.equal(state.snapshots.filter((item) => item.sourceRunId === run.id).length, 1);
    assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/steer`, payload: { message: '완료 후 지시' } })).statusCode, 409);
  });

  await t.test('impossible steering acknowledgement fails instead of silently losing accepted instructions', async () => {
    const agent = await createAgent(app, '잘못된 추가 지시 확인');
    const before = runtime.calls.length;
    const run = await post<Run>(app, `/api/agents/${agent.id}/runs`, { prompt: '실행' }, 202);
    await until(async () => runtime.calls, (calls) => calls.length === before + 1);
    runtime.calls[before].resolve({ ...emptyResult(), appliedSteeringCount: 1 });
    const state = await finished(app, run.id);
    assert.equal(state.runs.find((item) => item.id === run.id)!.status, 'failed');
    assert.match(state.runs.find((item) => item.id === run.id)!.error!, /추가 지시 반영 기록/);
  });

  await t.test('unavailable runtime does not manufacture a successful run', async () => {
    const agent = await createAgent(app, '환경 검증');
    runtime.available = false;
    assert.equal((await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/runs`, payload: { prompt: '실행' } })).statusCode, 503);
    assert.equal((await workspace(app)).runs.filter((item) => item.agentId === agent.id).length, 0);
    runtime.available = true;
  });

  await t.test('concurrent requests serialize one agent while different agents run independently', async () => {
    const first = await createAgent(app, '동시 실행 첫째');
    const second = await createAgent(app, '동시 실행 둘째');
    const before = runtime.calls.length;
    const responses = await Promise.all([first.id, first.id, second.id].map((id) => app.inject({
      method: 'POST', url: `/api/agents/${id}/runs`, payload: { prompt: '동시 실행' },
    })));
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 202, 409]);
    await until(async () => runtime.calls, (calls) => calls.length === before + 2);
    assert.notEqual(runtime.calls[before].input.agent.id, runtime.calls[before + 1].input.agent.id);
    runtime.calls[before].resolve(emptyResult()); runtime.calls[before + 1].resolve(emptyResult());
    for (const response of responses.filter((response) => response.statusCode === 202)) await finished(app, response.json<Run>().id);
  });

  await t.test('agent proposals require approval and stale proposals cannot overwrite the team', async () => {
    const first = await createAgent(app, '첫 팀원');
    const second = await createAgent(app, '둘째 팀원');
    const team = await post<{ id: string }>(app, '/api/teams', { name: '검증 팀', memberIds: [first.id] });
    const proposal = await post<{ id: string }>(app, `/api/teams/${team.id}/proposals`, { proposedByAgentId: first.id, memberIds: [first.id, second.id], reason: '업무 분리' });
    assert.deepEqual((await workspace(app)).teams.find((item) => item.id === team.id)!.memberIds, [first.id]);
    await post(app, `/api/approvals/${proposal.id}/resolve`, { approved: true }, 200);
    assert.deepEqual((await workspace(app)).teams.find((item) => item.id === team.id)!.memberIds, [first.id, second.id]);
    assert.equal((await app.inject({ method: 'POST', url: `/api/approvals/${proposal.id}/resolve`, payload: { approved: true } })).statusCode, 409);
    const stale = await post<{ id: string }>(app, `/api/teams/${team.id}/proposals`, { proposedByAgentId: first.id, memberIds: [first.id], reason: '변경 이전 제안' });
    await patch(app, `/api/teams/${team.id}`, { memberIds: [second.id] });
    assert.equal((await app.inject({ method: 'POST', url: `/api/approvals/${stale.id}/resolve`, payload: { approved: true } })).statusCode, 409);
    assert.deepEqual((await workspace(app)).teams.find((item) => item.id === team.id)!.memberIds, [second.id]);
    assert.equal((await app.inject({ method: 'POST', url: `/api/teams/${team.id}/proposals`, payload: { proposedByAgentId: first.id, memberIds: [first.id], reason: '팀 외부 제안' } })).statusCode, 403);
  });
});

test('PostgreSQL state survives a restart and interrupted runs are not replayed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-domain-'));
  const runtime = new ControlledRuntime();
  let app: FastifyInstance | undefined;
  try {
    app = await createApp({ runtime, dataDir: directory });
    const agent = await createAgent(app, '영속 에이전트');
    await post<Memory>(app, `/api/agents/${agent.id}/memories`, { kind: 'fact', title: '보존', content: '재시작 이후에도 유지합니다.' });
    await app.close(); app = undefined;
    const store = await WorkspaceStore.open(directory);
    await store.change((state) => {
      state.agents[0].status = 'running';
      state.runs.push({ id: '4c8fd4d7-8369-4795-8bd1-655a774a2a52', agentId: agent.id, agentVersion: 1,
        snapshotId: state.snapshots[0].id, prompt: '서버 중단 직전 실행', status: 'running', result: '', error: null,
        inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null });
    });
    await store.close();
    app = await createApp({ runtime, dataDir: directory });
    const state = await workspace(app);
    assert.equal(state.agents[0].id, agent.id);
    assert.equal(state.memories[0].content, '재시작 이후에도 유지합니다.');
    assert.equal(state.runs[0].status, 'failed');
    assert.match(state.runs[0].error!, /다시 시작/);
    assert.equal(state.agents[0].status, 'idle');
    assert.equal(runtime.calls.length, 0);
  } finally {
    await app?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /agent-company-domain-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  }
});
