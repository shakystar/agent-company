import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.ts';
import { ResourceScheduler } from '../server/resources.ts';
import type { Agent, ExecutionHooks, ExecutionInput, ExecutionResult, Run, RuntimeDriver, RuntimeInfo, Team, Workspace } from '../shared/types.ts';
import type { Conversation, ConversationMessage } from '../shared/conversations.ts';
import type { PeerMessage } from '../shared/collaboration.ts';

const result = (content = 'Actual agent response', extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
  result: content, memories: [], skills: [], artifacts: [], inputTokens: 10, outputTokens: 5, ...extra,
});
class ControlledRuntime implements RuntimeDriver {
  available = true;
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; finish: (output?: ExecutionResult) => void }> = [];
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', available: this.available, authenticated: true,
    image: 'explicit-workroom-test-only', model: 'test-only', message: 'Injected test runtime, no model', version: 'test' }; }
  async canResume(input: ExecutionInput) { return Boolean(input.checkpoint || input.previousResult); }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((finish, reject) => {
      const abort = () => reject(new Error('Controlled test shutdown'));
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks, finish: (output = result()) => {
        hooks.signal.removeEventListener('abort', abort); finish(output);
      } });
    });
  }
}
const scheduler = () => new ResourceScheduler({ capacity: { memoryMiB: 3072, cpus: 3 },
  defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Conversation API state timed out'); await delay(10); }
}
async function post<T>(app: FastifyInstance, url: string, payload: unknown, status = 201): Promise<T> {
  const response = await app.inject({ method: 'POST', url, payload: payload as object });
  assert.equal(response.statusCode, status, response.body); return response.json();
}
async function patch(app: FastifyInstance, url: string, payload: unknown) {
  const response = await app.inject({ method: 'PATCH', url, payload: payload as object });
  assert.equal(response.statusCode, 200, response.body); return response.json();
}
const workspace = async (app: FastifyInstance): Promise<Workspace> => (await app.inject({ method: 'GET', url: '/api/workspace' })).json();
async function read(app: FastifyInstance, id: string): Promise<{ conversation: Conversation; messages: ConversationMessage[]; runs: Array<Partial<Run>> }> {
  const response = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
  assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function fixture(t: TestContext, available = true) {
  const runtime = new ControlledRuntime(); runtime.available = available;
  const app = await createApp({ runtime, scheduler: scheduler() }); t.after(() => app.close());
  const alice = await post<Agent>(app, '/api/agents', { name: 'Alice', persona: 'Actual Alice with private state' });
  const bob = await post<Agent>(app, '/api/agents', { name: 'Bob', persona: 'Actual Bob with private state' });
  const team = await post<Team>(app, '/api/teams', { name: 'Peer team', memberIds: [alice.id, bob.id] });
  return { app, runtime, alice, bob, team, scope: { type: 'team' as const, id: team.id } };
}
const createRoom = (app: FastifyInstance, scope: Conversation['scope']) => post<Conversation>(app, '/api/conversations',
  { scope, title: 'Workroom', idempotencyKey: randomUUID() });
const send = (app: FastifyInstance, roomId: string, extra: Record<string, unknown> = {}) => post<ConversationMessage>(app,
  `/api/conversations/${roomId}/messages`, { content: 'Please continue the task', mode: 'task', idempotencyKey: randomUUID(), ...extra }, 202);

test('conversation API rejects forged fields, cross-site access and conflicting retries without extra writes', async t => {
  const { app, runtime, alice } = await fixture(t, false);
  const input = { scope: { type: 'agent', id: alice.id }, title: 'Personal', idempotencyKey: randomUUID() };
  const conversation = await post<Conversation>(app, '/api/conversations', input);
  assert.equal((await post<Conversation>(app, '/api/conversations', input)).id, conversation.id);
  await post(app, '/api/conversations', { ...input, title: 'Changed' }, 409);
  const payload = { content: 'Durable instruction', mode: 'task', idempotencyKey: randomUUID() };
  const [first, retry] = await Promise.all([post<ConversationMessage>(app, `/api/conversations/${conversation.id}/messages`, payload, 202),
    post<ConversationMessage>(app, `/api/conversations/${conversation.id}/messages`, payload, 202)]);
  assert.equal(first.id, retry.id);
  await post(app, `/api/conversations/${conversation.id}/messages`, { ...payload, content: 'Changed' }, 409);
  for (const fields of [{ senderAgentId: alice.id }, { sourceRunId: randomUUID() }, { deliveries: [] }]) {
    await post(app, `/api/conversations/${conversation.id}/messages`, { ...payload, ...fields }, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/messages`,
    headers: { origin: 'https://attacker.test' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}`, headers: { host: 'attacker.test' } })).statusCode, 403);
  assert.equal((await read(app, conversation.id)).messages.length, 1);
  assert.equal((await workspace(app)).conversations?.length, 1); assert.equal(runtime.calls.length, 0);
});

