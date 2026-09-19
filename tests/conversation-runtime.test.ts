import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';
import { AgentService } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { ContainerRuntime, type RuntimeConfig } from '../server/runtime.ts';

const output = (result = '완료', extra: Partial<ExecutionResult> = {}): ExecutionResult => ({ result,
  memories: [], skills: [], artifacts: [], inputTokens: 10, outputTokens: 3, appliedSteeringCount: 0, ...extra });
const scheduler = () => new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
  defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });
class Runtime implements RuntimeDriver {
  workspacePersistence = true;
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; resolve: (value: ExecutionResult) => void; reject: (error: Error) => void }> = [];
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', image: 'test-only', model: 'test-only', available: true,
    authenticated: true, message: '테스트 실행기', version: 'test-only' }; }
  async canResume(input: ExecutionInput) { return Boolean(input.checkpoint || input.previousResult); }
  async settle() {}
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolveResult, reject) => {
      const abort = () => reject(new Error('interrupted'));
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks, resolve: result => { hooks.signal.removeEventListener('abort', abort); resolveResult(result); },
        reject: error => { hooks.signal.removeEventListener('abort', abort); reject(error); } });
    });
  }
}
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 12_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('테스트 상태 대기 초과'); await delay(10); }
}
async function room(service: AgentService, agentId: string) {
  return service.createConversation({ scope: { type: 'agent', id: agentId }, title: '작업 대화', idempotencyKey: randomUUID() });
}
async function pauseAtBoundary(service: AgentService, runtime: Runtime, runId: string, index = 0) {
  const requested = await service.pauseRun(runId);
  assert.ok(requested.pauseRequestedAt); assert.equal(requested.status, 'running');
  assert.equal(runtime.calls[index].hooks.signal.aborted, false);
  await runtime.calls[index].hooks.onCheckpoint!({ phase: 'evaluate', previousResult: output('중간 결과'), appliedSteeringCount: 0 })
    .catch(error => runtime.calls[index].reject(error));
  await until(async () => (await service.workspace()).runs.find(run => run.id === runId)?.status === 'paused');
  await delay(20);
}

test('operator pause waits for a durable boundary; steering cannot resume it; explicit resume retains progress', async () => {
  const runtime = new Runtime(), resources = scheduler(), service = await AgentService.create({ runtime, scheduler: resources });
  try {
    const agent = await service.createAgent({ name: '작성자', persona: '작업자' });
    const run = await service.startRun(agent.id, '문서 작성'); await until(() => runtime.calls.length === 1);
    await pauseAtBoundary(service, runtime, run.id);
    assert.equal(resources.snapshot().reserved.memoryMiB, 0);
    const steered = await service.steerRun(run.id, '제목 수정'); assert.equal(steered.status, 'paused');
    assert.equal(runtime.calls.length, 1); assert.equal((await service.workspace()).memories.length, 0);
    await service.resumeRun(run.id); await until(() => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.checkpoint?.previousResult?.result, '중간 결과');
    runtime.calls[1].resolve(output('최종 결과', { appliedSteeringCount: 1 }));
    await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
    assert.equal((await service.workspace()).runs[0].result, '최종 결과');
  } finally { await service.close(); }
});

test('queued pause releases resource waiter and cancellation cannot be resumed', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime, scheduler: scheduler() });
  try {
    const first = await service.createAgent({ name: '선행', persona: '작업' });
    const second = await service.createAgent({ name: '대기', persona: '작업' });
    const running = await service.startRun(first.id, '선행 작업'); await until(() => runtime.calls.length === 1);
    const pending = await service.startRun(second.id, '대기 작업'); await service.pauseRun(pending.id);
    runtime.calls[0].resolve(output()); await until(async () => (await service.workspace()).runs.find(run => run.id === running.id)?.status === 'succeeded');
    assert.equal(runtime.calls.length, 1);
    assert.equal((await service.workspace()).runs.find(run => run.id === pending.id)?.status, 'paused');
    await service.cancelRun(pending.id);
    await assert.rejects(service.resumeRun(pending.id), /일시정지/);
  } finally { await service.close(); }
});

test('explicit paused state survives controller restart without model replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-conversation-'));
  const runtime = new Runtime(); let service: AgentService | undefined;
  try {
    service = await AgentService.create({ runtime, scheduler: scheduler(), dataDir: directory });
    const agent = await service.createAgent({ name: '보존', persona: '작업' });
    const run = await service.startRun(agent.id, '이어서 작업'); await until(() => runtime.calls.length === 1);
    await pauseAtBoundary(service, runtime, run.id);
    await service.close(); service = undefined;
    service = await AgentService.create({ runtime, scheduler: scheduler(), dataDir: directory });
    await delay(50); assert.equal(runtime.calls.length, 1); assert.equal((await service.workspace()).runs[0].status, 'paused');
    await service.resumeRun(run.id); await until(() => runtime.calls.length === 2); runtime.calls[1].resolve(output());
    await until(async () => (await service!.workspace()).runs[0].status === 'succeeded');
  } finally {
    await service?.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /agent-company-conversation-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
  }
});

