import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentService, type ServiceOptions } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { ContainerRuntime, type RuntimeConfig } from '../server/runtime.ts';
import { consultationSource, consultationBlock, preserveCheckpointResult, validateConsultationState } from '../server/consultations.ts';
import { objectiveRunBlock } from '../server/objectives.ts';
import type { WorkspaceStore } from '../server/store.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, Run, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';
import type { PeerMessage } from '../shared/collaboration.ts';
import type { Objective } from '../shared/objectives.ts';
import type { ConversationMessage } from '../shared/conversations.ts';
import type { OperatorRequest } from '../shared/operator-requests.ts';
import { BudgetPauseError } from '../shared/telemetry.ts';
import { RunCheckpoints } from '../src/RunCheckpoints.tsx';
import { ConversationMessageCard, ConversationRun } from '../src/ConversationView.tsx';

const result = (text = '상담 답변', extra: Partial<ExecutionResult> = {}): ExecutionResult => ({ result: text,
  memories: [], skills: [], artifacts: [], inputTokens: 11, outputTokens: 5, appliedSteeringCount: 0, ...extra });
class ControlledRuntime implements RuntimeDriver {
  workspacePersistence = true;
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; finish: (output?: ExecutionResult) => void }> = [];
  blockedCleanup = new Map<string, Promise<void>>();
  releaseCleanup: Array<() => void> = [];
  settled: string[] = [];
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', available: true, authenticated: true,
    image: 'consultation-test-only', model: 'test-only', message: 'Injected runtime; no real model', version: 'test' }; }
  async canResume(input: ExecutionInput) { return Boolean(input.checkpoint || input.previousResult); }
  async settle(id: string) { await this.blockedCleanup.get(id); this.settled.push(id); }
  async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    await hooks.beforeModelStart?.({ runId: input.run.id, phase: 'task', kind: 'task', reason: 'Injected model admission; no actual model' });
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('controlled stop'));
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks, finish: (output = result()) => {
        hooks.signal.removeEventListener('abort', abort); resolve(output);
      } });
    });
  }
}
async function until(check: () => Promise<boolean> | boolean) {
  const end = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > end) throw new Error('Consultation condition timed out'); await delay(10); }
}
async function fixture(t: TestContext, sameRoom = true, beforeModelStart?: ServiceOptions['beforeModelStart']) {
  const runtime = new ControlledRuntime();
  const scheduler = new ResourceScheduler({ capacity: { memoryMiB: 3072, cpus: 3 },
    defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });
  const service = await AgentService.create({ runtime, scheduler, beforeModelStart }); t.after(async () => { for (const release of runtime.releaseCleanup) release(); await service.close(); });
  const agent = await service.createAgent({ name: '영업', persona: '실제 영업 맥락', allowWeb: true });
  const peer = await service.createAgent({ name: '제작', persona: '동료' });
  const team = await service.createTeam({ name: '팀', memberIds: [agent.id, peer.id] });
  const conversation = await service.createConversation({ scope: { type: 'team', id: team.id }, title: '상담', idempotencyKey: randomUUID() });
  if (sameRoom) await service.sendConversation(conversation.id, { content: '기존 작업', mode: 'task', recipientAgentId: agent.id, idempotencyKey: randomUUID() });
  else await service.startRun(agent.id, '대화 도구 없이 시작한 기존 작업');
  await until(() => runtime.calls.length === 1);
  const original = runtime.calls[0];
  const message = await original.hooks.onTool!('message_send', { scope: { type: 'team', id: team.id },
    recipientAgentId: null, content: '동료 회신이 필요합니다', idempotencyKey: randomUUID() }) as PeerMessage;
  await original.hooks.onTool!('peer_wait', { messageId: message.id, reason: '동료 일정 회신 대기' });
  const send = (content = '설계 상담', mode = 'discuss') => service.sendConversation(conversation.id,
    { content, mode, recipientAgentId: agent.id, idempotencyKey: randomUUID() });
  const stateRun = async (id = original.input.run.id) => (await service.workspace()).runs.find(run => run.id === id)!;
  const finishOriginal = async () => {
    original.finish(result('대기 중 답변', { artifacts: [{ name: 'draft.md', content: '대기 시점 문서', mediaType: 'text/markdown' }] }));
    await until(async () => (await stateRun()).status === 'waiting');
  };
  return { runtime, service, scheduler, agent, peer, team, conversation, original, message, send, stateRun, finishOriginal };
}