test('personal task and mid-run user reply reach the same actual run and publish one final response', async t => {
  const { app, runtime, alice } = await fixture(t);
  await post(app, `/api/agents/${alice.id}/memories`, { kind: 'fact', title: 'Private', content: 'private-workroom-memory' });
  const conversation = await createRoom(app, { type: 'agent', id: alice.id });
  const initial = await send(app, conversation.id);
  await until(async () => runtime.calls.length === 1);
  const call = runtime.calls[0];
  assert.equal(call.input.agent.id, alice.id); assert.equal(call.input.agent.persona, alice.persona);
  assert.equal(call.input.run.conversationId, conversation.id); assert.equal(call.input.run.conversationMessageId, initial.id);
  assert.ok(call.input.memories.some(memory => memory.content === 'private-workroom-memory'));
  assert.ok(call.input.collaboration?.tools.some(tool => tool.name === 'conversation_read'));
  const intervention = await send(app, conversation.id, { content: 'Use the revised acceptance criteria', replyToId: initial.id });
  await until(async () => (await read(app, conversation.id)).messages.find(message => message.id === intervention.id)?.deliveries[0].runId === call.input.run.id);
  const steering = await call.hooks.getSteering();
  assert.equal(steering.length, 1); assert.ok(steering[0].includes('Use the revised acceptance criteria'));
  assert.equal((await read(app, conversation.id)).messages.find(message => message.id === intervention.id)?.deliveries[0].status, 'delivered');
  await call.hooks.onCheckpoint!({ phase: 'task', sessionId: 'private-test-session', appliedSteeringCount: 1 });
  assert.equal((await read(app, conversation.id)).messages.find(message => message.id === intervention.id)?.deliveries[0].status, 'delivered');
  await call.hooks.onCheckpoint!({ phase: 'evaluate', sessionId: 'private-test-session', appliedSteeringCount: 1,
    previousResult: result('Turn processed the revised criteria', { appliedSteeringCount: 1 }) });
  await until(async () => (await read(app, conversation.id)).messages.find(message => message.id === intervention.id)?.deliveries[0].status === 'applied');
  call.finish(result('Finished with revised criteria', { appliedSteeringCount: 1 }));
  await until(async () => (await read(app, conversation.id)).runs[0]?.status === 'succeeded');
  const view = await read(app, conversation.id);
  assert.equal(view.runs.length, 1); assert.equal(runtime.calls.length, 1);
  assert.equal(view.messages.filter(message => message.sourceRunId === call.input.run.id && message.content === 'Finished with revised criteria').length, 1);
  assert.equal(view.messages.find(message => message.id === intervention.id)?.deliveries[0].status, 'answered');
  for (const secret of ['private-workroom-memory', 'private-test-session', 'Actual Alice with private state']) {
    assert.equal(JSON.stringify(view).includes(secret), false);
  }
  assert.equal('prompt' in view.runs[0], false);
});