test('automatic conversation routes read-only first then executes within the same Run and accounts for both turns', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime, scheduler: scheduler() });
  try {
    const agent = await service.createAgent({ name: '실제 작성자', persona: '기억을 가진 작성자' }); const conversation = await room(service, agent.id);
    await service.sendConversation(conversation.id, { content: '보고서를 작성하라', idempotencyKey: randomUUID() });
    await until(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0].input.run.interactionMode, 'auto');
    assert.ok(runtime.calls[0].input.collaboration?.tools.every(tool => !['conversation_send', 'environment_call', 'message_send', 'task_create'].includes(tool.name)));
    runtime.calls[0].resolve(output('작업 요청 확인', { route: 'task', memories: [{ kind: 'fact', title: '분류 중 잘못된 제안', content: '보존 금지' }] }));
    await until(() => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.run.id, runtime.calls[0].input.run.id); assert.equal(runtime.calls[1].input.run.interactionMode, 'task');
    assert.equal(runtime.calls[1].input.previousResult, undefined); assert.equal((await service.workspace()).memories.length, 0);
    runtime.calls[1].resolve(output('보고서 완료')); await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
    const state = await service.workspace(); assert.equal(state.runs[0].inputTokens, 20); assert.equal(state.runs[0].outputTokens, 6);
    const view = await service.getConversation(conversation.id);
    assert.equal(view.messages.filter(message => message.senderAgentId === agent.id).length, 1);
    assert.equal(view.messages.find(message => message.senderAgentId === agent.id)?.content, '보고서 완료');
  } finally { await service.close(); }
});

test('discussion rejects mutation tools and ignores malicious growth/environment output without promoting private files', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime, scheduler: scheduler() });
  try {
    const agent = await service.createAgent({ name: '상담', persona: '분석' }); const conversation = await room(service, agent.id);
    await service.sendConversation(conversation.id, { content: '설계를 설명하라', mode: 'discuss', idempotencyKey: randomUUID() });
    await until(() => runtime.calls.length === 1);
    await assert.rejects(runtime.calls[0].hooks.onTool!('conversation_send', {}), /상담 실행/);
    await assert.rejects(runtime.calls[0].hooks.onTool!('environment_call', {}), /상담 실행/);
    runtime.calls[0].resolve(output('설계 답변', { route: 'task', memories: [{ kind: 'fact', title: '수정 금지', content: '변경 금지' }],
      skills: [{ name: '제안', content: '변경 금지', description: '', passed: true, evaluation: '근거 없음' }],
      artifacts: [{ name: 'injected.txt', content: '변경 금지', mediaType: 'text/plain' }],
      environmentProposal: { reason: '변경 금지', requestedAccess: [], spec: { packages: [], servers: [] } } }));
    await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
    const state = await service.workspace(); assert.equal(state.memories.length, 0); assert.equal(state.skills.length, 0);
    assert.equal(state.environmentRevisions?.length, 0); assert.equal(state.runs[0].artifacts.length, 0); assert.equal(state.agents[0].workspaceRunId, undefined);
    assert.equal(runtime.calls.length, 1); assert.equal((await service.getConversation(conversation.id)).messages.at(-1)?.content, '설계 답변');
  } finally { await service.close(); }
});

test('operator participates in the actual team run; delivery is idempotent and only acknowledged at a durable boundary', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime, scheduler: scheduler() });
  try {
    const first = await service.createAgent({ name: '작성', persona: '작성' }); const second = await service.createAgent({ name: '검토', persona: '검토' });
    const team = await service.createTeam({ name: '동료', memberIds: [first.id, second.id] });
    const conversation = await service.createConversation({ scope: { type: 'team', id: team.id }, title: '공동 작업', idempotencyKey: randomUUID() });
    await service.sendConversation(conversation.id, { content: '공동 문서를 작성하라', mode: 'task', recipientAgentId: first.id, idempotencyKey: randomUUID() });
    await until(() => runtime.calls.length === 1); const runId = runtime.calls[0].input.run.id;
    const followup = { content: '제목은 함께 검토하겠습니다', mode: 'discuss', recipientAgentId: first.id, idempotencyKey: randomUUID() };
    const sent = await service.sendConversation(conversation.id, followup); await service.sendConversation(conversation.id, followup);
    await until(async () => (await service.workspace()).runs[0].steering.length === 1);
    let view = await service.getConversation(conversation.id);
    assert.equal(view.messages.find(message => message.id === sent.id)?.deliveries[0].status, 'delivered');
    await runtime.calls[0].hooks.onCheckpoint!({ phase: 'evaluate', previousResult: output('반영', { appliedSteeringCount: 1 }), appliedSteeringCount: 1 });
    view = await service.getConversation(conversation.id); assert.equal(view.messages.find(message => message.id === sent.id)?.deliveries[0].status, 'applied');
    const peer = await runtime.calls[0].hooks.onTool!('conversation_send', { conversationId: conversation.id, content: '제목 검토 부탁합니다',
      recipientAgentId: second.id, mode: 'discuss', idempotencyKey: randomUUID() }) as { sourceRunId: string };
    assert.equal(peer.sourceRunId, runId);
    runtime.calls[0].resolve(output('작성 완료', { appliedSteeringCount: 1 })); await until(() => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.agent.id, second.id); assert.equal(runtime.calls[1].input.run.conversationId, conversation.id);
    runtime.calls[1].resolve(output('검토 완료')); await until(async () => (await service.workspace()).runs.every(run => run.status === 'succeeded'));
    view = await service.getConversation(conversation.id); assert.ok(view.messages.some(message => message.content === '제목 검토 부탁합니다'));
    assert.equal(view.messages.filter(message => message.id === sent.id).length, 1);
  } finally { await service.close(); }
});