test('explicit same-room consultation waits for worker cleanup, preserves dependency and publishes an independent answer once', async t => {
  const { runtime, service, scheduler, agent, original, send, stateRun, finishOriginal, conversation } = await fixture(t);
  let releaseCleanup!: () => void;
  runtime.blockedCleanup.set(original.input.run.id, new Promise<void>(resolve => { releaseCleanup = resolve; }));
  runtime.releaseCleanup.push(() => releaseCleanup());
  const payload = { content: '대표의 명시적 상담', mode: 'discuss', recipientAgentId: agent.id, idempotencyKey: randomUUID() };
  const message = await service.sendConversation(conversation.id, payload);
  await service.sendConversation(conversation.id, payload);
  assert.equal((await stateRun()).steering.length, 0);
  original.finish(result('대기 중 답변', { artifacts: [{ name: 'draft.md', content: '대기 시점 문서', mediaType: 'text/markdown' }] }));
  await delay(50); assert.equal(runtime.calls.length, 1);
  assert.equal(scheduler.snapshot().reserved.memoryMiB, 1024);
  releaseCleanup(); await until(() => runtime.calls.length === 2);
  const savedOriginal = await stateRun();
  assert.equal(savedOriginal.checkpointResults?.[0].artifacts[0].content, '대기 시점 문서');
  const call = runtime.calls[1];
  assert.ok(runtime.settled.includes(original.input.run.id));
  assert.equal(call.input.run.consultationOfRunId, original.input.run.id);
  assert.equal(call.input.run.workspaceSourceRunId, null); assert.equal(call.input.environment, undefined);
  assert.equal(call.input.agent.allowWeb, false); assert.deepEqual(call.input.agent.repositoryIds, []); assert.deepEqual(call.input.connections, []);
  assert.equal(call.input.run.budgetTeamId, original.input.run.budgetTeamId);
  assert.equal(call.input.run.budgetRootRunId, original.input.run.budgetRootRunId);
  for (const name of ['message_send', 'conversation_send', 'task_create', 'environment_call', 'github_write_file', 'operator_request_create']) {
    assert.equal(call.input.collaboration?.tools.some(tool => tool.name === name), false);
    await assert.rejects(() => call.hooks.onTool!(name, {}), /상담 실행/);
  }
  assert.ok(call.input.collaboration?.tools.some(tool => tool.name === 'conversation_read'));
  await assert.rejects(() => call.hooks.onTool!('github_repository', {}), /별도 상담 실행/);
  call.finish(result('독립 상담 완료', { route: 'task', artifacts: [{ name: 'answer.md', content: '원문 상담 첨부', mediaType: 'text/markdown' }],
    memories: [{ kind: 'fact', title: '적용 금지', content: '금지' }], environmentProposal: { reason: '금지', requestedAccess: [], spec: { packages: [], servers: [] } } }));
  await until(async () => (await stateRun(call.input.run.id)).status === 'succeeded');
  assert.deepEqual(await stateRun(), savedOriginal);
  const workspace = await service.workspace();
  assert.equal(workspace.agents.find(item => item.id === agent.id)?.status, 'running');
  assert.equal(workspace.agents.find(item => item.id === agent.id)?.workspaceRunId, undefined);
  assert.equal(workspace.memories.length, 0); assert.equal(workspace.environmentRevisions?.length, 0);
  assert.equal((await stateRun(call.input.run.id)).artifacts[0].content, '원문 상담 첨부');
  const view = await service.getConversation(conversation.id);
  assert.equal(view.messages.filter(item => item.sourceRunId === call.input.run.id).length, 1);
  assert.equal(view.messages.find(item => item.sourceRunId === call.input.run.id)?.consultationOfRunId, original.input.run.id);
  assert.equal(view.messages.find(item => item.id === message.id)?.deliveries[0].status, 'answered');
  assert.equal(runtime.calls.length, 2);
  // Subsequent independent consultations remain possible without completing the task.
  await send('후속 상담'); await until(() => runtime.calls.length === 3);
  assert.equal(runtime.calls[2].input.run.consultationOfRunId, original.input.run.id);
});