test('team peer cooperation and user participation share real identities without broadcast fan-out', async t => {
  const { app, runtime, scope, alice, bob } = await fixture(t);
  const conversation = await createRoom(app, scope);
  await send(app, conversation.id, { recipientAgentId: alice.id });
  await until(async () => runtime.calls.length === 1);
  const first = runtime.calls[0];
  const publication = await first.hooks.onTool!('conversation_send', { conversationId: conversation.id,
    content: 'I can handle the implementation', idempotencyKey: randomUUID() }) as ConversationMessage;
  assert.equal(publication.senderAgentId, alice.id); assert.equal(publication.sourceRunId, first.input.run.id);
  assert.deepEqual(publication.deliveries, []);
  assert.equal((await workspace(app)).runs.length, 1);
  const request = await first.hooks.onTool!('conversation_send', { conversationId: conversation.id, recipientAgentId: bob.id,
    content: 'Please review this result', mode: 'task', idempotencyKey: randomUUID() }) as ConversationMessage;
  await until(async () => runtime.calls.length === 2);
  const peer = runtime.calls.find(call => call.input.agent.id === bob.id)!;
  assert.equal(peer.input.run.conversationId, conversation.id);
  assert.equal(peer.input.run.conversationMessageId, request.id);
  const intervention = await send(app, conversation.id, { content: 'Both of you use the same criteria' });
  await until(async () => (await read(app, conversation.id)).messages.find(message => message.id === intervention.id)?.deliveries.every(delivery => delivery.runId !== null) === true);
  assert.deepEqual(new Set((await read(app, conversation.id)).messages.find(message => message.id === intervention.id)!.deliveries.map(delivery => delivery.agentId)), new Set([alice.id, bob.id]));
  assert.ok((await first.hooks.getSteering()).some(content => content.includes('Both of you use the same criteria')));
  assert.ok((await peer.hooks.getSteering()).some(content => content.includes('Both of you use the same criteria')));
  first.finish(result('Implementation complete', { appliedSteeringCount: 1 }));
  peer.finish(result('Review complete', { appliedSteeringCount: 1 }));
  await until(async () => (await read(app, conversation.id)).runs.every(run => run.status === 'succeeded'));
  assert.equal((await workspace(app)).agents.length, 2); assert.equal(runtime.calls.length, 2);
});

test('a targeted teammate conversation message wakes an existing peer-wait run without creating a replacement', async t => {
  const { app, runtime, alice, bob, scope } = await fixture(t);
  const conversation = await createRoom(app, scope);
  await send(app, conversation.id, { recipientAgentId: alice.id });
  await send(app, conversation.id, { recipientAgentId: bob.id });
  await until(async () => runtime.calls.length === 2);
  const first = runtime.calls.find(call => call.input.agent.id === alice.id)!;
  const peer = runtime.calls.find(call => call.input.agent.id === bob.id)!;
  const question = await first.hooks.onTool!('message_send', { scope, recipientAgentId: null,
    content: 'Waiting for clarification', idempotencyKey: randomUUID() }) as PeerMessage;
  await first.hooks.onTool!('peer_wait', { messageId: question.id, reason: 'Clarification pending' });
  first.finish(result('Progress saved while waiting', { appliedSteeringCount: 0 }));
  await until(async () => (await read(app, conversation.id)).runs.find(run => run.id === first.input.run.id)?.status === 'waiting');
  const reply = await peer.hooks.onTool!('conversation_send', { conversationId: conversation.id, recipientAgentId: alice.id,
    content: 'I have the missing context; continue with this', mode: 'task', idempotencyKey: randomUUID() }) as ConversationMessage;
  await until(async () => runtime.calls.length === 3);
  const resumed = runtime.calls[2];
  assert.equal(resumed.input.run.id, first.input.run.id);
  assert.ok(resumed.input.run.steering.some(content => content.includes('I have the missing context')));
  assert.equal((await read(app, conversation.id)).messages.find(message => message.id === reply.id)?.deliveries[0].runId, first.input.run.id);
  resumed.finish(result('Resumed peer task finished', { appliedSteeringCount: 1 }));
  peer.finish(result('Peer task finished'));
  await until(async () => (await read(app, conversation.id)).runs.every(run => run.status === 'succeeded'));
  assert.equal((await read(app, conversation.id)).runs.length, 2);
});