test('a task arriving during a read-only discussion waits for its own routing Run', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime, scheduler: scheduler() });
  try {
    const agent = await service.createAgent({ name: '분리', persona: '작업' }); const conversation = await room(service, agent.id);
    await service.sendConversation(conversation.id, { content: '설명을 듣고 싶습니다', mode: 'discuss', idempotencyKey: randomUUID() });
    await until(() => runtime.calls.length === 1);
    await service.sendConversation(conversation.id, { content: '이제 파일을 작성하라', mode: 'task', idempotencyKey: randomUUID() });
    await delay(50); assert.equal((await service.workspace()).runs[0].steering.length, 0);
    runtime.calls[0].resolve(output('설명')); await until(() => runtime.calls.length === 2);
    assert.notEqual(runtime.calls[0].input.run.id, runtime.calls[1].input.run.id); assert.equal(runtime.calls[1].input.run.interactionMode, 'task');
    runtime.calls[1].resolve(output('파일 완료')); await until(async () => (await service.workspace()).runs.every(run => run.status === 'succeeded'));
  } finally { await service.close(); }
});

test('latest operator instruction is atomically attached before automatic routing can launch a writer', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime, scheduler: scheduler() });
  try {
    const agent = await service.createAgent({ name: '최신 지시', persona: '작업' }); const conversation = await room(service, agent.id);
    await service.sendConversation(conversation.id, { content: '파일을 작성하라', idempotencyKey: randomUUID() });
    await until(() => runtime.calls.length === 1);
    await service.sendConversation(conversation.id, { content: '아직 작성하지 말고 먼저 설명하라', idempotencyKey: randomUUID() });
    assert.equal((await service.workspace()).runs[0].steering.length, 1, 'accepted message and steering share the completion transaction lock');
    runtime.calls[0].resolve(output('처음 지시는 작업', { route: 'task' }));
    await until(() => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.run.interactionMode, 'auto');
    assert.match(runtime.calls[1].input.run.steering[0], /작성하지 말고/);
    runtime.calls[1].resolve(output('설명만 진행했습니다', { route: 'discuss', appliedSteeringCount: 1 }));
    await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
    assert.equal(runtime.calls.length, 2); assert.equal((await service.workspace()).agents[0].workspaceRunId, undefined);
  } finally { await service.close(); }
});

test('container discussion executes one phase and suppresses all growth proposals', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime, scheduler: scheduler() });
  try {
    const agent = await service.createAgent({ name: '맥락', persona: '실제 에이전트' }); const conversation = await room(service, agent.id);
    await service.sendConversation(conversation.id, { content: '검토 의견', mode: 'discuss', idempotencyKey: randomUUID() }); await until(() => runtime.calls.length === 1);
    const config: RuntimeConfig = { mode: 'docker', auth: 'api-key', apiKey: 'test-only', authFile: '', image: 'test-only', model: 'test-only', timeoutMs: 10_000 };
    let starts = 0;
    const driver = new ContainerRuntime(config, async (_file, args, options = {}) => {
      if (args[0] === 'run') { starts++; const payload = JSON.parse(options.input!); assert.equal(payload.input.run.interactionMode, 'discuss');
        await options.onLine?.(JSON.stringify({ type: 'result', result: { ...output('상담', { route: 'task' }), skills: [{ name: '금지', description: '', content: '제안' }] } })); }
      return { code: 0, stdout: 'test-only', stderr: '' };
    });
    const result = await driver.execute(runtime.calls[0].input, { signal: new AbortController().signal, getSteering: async () => [], onEvent: async () => {}, onTool: async () => ({}) });
    assert.equal(starts, 1); assert.equal(result.route, 'discuss'); assert.deepEqual(result.skills, []); assert.deepEqual(result.memories, []);
    const worker = await readFile(new URL('../worker/entry.mjs', import.meta.url), 'utf8');
    assert.match(worker, /discussing \? 'read-only' : 'workspace-write'/);
    runtime.calls[0].resolve(result); await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
  } finally { await service.close(); }
});