test('old waiting run without conversation tools stays unchanged and receives a new scoped consultation run', async t => {
  const { runtime, original, stateRun, finishOriginal, send } = await fixture(t, false);
  assert.equal(original.input.run.conversationId, undefined);
  assert.equal(original.input.collaboration?.tools.some(tool => tool.name === 'conversation_read'), false);
  await finishOriginal(); const before = await stateRun();
  await send(); await until(() => runtime.calls.length === 2);
  assert.equal(runtime.calls[1].input.run.consultationOfRunId, original.input.run.id);
  assert.deepEqual(await stateRun(), before);
  runtime.calls[1].finish();
});

test('original reply can queue continuation during consultation but cannot start its worker until consultation cleanup', async t => {
  const { runtime, original, finishOriginal, send, service, stateRun, conversation, peer } = await fixture(t);
  await finishOriginal(); await send(); await until(() => runtime.calls.length === 2);
  const consultation = runtime.calls[1];
  let release!: () => void;
  runtime.blockedCleanup.set(consultation.input.run.id, new Promise<void>(resolve => { release = resolve; }));
  runtime.releaseCleanup.push(() => release());
  await service.sendConversation(conversation.id, { content: '동료 작업 시작', mode: 'task', recipientAgentId: peer.id, idempotencyKey: randomUUID() });
  await until(() => runtime.calls.length === 3); const peerCall = runtime.calls[2];
  await peerCall.hooks.onTool!('conversation_send', { conversationId: conversation.id, recipientAgentId: original.input.agent.id,
    content: '일정 회신으로 원래 작업 재개', mode: 'task', idempotencyKey: randomUUID() });
  await until(async () => (await stateRun()).status === 'queued');
  await delay(100); assert.equal(runtime.calls.filter(call => call.input.run.id === original.input.run.id).length, 1);
  consultation.finish();
  await delay(100); assert.equal(runtime.calls.filter(call => call.input.run.id === original.input.run.id).length, 1);
  release(); await until(() => runtime.calls.filter(call => call.input.run.id === original.input.run.id).length === 2);
  const resumed = runtime.calls.findLast(call => call.input.run.id === original.input.run.id)!;
  assert.ok(resumed.input.run.steering.some(item => item.includes('일정 회신')));
  resumed.finish(result('원래 작업 최종 완료', { appliedSteeringCount: 1 })); peerCall.finish();
});

test('pausing only the consultation returns its resources without blocking independently resumed original work', async t => {
  const { runtime, service, original, finishOriginal, send, stateRun } = await fixture(t);
  await finishOriginal(); await send(); await until(() => runtime.calls.length === 2);
  const consultation = runtime.calls[1];
  await service.pauseRun(consultation.input.run.id); consultation.finish();
  await until(async () => (await stateRun(consultation.input.run.id)).status === 'paused');
  await service.steerRun(original.input.run.id, '대기를 끝내고 기존 작업을 이어갑니다');
  await until(() => runtime.calls.length === 3);
  assert.equal(runtime.calls[2].input.run.id, original.input.run.id);
  assert.equal((await stateRun(consultation.input.run.id)).status, 'paused');
  await until(() => runtime.settled.includes(consultation.input.run.id));
  await service.resumeRun(consultation.input.run.id);
  await until(async () => (await stateRun(consultation.input.run.id)).status === 'failed');
  assert.equal(runtime.calls.length, 3); assert.equal((await stateRun()).status, 'running');
  runtime.calls[2].finish(result('기존 작업 완료', { appliedSteeringCount: 1 }));
});

for (const operation of ['pause', 'cancel'] as const) test(`original ${operation} aborts its separate consultation without changing original stop state`, async t => {
  const { runtime, service, original, finishOriginal, send, stateRun } = await fixture(t);
  await finishOriginal(); await send(); await until(() => runtime.calls.length === 2);
  const consultation = runtime.calls[1];
  if (operation === 'pause') await service.pauseRun(original.input.run.id); else await service.cancelRun(original.input.run.id);
  assert.equal(consultation.hooks.signal.aborted, true);
  await until(async () => (await stateRun(consultation.input.run.id)).status === 'cancelled');
  assert.equal((await stateRun()).status, operation === 'pause' ? 'paused' : 'cancelled');
  assert.equal((await service.getConversation(consultation.input.run.conversationId!)).messages.some(item => item.sourceRunId === consultation.input.run.id), false);
});