test('discussion answers share agent history but cannot commit memory, skill, file or peer mutations', async t => {
  const { app, runtime, alice, scope, bob } = await fixture(t);
  const conversation = await createRoom(app, { type: 'agent', id: alice.id });
  await send(app, conversation.id, { content: 'Explain the plan without executing it', mode: 'discuss' });
  await until(async () => runtime.calls.length === 1); const call = runtime.calls[0];
  assert.equal(call.input.run.interactionMode, 'discuss');
  assert.equal(call.input.collaboration?.tools.some(tool => tool.name === 'conversation_send'), false);
  await assert.rejects(() => call.hooks.onTool!('message_send', { scope, recipientAgentId: bob.id,
    content: 'Unauthorized work', idempotencyKey: randomUUID() }), error => error instanceof Error && 'statusCode' in error && error.statusCode === 403);
  call.finish(result('A read-only plan', { memories: [{ kind: 'fact', title: 'Should not commit', content: 'No writes' }],
    skills: [{ name: 'No writes', description: '', content: 'No writes', passed: true, evaluation: 'None' }],
    artifacts: [{ name: 'not-created.txt', content: 'No writes', mediaType: 'text/plain' }] }));
  await until(async () => (await read(app, conversation.id)).runs[0]?.status === 'succeeded');
  const state = await workspace(app);
  assert.equal(state.memories.length, 0); assert.equal(state.skills.length, 0);
  assert.deepEqual(state.runs[0].artifacts, []); assert.equal(state.agents.find(agent => agent.id === alice.id)!.workspaceRunId ?? null, null);
  assert.ok((await read(app, conversation.id)).messages.some(message => message.content === 'A read-only plan'));
});

test('user joins an already running peer thread and steers the original task instead of a persona-only chat', async t => {
  const { app, runtime, alice, bob, scope } = await fixture(t);
  const original = await post<Run>(app, `/api/agents/${alice.id}/runs`, { prompt: 'An already running cooperative task' }, 202);
  await until(async () => runtime.calls.length === 1); const first = runtime.calls[0];
  const peerMessage = await first.hooks.onTool!('message_send', { scope, recipientAgentId: bob.id,
    content: 'Review in the original peer thread', idempotencyKey: randomUUID() }) as PeerMessage;
  await until(async () => runtime.calls.length === 2);
  const conversation = await post<Conversation>(app, '/api/conversations', { scope, legacyThreadId: peerMessage.threadId,
    title: 'User joins actual work', idempotencyKey: randomUUID() });
  const before = await read(app, conversation.id);
  assert.ok(before.runs.some(run => run.id === original.id));
  assert.ok(before.messages.some(message => message.sourcePeerMessageId === peerMessage.id));
  const joined = await send(app, conversation.id, { content: 'Clarifying the ongoing task as the user', recipientAgentId: alice.id });
  await until(async () => (await read(app, conversation.id)).messages.find(message => message.id === joined.id)?.deliveries[0].runId === original.id);
  assert.ok((await first.hooks.getSteering()).some(content => content.includes('Clarifying the ongoing task as the user')));
  assert.equal(runtime.calls.length, 2, 'Joining does not start a duplicate conversation persona');
  first.finish(result('Original task completed with user input', { appliedSteeringCount: 1 }));
  runtime.calls[1].finish(result('Original peer review finished'));
  await until(async () => (await read(app, conversation.id)).runs.every(run => run.status === 'succeeded'));
  assert.ok((await read(app, conversation.id)).messages.some(message => message.sourceRunId === original.id
    && message.content === 'Original task completed with user input'));
});

test('automatic mode starts read-only and changes to task mode only after an explicit routing result', async t => {
  const { app, runtime, alice } = await fixture(t);
  const conversation = await createRoom(app, { type: 'agent', id: alice.id });
  await send(app, conversation.id, { content: 'Implement the agreed change', mode: 'auto' });
  await until(async () => runtime.calls.length === 1); const classification = runtime.calls[0];
  assert.equal(classification.input.run.interactionMode, 'auto');
  assert.equal(classification.input.collaboration?.tools.some(tool => tool.name === 'conversation_send'), false);
  classification.finish(result('This is a task request', { route: 'task',
    memories: [{ kind: 'fact', title: 'Router must not write', content: 'Classification-only' }] }));
  await until(async () => runtime.calls.length === 2); const task = runtime.calls[1];
  assert.equal(task.input.run.id, classification.input.run.id);
  assert.equal(task.input.run.interactionMode, 'task'); assert.equal(task.input.run.conversationId, conversation.id);
  assert.equal(task.input.memories.length, 0);
  assert.ok(task.input.collaboration?.tools.some(tool => tool.name === 'conversation_send'));
  assert.equal((await read(app, conversation.id)).messages.some(message => message.content === 'This is a task request'), false);
  task.finish(result('Task result'));
  await until(async () => (await read(app, conversation.id)).runs[0]?.status === 'succeeded');
  assert.equal((await workspace(app)).runs.length, 1);
  assert.equal((await workspace(app)).runs[0].inputTokens, 20);
});

test('an explicit discussion is not upgraded in place by a later task', async t => {
  const { app, runtime, alice } = await fixture(t);
  const conversation = await createRoom(app, { type: 'agent', id: alice.id });
  await send(app, conversation.id, { content: 'What should we build?', mode: 'discuss' });
  await until(async () => runtime.calls.length === 1); const discussion = runtime.calls[0];
  const later = await send(app, conversation.id, { content: 'Now implement the agreed task', mode: 'task' });
  assert.deepEqual(await discussion.hooks.getSteering(), []);
  discussion.finish(result('The plan is ready'));
  await until(async () => runtime.calls.length === 2); const task = runtime.calls[1];
  assert.notEqual(task.input.run.id, discussion.input.run.id); assert.equal(task.input.run.interactionMode, 'task');
  assert.equal(task.input.run.conversationMessageId, later.id);
  task.finish(result('Implementation done'));
  await until(async () => (await read(app, conversation.id)).runs.every(run => run.status === 'succeeded'));
  assert.equal((await read(app, conversation.id)).messages.filter(message => message.senderAgentId === alice.id).length, 2);
});

test('uncertain automatic routing answers without promoting to a writing task', async t => {
  const { app, runtime, alice } = await fixture(t);
  const conversation = await createRoom(app, { type: 'agent', id: alice.id });
  await send(app, conversation.id, { content: 'What does this project need?', mode: 'auto' });
  await until(async () => runtime.calls.length === 1);
  runtime.calls[0].finish(result('A discussion answer', { memories: [{ kind: 'fact', title: 'Unapproved write', content: 'Do not commit' }] }));
  await until(async () => (await read(app, conversation.id)).runs[0]?.status === 'succeeded');
  assert.equal(runtime.calls.length, 1); assert.equal((await workspace(app)).memories.length, 0);
  assert.ok((await read(app, conversation.id)).messages.some(message => message.content === 'A discussion answer'));
});

test('explicit run pause preserves progress and intervention until the user continues; cancellation remains terminal', async t => {
  const { app, runtime, alice } = await fixture(t);
  const conversation = await createRoom(app, { type: 'agent', id: alice.id });
  await send(app, conversation.id);
  await until(async () => runtime.calls.length === 1); const first = runtime.calls[0];
  const requested = await post<Run>(app, `/api/runs/${first.input.run.id}/pause`, {}, 200);
  assert.ok(requested.pauseRequestedAt); assert.equal(requested.status, 'running');
  assert.equal(first.hooks.signal.aborted, false, 'Pause waits for the current processing boundary');
  first.finish(result('Saved partial result', { appliedSteeringCount: 0 }));
  await until(async () => (await read(app, conversation.id)).runs[0]?.status === 'paused');
  const intervention = await send(app, conversation.id, { content: 'Use this instruction on explicit resume' });
  await until(async () => (await read(app, conversation.id)).messages.find(message => message.id === intervention.id)?.deliveries[0].runId === first.input.run.id);
  assert.equal((await read(app, conversation.id)).runs[0].status, 'paused'); assert.equal(runtime.calls.length, 1);
  await post(app, `/api/runs/${first.input.run.id}/continue`, {}, 200);
  await until(async () => runtime.calls.length === 2); const resumed = runtime.calls[1];
  assert.equal(resumed.input.run.id, first.input.run.id);
  assert.ok(resumed.input.run.steering.some(content => content.includes('Use this instruction on explicit resume')));
  await post(app, `/api/runs/${first.input.run.id}/cancel`, {}, 200);
  await until(async () => (await workspace(app)).agents.find(agent => agent.id === alice.id)?.status === 'idle');
  assert.equal((await read(app, conversation.id)).runs[0].status, 'cancelled');
  await post(app, `/api/runs/${first.input.run.id}/continue`, {}, 409);
  assert.equal((await read(app, conversation.id)).messages.some(message => message.content === 'Saved partial result'), false);
});