test('membership revocation blocks later model starts, reads and publication without falsely completing the original', async t => {
  const { runtime, service, finishOriginal, send, stateRun, team, peer, agent } = await fixture(t);
  await finishOriginal(); await send(); await until(() => runtime.calls.length === 2);
  const call = runtime.calls[1];
  await service.updateTeam(team.id, { memberIds: [peer.id] });
  await assert.rejects(() => call.hooks.onTool!('conversation_list', {}), /권한/);
  await assert.rejects(() => call.hooks.beforeModelStart!({ runId: call.input.run.id, phase: 'task', kind: 'task', reason: 'test' }), /권한/);
  call.finish(result('회수 이후 응답')); await until(async () => (await stateRun(call.input.run.id)).status === 'failed');
  assert.equal((await stateRun()).status, 'waiting');
  assert.equal((await service.workspace()).agents.find(item => item.id === agent.id)?.status, 'running');
  assert.equal((await service.getConversation(call.input.run.conversationId!)).messages.some(item => item.sourceRunId === call.input.run.id), false);
});

test('cancelling an original before its consultation is admitted cancels the pinned delivery instead of starting a fresh discussion', async t => {
  const { runtime, service, original, send, conversation, stateRun } = await fixture(t);
  const pending = await send();
  assert.equal(pending.deliveries[0].consultationOfRunId, original.input.run.id);
  await service.cancelRun(original.input.run.id);
  await until(async () => (await service.getConversation(conversation.id)).messages.find(item => item.id === pending.id)?.deliveries[0].status === 'cancelled');
  assert.equal(runtime.calls.length, 1); assert.equal((await stateRun()).status, 'cancelled');
});

test('cancelling only a consultation preserves the original objective and dependency', async t => {
  const { runtime, service, original, finishOriginal, send, stateRun, team } = await fixture(t);
  await finishOriginal();
  const id = randomUUID(), now = new Date().toISOString();
  await (service as unknown as { store: WorkspaceStore }).store.change(state => {
    state.objectives.push({ id, idempotencyKey: randomUUID(), teamId: team.id, scope: { type: 'team', id: team.id },
      title: '기존 목적', purpose: '승인된 작업', constraints: '', conditions: [{ id: 'one', text: '완료', requiresUserConfirmation: false }],
      confirmations: [], status: 'active', version: 1, blockedReason: null, lastInputHash: null, lastEvaluationId: null, createdAt: now, updatedAt: now });
    state.runs.find(item => item.id === original.input.run.id)!.objectiveId = id;
  });
  await send(); await until(() => runtime.calls.length === 2);
  await service.cancelRun(runtime.calls[1].input.run.id);
  assert.equal((await service.workspace()).objectives?.find(item => item.id === id)?.status, 'active');
  assert.equal((await stateRun()).status, 'waiting');
});

test('a consultation observes the same model budget gate without consuming or completing the original waiting task', async t => {
  let blocked = false, admitted = 0;
  const { runtime, service, original, finishOriginal, send, stateRun } = await fixture(t, true, async () => {
    if (blocked) throw new BudgetPauseError('상담 검증 예산 한도');
    admitted++;
  });
  await finishOriginal(); const saved = await stateRun(); blocked = true;
  await send();
  await until(async () => (await service.workspace()).runs.some(item => item.consultationOfRunId === original.input.run.id && item.modelBudgetPaused));
  assert.equal(runtime.calls.length, 1); assert.equal(admitted, 1); assert.deepEqual(await stateRun(), saved);
  const consultation = (await service.workspace()).runs.find(item => item.consultationOfRunId === original.input.run.id)!;
  blocked = false; await service.resumeBudgetRun(consultation.id); await until(() => runtime.calls.length === 2);
  runtime.calls[1].finish(); await until(async () => (await stateRun(consultation.id)).status === 'succeeded');
  assert.equal(admitted, 2); assert.equal((await stateRun()).status, 'waiting');
});