test('revoking membership blocks running-agent conversation tools and cancels pending delivery', async t => {
  const { app, runtime, alice, bob, team, scope } = await fixture(t);
  const conversation = await createRoom(app, scope);
  await send(app, conversation.id, { recipientAgentId: alice.id });
  await until(async () => runtime.calls.length === 1); const call = runtime.calls[0];
  await patch(app, `/api/agents/${bob.id}`, { status: 'paused' });
  const pending = await send(app, conversation.id, { recipientAgentId: bob.id });
  await patch(app, `/api/teams/${team.id}`, { memberIds: [] });
  await assert.rejects(() => call.hooks.onTool!('conversation_read', { conversationId: conversation.id }),
    error => error instanceof Error && 'statusCode' in error && error.statusCode === 403);
  await assert.rejects(() => call.hooks.onTool!('conversation_send', { conversationId: conversation.id,
    content: 'Revoked sender', idempotencyKey: randomUUID() }));
  await until(async () => (await read(app, conversation.id)).messages.find(message => message.id === pending.id)?.deliveries[0].status === 'cancelled');
  call.finish(result('Must not publish after removal'));
  await until(async () => (await workspace(app)).runs[0].status === 'succeeded');
  assert.equal((await read(app, conversation.id)).messages.some(message => message.content === 'Must not publish after removal'), false);
  assert.equal(runtime.calls.length, 1);
});

test('durable conversation delivery survives restart and duplicate submission starts one actual run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-conversation-api-'));
  let app: FastifyInstance | undefined;
  try {
    const offline = new ControlledRuntime(); offline.available = false;
    app = await createApp({ runtime: offline, scheduler: scheduler(), dataDir: directory });
    const alice = await post<Agent>(app, '/api/agents', { name: 'Persistent Alice', persona: 'Persistent identity' });
    const conversation = await createRoom(app, { type: 'agent', id: alice.id });
    const payload = { content: 'Continue after runtime recovers', mode: 'task', idempotencyKey: randomUUID() };
    const original = await post<ConversationMessage>(app, `/api/conversations/${conversation.id}/messages`, payload, 202);
    assert.equal(original.deliveries[0].status, 'pending'); assert.equal(offline.calls.length, 0);
    await app.close(); app = undefined;
    const restarted = new ControlledRuntime();
    app = await createApp({ runtime: restarted, scheduler: scheduler(), dataDir: directory });
    const retry = await post<ConversationMessage>(app, `/api/conversations/${conversation.id}/messages`, payload, 202);
    assert.equal(retry.id, original.id);
    await until(async () => restarted.calls.length === 1);
    assert.equal(restarted.calls[0].input.agent.id, alice.id);
    restarted.calls[0].finish(result('Delivered once after restart'));
    await until(async () => (await read(app!, conversation.id)).runs[0]?.status === 'succeeded');
    const view = await read(app, conversation.id);
    assert.equal(view.runs.length, 1); assert.equal(view.messages.filter(message => message.senderAgentId === null).length, 1);
    assert.equal(view.messages.filter(message => message.content === 'Delivered once after restart').length, 1);
  } finally {
    await app?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /agent-company-conversation-api-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  }
});