test('new task messages remain pending steering behind an operator request while explicit discuss uses an independent run', async t => {
  const { original, runtime, service, team, finishOriginal, send, stateRun } = await fixture(t);
  const request = await original.hooks.onTool!('operator_request_create', { scope: { type: 'team', id: team.id }, category: 'environment',
    title: '환경 조치', reason: '구축 확인 필요', requestedAction: '환경 확인', requestedScope: '현재 과제', verificationCriteria: '검사 통과', idempotencyKey: randomUUID() }) as OperatorRequest;
  await original.hooks.onTool!('operator_request_wait', { requestId: request.id, reason: '대표 조치 대기' });
  await finishOriginal(); const savedWait = (await stateRun()).waitingForOperatorRequest;
  await send('작업 내용 추가', 'task'); await delay(50);
  assert.equal(runtime.calls.length, 1); assert.equal((await stateRun()).status, 'waiting');
  assert.deepEqual((await stateRun()).waitingForOperatorRequest, savedWait);
  assert.equal((await stateRun()).steering.length, 1);
  await send('대표 조치가 필요한 이유 설명'); await until(() => runtime.calls.length === 2);
  assert.equal(runtime.calls[1].input.run.consultationOfRunId, original.input.run.id);
  runtime.calls[1].finish(); await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
  assert.equal((await stateRun()).status, 'waiting'); assert.deepEqual((await stateRun()).waitingForOperatorRequest, savedWait);
});

test('project delegation consultation preserves original billing team while reusing only a verified same-agent objective lineage', async t => {
  const { service, agent, peer, original, finishOriginal, team } = await fixture(t);
  await finishOriginal();
  const state = await (service as unknown as { store: WorkspaceStore }).store.read();
  const source = state.runs.find(item => item.id === original.input.run.id)!, now = new Date().toISOString();
  const originTeam = { ...team, id: randomUUID(), name: '원팀', memberIds: [peer.id] };
  state.teams.push(originTeam);
  const project = { id: randomUUID(), name: '공동 프로젝트', description: '', teamIds: [team.id, originTeam.id], version: 1, createdAt: now, updatedAt: now };
  state.projects.push(project);
  const objective: Objective = { id: randomUUID(), idempotencyKey: randomUUID(), teamId: originTeam.id, scope: { type: 'project', id: project.id },
    title: '기존 목적', purpose: '공동 작업', constraints: '', conditions: [{ id: 'one', text: '완료', requiresUserConfirmation: false }],
    confirmations: [], status: 'active', version: 1, blockedReason: null, lastInputHash: null, lastEvaluationId: null, createdAt: now, updatedAt: now };
  state.objectives.push(objective);
  const root: Run = { ...structuredClone(source), id: randomUUID(), agentId: peer.id, objectiveId: objective.id, status: 'succeeded',
    budgetProjectId: project.id, budgetTeamId: originTeam.id, waitingFor: null };
  root.budgetRootRunId = root.id; state.runs.push(root);
  Object.assign(source, { objectiveId: objective.id, budgetProjectId: project.id, budgetTeamId: originTeam.id, budgetRootRunId: root.id });
  const delegation: PeerMessage = { ...state.messages[0], id: randomUUID(), scope: { type: 'project', id: project.id }, senderAgentId: peer.id,
    recipientAgentId: agent.id, budgetProjectId: project.id, budgetTeamId: originTeam.id, budgetRootRunId: root.id };
  state.messages.push(delegation); state.messageOrigins[delegation.id] = root.id; state.deliveryRuns[delegation.id] = source.id; source.messageIds = [delegation.id];
  const room = state.conversations[0]; room.scope = { type: 'project', id: project.id }; room.budgetProjectId = project.id; room.budgetTeamId = originTeam.id;
  const message: ConversationMessage = { id: randomUUID(), conversationId: room.id, senderAgentId: null, content: '상담', mode: 'discuss' as const,
    replyToId: null, sourceRunId: null, idempotencyKey: randomUUID(), deliveries: [], createdAt: now,
    budgetProjectId: project.id, budgetTeamId: originTeam.id };
  state.conversationMessages.push(message);
  assert.equal(objectiveRunBlock(state, source), null);
  assert.equal(consultationSource(state, agent.id, message)?.id, source.id);
  const consultation: Run = { ...structuredClone(source), id: randomUUID(), consultationOfRunId: source.id, interactionMode: 'discuss',
    waitingFor: null, status: 'queued', conversationMessageId: message.id, messageIds: [] };
  state.runs.push(consultation);
  assert.equal(consultationBlock(state, consultation), null); assert.equal(objectiveRunBlock(state, consultation), null);
  assert.ok(objectiveRunBlock(state, { ...consultation, interactionMode: 'task' }));
  assert.ok(objectiveRunBlock(state, { ...consultation, consultationOfRunId: root.id }));
  message.senderAgentId = peer.id;
  assert.ok(objectiveRunBlock(state, consultation));
});

test('side consultation requires operator discuss, identical attribution and no paused, budget or operator gate', async t => {
  const { service, agent, original, finishOriginal } = await fixture(t);
  await finishOriginal();
  const store = (service as unknown as { store: WorkspaceStore }).store;
  // Freeze admission while testing eligibility directly; this is an in-memory test store.
  const state = await store.read();
  const source = state.runs.find(item => item.id === original.input.run.id)!;
  const room = state.conversations[0];
  const message = { id: randomUUID(), conversationId: room.id, senderAgentId: null, content: '상담', mode: 'discuss' as const,
    replyToId: null, sourceRunId: null, idempotencyKey: randomUUID(), deliveries: [], createdAt: new Date().toISOString(),
    budgetProjectId: source.budgetProjectId, budgetTeamId: source.budgetTeamId };
  state.conversationMessages.push(message);
  assert.equal(consultationSource(state, agent.id, message)?.id, source.id);
  assert.equal(consultationSource(state, agent.id, { ...message, senderAgentId: agent.id }), undefined);
  assert.equal(consultationSource(state, agent.id, { ...message, mode: 'auto' }), undefined);
  assert.equal(consultationSource(state, agent.id, { ...message, mode: 'task' }), undefined);
  assert.equal(consultationSource(state, agent.id, { ...message, budgetProjectId: randomUUID() }), undefined);
  for (const change of [{ status: 'paused' }, { status: 'cancelled' }, { modelBudgetPaused: true }, { pauseRequestedAt: new Date().toISOString() }, { cleanupPending: 'pending' }]) {
    const copy = structuredClone(state); Object.assign(copy.runs.find(item => item.id === source.id)!, change);
    assert.equal(consultationSource(copy, agent.id, message), undefined);
  }
  const operatorWait = structuredClone(state); const waiting = operatorWait.runs.find(item => item.id === source.id)!;
  waiting.waitingFor = null; waiting.waitingForOperatorRequest = { requestId: randomUUID(), reason: '대표 조치 대기' };
  assert.equal(consultationSource(operatorWait, agent.id, message)?.id, source.id);
  state.operatorPaused = true; assert.equal(consultationSource(state, agent.id, message), undefined);
});

test('checkpoint publication is immutable per attempt and visible as intermediate output with artifact download', () => {
  const run = { id: randomUUID(), attempt: 1, status: 'waiting', artifacts: [], result: '', agentId: 'writer', createdAt: new Date().toISOString() } as unknown as Run;
  const output = result('중간 답변', { artifacts: [{ name: 'draft.md', content: '<script>unsafe()</script>', mediaType: 'text/markdown' }] });
  preserveCheckpointResult(run, output); const first = structuredClone(run.checkpointResults![0]);
  output.artifacts[0].content = 'mutated'; preserveCheckpointResult(run, output);
  assert.deepEqual(run.checkpointResults, [first]);
  run.attempt = 2; preserveCheckpointResult(run, output);
  assert.equal(run.checkpointResults?.length, 2); assert.equal(run.result, ''); assert.deepEqual(run.artifacts, []);
  const html = renderToStaticMarkup(createElement(RunCheckpoints, { run }));
  assert.match(html, /대기 중 보존한 결과/); assert.match(html, /최종 결과나 과제 완료를 의미하지 않습니다/);
  assert.match(html, /draft.md/); assert.match(html, /다운로드/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test('consultation output and original checkpoint are separately labeled in the actual conversation components', async t => {
  const { service, runtime, original, finishOriginal, send } = await fixture(t);
  await finishOriginal(); await send(); await until(() => runtime.calls.length === 2);
  runtime.calls[1].finish(); await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
  const workspace = await service.workspace(), consultation = workspace.runs.find(run => run.consultationOfRunId)!;
  const originalRun = workspace.runs.find(run => run.id === original.input.run.id)!;
  const message = workspace.conversationMessages!.find(item => item.sourceRunId === consultation.id)!;
  const html = renderToStaticMarkup(createElement(ConversationRun, { run: originalRun, workspace, refresh: async () => {} }));
  assert.match(html, /대기 시점 문서/); assert.match(html, /draft.md/);
  const reply = renderToStaticMarkup(createElement(ConversationMessageCard, { message, messages: workspace.conversationMessages!, workspace, onReply: () => {} }));
  assert.match(reply, /별도 상담 답변/);
});

test('backup consultation validation preserves historical scopes and rejects forged links or altered checkpoint shapes', async t => {
  const { service, runtime, finishOriginal, send } = await fixture(t);
  await finishOriginal(); await send(); await until(() => runtime.calls.length === 2);
  runtime.calls[1].finish(); await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
  const state = await (service as unknown as { store: WorkspaceStore }).store.read();
  const before = JSON.stringify(state); validateConsultationState(state); assert.equal(JSON.stringify(state), before);
  const revoked = structuredClone(state); revoked.teams = [];
  validateConsultationState(revoked);
  for (const change of [
    (copy: typeof state) => { copy.runs.find(run => run.consultationOfRunId)!.interactionMode = 'task'; },
    (copy: typeof state) => { copy.runs.find(run => run.consultationOfRunId)!.budgetRootRunId = randomUUID(); },
    (copy: typeof state) => { copy.runs.find(run => run.consultationOfRunId)!.agentId = randomUUID(); },
    (copy: typeof state) => { copy.runs.find(run => run.consultationOfRunId)!.workspaceSourceRunId = randomUUID(); },
    (copy: typeof state) => { copy.conversationMessages.find(message => message.consultationOfRunId)!.consultationOfRunId = randomUUID(); },
    (copy: typeof state) => { copy.runs.find(run => run.checkpointResults?.length)!.checkpointResults![0].attempt = -1; },
    (copy: typeof state) => { const run = copy.runs.find(run => run.checkpointResults?.length)!; run.checkpointResults!.push(structuredClone(run.checkpointResults![0])); },
  ]) { const copy = structuredClone(state); change(copy); assert.throws(() => validateConsultationState(copy)); }
});

test('container command construction uses no persistent volume or external access for consultation and preserves output attachments', async t => {
  const { runtime, finishOriginal, send } = await fixture(t);
  await finishOriginal(); await send(); await until(() => runtime.calls.length === 2);
  const input = runtime.calls[1].input;
  const config: RuntimeConfig = { mode: 'docker', auth: 'api-key', apiKey: 'test-only', authFile: '', image: 'test-only', model: 'test-only',
    timeoutMs: 10_000, persistentWorkspaces: true, workspaceKey: randomUUID() };
  const commands: string[][] = [];
  const driver = new ContainerRuntime(config, async (_file, args, options = {}) => {
    commands.push(args);
    if (args[0] === 'run') {
      const payload = JSON.parse(options.input!);
      assert.equal(payload.persistent, false); assert.equal(payload.input.run.interactionMode, 'discuss');
      assert.equal(args.some(arg => arg.includes('type=volume')), false);
      await options.onLine?.(JSON.stringify({ type: 'result', result: result('상담', { route: 'task', artifacts: [{ name: 'answer.md', content: '답변', mediaType: 'text/markdown' }] }) }));
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  const output = await driver.execute(input, { signal: new AbortController().signal, getSteering: async () => [], onEvent: async () => {}, onTool: async () => ({}) });
  assert.equal(commands.filter(args => args[0] === 'run').length, 1); assert.equal(output.route, 'discuss');
  assert.equal(output.artifacts[0].content, '답변'); assert.deepEqual(output.memories, []);
  await assert.rejects(() => driver.execute({ ...input, run: { ...input.run, workspaceSourceRunId: randomUUID() } },
    { signal: new AbortController().signal, getSteering: async () => [], onEvent: async () => {} }), /읽기 전용 입력/);
});
