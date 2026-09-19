import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { mutateCollaboration } from '../server/collaboration.ts';
import {
  createConversation, postConversationMessage, readConversation, mutateConversation,
  conversationContext, canAccessConversation, publishConversationResult, mirrorPeerMessage, reconcileConversationDeliveries,
} from '../server/conversations.ts';
import type { WorkspaceState } from '../server/store.ts';
import type { Agent, Run } from '../shared/types.ts';
import type { PeerMessage } from '../shared/collaboration.ts';
import { conversationTools, type ConversationState, type Conversation } from '../shared/conversations.ts';
import { createOperatorRequest, decideOperatorRequest, progressOperatorRequest, verifyOperatorRequest } from '../server/operator-requests.ts';
import { validOperatorContinuation } from '../server/operator-request-resume.ts';

type State = WorkspaceState & ConversationState;
const timestamp = '2026-09-06T00:00:00.000Z';
function agent(name: string): Agent {
  return { id: randomUUID(), name, description: '', persona: `private-persona-${name}`, color: '#123456',
    model: 'test-model', status: 'idle', generation: 1, parentId: null, parentSnapshotId: null,
    version: 1, allowWeb: false, repositoryIds: [], createdAt: timestamp, updatedAt: timestamp };
}
function fixture() {
  const [alice, bob, carol, outsider] = ['Alice', 'Bob', 'Carol', 'Outside'].map(agent);
  const team = { id: randomUUID(), name: 'Peers', description: '', workflow: 'Collaborate as peers',
    memberIds: [alice.id, bob.id, carol.id], version: 1, createdAt: timestamp, updatedAt: timestamp };
  const state: State = { agents: [alice, bob, carol, outsider], teams: [team], runs: [], memories: [],
    skills: [], snapshots: [], activities: [], approvals: [], connections: [], executionStates: {},
    projects: [], sharedArtifacts: [], teamTasks: [], messages: [], deliveryRuns: {}, messageOrigins: {},
    files: [], fileVersions: [], operatorPaused: false, skillRevisions: [], growthReviews: [], repairJobs: [],
    modelAttempts: [], environmentRevisions: [], conversations: [], conversationMessages: [], objectives: [], objectiveEvaluations: [], operatorRequests: [] };
  return { state, alice, bob, carol, outsider, team, scope: { type: 'team' as const, id: team.id } };
}
function reject(status: number, action: () => unknown) {
  assert.throws(action, error => status === 400 && error instanceof ZodError
    || error instanceof Error && 'statusCode' in error && error.statusCode === status);
}
function room(state: State, scope: Conversation['scope']) {
  return createConversation(state, { scope, title: 'Shared work', idempotencyKey: randomUUID() });
}
function send(state: State, conversation: Conversation, actor: string | null = null,
  extra: Record<string, unknown> = {}) {
  return postConversationMessage(state, actor, conversation.id,
    { content: 'Continue in this actual work conversation', mode: 'auto', idempotencyKey: randomUUID(), ...extra });
}
function run(owner: Agent, conversation: Conversation, extra: Partial<Run> = {}): Run {
  return { id: randomUUID(), agentId: owner.id, agentVersion: 1, snapshotId: randomUUID(),
    prompt: 'private-run-prompt', status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0,
    artifacts: [], steering: [], createdAt: timestamp, startedAt: timestamp, completedAt: null,
    conversationId: conversation.id, kind: 'task', ...extra };
}

test('personal room belongs to the actual agent and the user, without a second persona copy', () => {
  const { state, alice, bob } = fixture();
  const conversation = room(state, { type: 'agent', id: alice.id });
  assert.deepEqual(conversation.participantAgentIds, [alice.id]);
  const message = send(state, conversation, null, { mode: 'discuss' });
  assert.equal(message.senderAgentId, null);
  assert.deepEqual(message.deliveries.map(item => item.agentId), [alice.id]);
  assert.equal(readConversation(state, alice.id, conversation.id).messages[0].id, message.id);
  assert.equal(readConversation(state, null, conversation.id).conversation.id, conversation.id);
  reject(403, () => readConversation(state, bob.id, conversation.id));
  assert.equal(state.agents.length, 4);
});

test('room creation and message retries are idempotent; changed payloads conflict', () => {
  const { state, scope, bob } = fixture();
  const input = { scope, title: 'One room', idempotencyKey: randomUUID() };
  const conversation = createConversation(state, input);
  assert.equal(createConversation(state, input).id, conversation.id);
  assert.equal(state.conversations.length, 1);
  reject(409, () => createConversation(state, { ...input, title: 'Changed title' }));
  const payload = { content: 'One instruction', mode: 'task' as const, recipientAgentId: bob.id,
    idempotencyKey: randomUUID() };
  const message = postConversationMessage(state, null, conversation.id, payload);
  assert.equal(postConversationMessage(state, null, conversation.id, payload).id, message.id);
  assert.equal(state.conversationMessages.length, 1);
  for (const change of [{ content: 'Different instruction' }, { mode: 'discuss' }, { recipientAgentId: undefined }]) {
    reject(409, () => postConversationMessage(state, null, conversation.id, { ...payload, ...change }));
  }
  assert.equal(state.conversationMessages.length, 1);
});

test('new group rooms permit current peers, user participation and immediate membership revocation', () => {
  const { state, scope, alice, bob, carol, outsider, team } = fixture();
  const conversation = room(state, scope);
  assert.deepEqual(new Set(conversation.participantAgentIds), new Set([alice.id, bob.id, carol.id]));
  const message = send(state, conversation, alice.id);
  assert.equal(readConversation(state, carol.id, conversation.id).messages[0].id, message.id);
  reject(403, () => readConversation(state, outsider.id, conversation.id));
  team.memberIds = [bob.id, carol.id];
  assert.equal(canAccessConversation(state, alice.id, conversation.id), false);
  reject(403, () => readConversation(state, alice.id, conversation.id));
  reject(403, () => send(state, conversation, alice.id));
  reject(403, () => send(state, conversation, null, { recipientAgentId: alice.id }));
  assert.equal(readConversation(state, null, conversation.id).messages[0].id, message.id);
});

test('user joins an existing two-peer thread without exposing it to all team members', () => {
  const { state, scope, alice, bob, carol } = fixture();
  const original = mutateCollaboration(state, alice.id, 'message_send', {
    scope, recipientAgentId: bob.id, content: 'Peer review in progress', idempotencyKey: randomUUID(),
  }) as PeerMessage;
  const reply = mutateCollaboration(state, bob.id, 'message_send', { scope, recipientAgentId: alice.id,
    content: 'Review response', replyToId: original.id, idempotencyKey: randomUUID() }) as PeerMessage;
  const conversation = createConversation(state, { scope, title: 'Join peer thread',
    legacyThreadId: original.threadId, idempotencyKey: randomUUID() });
  assert.deepEqual(new Set(conversation.participantAgentIds), new Set([alice.id, bob.id]));
  const joined = readConversation(state, null, conversation.id);
  assert.ok(joined.messages.some(message => message.sourcePeerMessageId === original.id));
  assert.ok(joined.messages.some(message => message.sourcePeerMessageId === reply.id));
  const intervention = send(state, conversation, null, { content: 'I am joining the ongoing review', recipientAgentId: bob.id });
  assert.equal(intervention.senderAgentId, null);
  assert.ok(readConversation(state, alice.id, conversation.id).messages.some(message => message.id === intervention.id));
  reject(403, () => readConversation(state, carol.id, conversation.id));
  reject(403, () => send(state, conversation, carol.id));
  reject(403, () => send(state, conversation, null, { recipientAgentId: carol.id }));
  assert.equal(state.messages.length, 2, 'Joining must not rewrite the historical peer protocol');
});

test('legacy thread cannot be attached to another scope or to a personal room', () => {
  const { state, scope, alice, bob } = fixture();
  const message = mutateCollaboration(state, alice.id, 'message_send', { scope, recipientAgentId: bob.id,
    content: 'Scoped thread', idempotencyKey: randomUUID() }) as PeerMessage;
  const another = { ...state.teams[0], id: randomUUID() }; state.teams.push(another);
  for (const wrongScope of [{ type: 'team' as const, id: another.id }, { type: 'agent' as const, id: alice.id }]) {
    assert.throws(() => createConversation(state, { scope: wrongScope, legacyThreadId: message.threadId,
      idempotencyKey: randomUUID() }));
  }
  assert.equal(state.conversations.length, 0);
});

test('user broadcast targets in-room active runs; peer broadcast never fans out new executions', () => {
  const { state, scope, alice, bob, carol } = fixture();
  const conversation = room(state, scope);
  const unrelated = room(state, { type: 'agent', id: carol.id });
  state.runs.push(run(alice, conversation), run(bob, conversation, { status: 'waiting' }), run(carol, unrelated));
  const userMessage = send(state, conversation);
  assert.deepEqual(new Set(userMessage.deliveries.map(item => item.agentId)), new Set([alice.id, bob.id]));
  const peerMessage = send(state, conversation, alice.id);
  assert.equal(peerMessage.deliveries.length, 0, 'An ordinary peer publication must not create an infinite broadcast loop');
  const directed = send(state, conversation, alice.id, { recipientAgentId: bob.id });
  assert.deepEqual(directed.deliveries.map(item => item.agentId), [bob.id]);
});

test('new user broadcast chooses one idle peer instead of an unrelated busy peer or the whole team', () => {
  const { state, scope, alice, bob, carol } = fixture();
  const conversation = room(state, scope);
  alice.status = 'running'; carol.status = 'paused';
  state.runs.push(run(alice, room(state, { type: 'agent', id: alice.id })));
  const message = send(state, conversation);
  assert.deepEqual(message.deliveries.map(item => item.agentId), [bob.id]);
});

test('replies stay in their room and callers cannot forge sender, delivery state or source run', () => {
  const { state, scope, alice, bob } = fixture();
  const conversation = room(state, scope), another = room(state, { type: 'agent', id: alice.id });
  const foreign = send(state, another);
  assert.throws(() => send(state, conversation, alice.id, { replyToId: foreign.id }));
  for (const fields of [{ senderAgentId: bob.id }, { sourceRunId: randomUUID() }, { deliveries: [] }]) {
    reject(400, () => send(state, conversation, alice.id, fields));
  }
  assert.equal(state.conversationMessages.length, 1);
});

test('project conversation access follows current project teams and excludes removed teams immediately', () => {
  const { state, scope, alice, outsider } = fixture();
  const otherTeam = { ...state.teams[0], id: randomUUID(), memberIds: [outsider.id] }; state.teams.push(otherTeam);
  const project = { id: randomUUID(), name: 'Cross-team', description: '', teamIds: [scope.id, otherTeam.id],
    version: 1, createdAt: timestamp, updatedAt: timestamp }; state.projects.push(project);
  const conversation = createConversation(state, { scope: { type: 'project', id: project.id },
    title: 'Shared work', budgetTeamId: scope.id, idempotencyKey: randomUUID() });
  send(state, conversation, alice.id);
  assert.equal(readConversation(state, outsider.id, conversation.id).messages.length, 1);
  project.teamIds = [scope.id];
  reject(403, () => readConversation(state, outsider.id, conversation.id));
  reject(403, () => send(state, conversation, outsider.id));
});

test('public conversation projections exclude private memory, run prompts and execution data', () => {
  const { state, scope, alice, bob } = fixture(); const conversation = room(state, scope);
  const active = run(alice, conversation); state.runs.push(active);
  state.memories.push({ id: randomUUID(), agentId: alice.id, kind: 'fact', title: 'Private',
    content: 'private-memory-secret', sourceRunId: null, createdAt: timestamp, updatedAt: timestamp });
  state.executionStates[active.id] = { input: { agent: alice, memories: state.memories, skills: [], connections: [] },
    inputTokens: 0, outputTokens: 0, lastSessionId: 'private-session-secret' };
  send(state, conversation, alice.id, { content: 'Intentionally published result' });
  const publicView = readConversation(state, bob.id, conversation.id);
  const serialized = JSON.stringify({ publicView, context: conversationContext(state, bob.id, conversation.id) });
  assert.ok(serialized.includes('Intentionally published result'));
  for (const secret of ['private-memory-secret', 'private-run-prompt', 'private-session-secret', 'private-persona-Alice']) {
    assert.equal(serialized.includes(secret), false, `Must not expose ${secret}`);
  }
  assert.equal('prompt' in publicView.runs[0], false);
  assert.equal('executionStates' in publicView, false);
});

test('only successful final results publish once and never schedule automatic reply fan-out', () => {
  const { state, scope, alice } = fixture(); const conversation = room(state, scope);
  const request = send(state, conversation, null, { recipientAgentId: alice.id });
  const active = run(alice, conversation, { conversationMessageId: request.id, result: 'Published final result' });
  state.runs.push(active); request.deliveries[0].runId = active.id;
  state.conversationMessages.find(message => message.id === request.id)!.deliveries[0].runId = active.id;
  for (const status of ['running', 'paused', 'waiting', 'failed', 'cancelled'] as const) {
    active.status = status; publishConversationResult(state, active);
    assert.equal(state.conversationMessages.length, 1);
  }
  active.status = 'succeeded'; publishConversationResult(state, active); publishConversationResult(state, active);
  assert.equal(state.conversationMessages.length, 2);
  const result = state.conversationMessages[1];
  assert.equal(result.sourceRunId, active.id); assert.equal(result.replyToId, request.id);
  assert.equal(result.content, active.result); assert.deepEqual(result.deliveries, []);
  assert.equal(state.conversationMessages[0].deliveries[0].status, 'answered');
});

test('delivery acknowledgement needs an applied steering boundary and never revives cancellation', () => {
  const { state, scope, alice, team } = fixture(); const conversation = room(state, scope);
  const request = send(state, conversation, null, { recipientAgentId: alice.id });
  const active = run(alice, conversation, { steering: ['first', 'second'], appliedSteeringCount: 1 });
  state.runs.push(active);
  const delivery = state.conversationMessages.find(message => message.id === request.id)!.deliveries[0];
  Object.assign(delivery, { runId: active.id, steeringIndex: 1, status: 'delivered' });
  reconcileConversationDeliveries(state); assert.equal(delivery.status, 'delivered');
  active.appliedSteeringCount = 2; reconcileConversationDeliveries(state); assert.equal(delivery.status, 'applied');
  active.status = 'cancelled'; reconcileConversationDeliveries(state); assert.equal(delivery.status, 'cancelled');
  active.status = 'succeeded'; reconcileConversationDeliveries(state); assert.equal(delivery.status, 'cancelled');
  const pending = send(state, conversation, null, { recipientAgentId: alice.id });
  team.memberIds = [];
  reconcileConversationDeliveries(state);
  assert.equal(state.conversationMessages.find(message => message.id === pending.id)!.deliveries[0].status, 'cancelled');
  publishConversationResult(state, { ...active, result: 'No longer authorized to publish' });
  assert.equal(state.conversationMessages.length, 2);
});

test('peer exchange mirroring is idempotent and never leaks a different scope or excluded recipient', () => {
  const { state, scope, alice, bob, carol } = fixture();
  const original = mutateCollaboration(state, alice.id, 'message_send', { scope, recipientAgentId: bob.id,
    content: 'Historical request', idempotencyKey: randomUUID() }) as PeerMessage;
  const conversation = createConversation(state, { scope, legacyThreadId: original.threadId, idempotencyKey: randomUUID() });
  const active = run(alice, conversation); state.runs.push(active);
  const peer = mutateCollaboration(state, alice.id, 'message_send', { scope, recipientAgentId: bob.id,
    content: 'Actual next peer exchange', threadId: original.threadId, idempotencyKey: randomUUID() }) as PeerMessage;
  mirrorPeerMessage(state, active, peer); mirrorPeerMessage(state, active, peer);
  assert.equal(state.conversationMessages.filter(message => message.sourcePeerMessageId === peer.id).length, 1);
  const excluded = mutateCollaboration(state, alice.id, 'message_send', { scope, recipientAgentId: carol.id,
    content: 'Separate private peer exchange', idempotencyKey: randomUUID() }) as PeerMessage;
  mirrorPeerMessage(state, active, excluded);
  assert.equal(state.conversationMessages.some(message => message.sourcePeerMessageId === excluded.id), false);
  const other = { ...peer, id: randomUUID(), scope: { type: 'team' as const, id: randomUUID() } };
  mirrorPeerMessage(state, active, other);
  assert.equal(state.conversationMessages.some(message => message.sourcePeerMessageId === other.id), false);
});

test('conversation tools expose strict schemas and recheck access for reads and sends', () => {
  const { state, scope, alice, outsider } = fixture(); const conversation = room(state, scope);
  for (const tool of conversationTools) {
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(conversationTools.map(tool => tool.name).sort(), ['conversation_list', 'conversation_read', 'conversation_send']);
  assert.throws(() => mutateConversation(state, outsider.id, 'conversation_read', { conversationId: conversation.id }));
  assert.throws(() => mutateConversation(state, outsider.id, 'conversation_send', { conversationId: conversation.id,
    content: 'Unauthorized', idempotencyKey: randomUUID() }));
  const read = mutateConversation(state, alice.id, 'conversation_read', { conversationId: conversation.id });
  assert.ok(read);
  assert.equal(state.conversationMessages.length, 0);
});

function continuationFixture() {
  const f = fixture(), conversation = room(f.state, f.scope);
  const sent = send(f.state, conversation, null, { mode: 'task', recipientAgentId: f.alice.id });
  const message = f.state.conversationMessages.find(item => item.id === sent.id)!;
  const original = run(f.alice, conversation, { status: 'waiting', conversationMessageId: message.id,
    budgetProjectId: null, budgetTeamId: f.team.id });
  original.budgetRootRunId = original.id; f.state.runs.push(original);
  Object.assign(message.deliveries[0], { runId: original.id, status: 'delivered' });
  const continueRun = (source: Run, status: Run['status'] = 'running') => {
    const input = { scope: f.scope, category: 'other' as const, title: '업무 입력 요청', reason: '입력을 기다립니다',
      requestedAction: '입력 제공', requestedScope: '현재 업무', verificationCriteria: '입력 확인', idempotencyKey: randomUUID() };
    const request = createOperatorRequest(f.state, f.alice.id, input, source.id);
    const approved = decideOperatorRequest(f.state, { kind: 'operator' }, request.id,
      { expectedVersion: request.version, status: 'approved', reason: '범위 승인' });
    const ready = progressOperatorRequest(f.state, { kind: 'operator' }, request.id,
      { expectedVersion: approved.version, status: 'verification_pending', detail: '입력 확인 중' });
    const verified = verifyOperatorRequest(f.state, { kind: 'operator' }, request.id,
      { expectedVersion: ready.version, method: 'manual', passed: true, evidence: '입력 확인 근거', detail: '입력 확인 완료' });
    const child: Run = { ...structuredClone(source), id: randomUUID(), status, result: '', continuedFromRunId: source.id,
      continuedByRunId: undefined, operatorRequestId: request.id, appliedSteeringCount: 0 };
    source.status = 'superseded'; source.continuedByRunId = child.id; f.state.runs.push(child);
    f.state.operatorRequests.find(item => item.id === request.id)!.resumeReceipts.push({ runId: source.id, continuedRunId: child.id,
      at: timestamp, contentVersion: verified.contentVersion, verificationId: verified.verification!.id });
    assert.equal(validOperatorContinuation(f.state, child)?.id, source.id);
    return child;
  };
  return { ...f, conversation, original, message, continueRun };
}

test('verified continuation answers the original conversation delivery without rewriting sender or run provenance', () => {
  const f = continuationFixture(), child = f.continueRun(f.original, 'succeeded'); child.result = '이어받은 작업 완료';
  const provenance = { senderAgentId: f.message.senderAgentId, sourceRunId: f.message.sourceRunId, runId: f.message.deliveries[0].runId };
  publishConversationResult(f.state, child); reconcileConversationDeliveries(f.state);
  assert.equal(f.message.deliveries[0].status, 'answered');
  assert.deepEqual({ senderAgentId: f.message.senderAgentId, sourceRunId: f.message.sourceRunId, runId: f.message.deliveries[0].runId }, provenance);
  assert.equal(f.state.conversationMessages.filter(item => item.sourceRunId === child.id).length, 1);
  assert.equal(f.state.conversationMessages.find(item => item.sourceRunId === child.id)?.replyToId, f.message.id);
  publishConversationResult(f.state, child); assert.equal(f.state.conversationMessages.filter(item => item.sourceRunId === child.id).length, 1);
});

test('multi-step continuation checks the latest child and preserves applied steering until a real final response', () => {
  const f = continuationFixture();
  const steered = send(f.state, f.conversation, null, { mode: 'task', recipientAgentId: f.alice.id });
  const steering = f.state.conversationMessages.find(item => item.id === steered.id)!;
  Object.assign(steering.deliveries[0], { runId: f.original.id, steeringIndex: 0, status: 'delivered' });
  f.original.steering = ['추가 사용자 지시'];
  const first = f.continueRun(f.original), latest = f.continueRun(first);
  latest.appliedSteeringCount = 1; reconcileConversationDeliveries(f.state);
  assert.equal(f.message.deliveries[0].status, 'delivered'); assert.equal(steering.deliveries[0].status, 'applied');
  latest.status = 'succeeded'; latest.result = '최종 완료'; publishConversationResult(f.state, latest);
  assert.equal(f.message.deliveries[0].status, 'answered'); assert.equal(steering.deliveries[0].status, 'answered');
  assert.equal(f.message.deliveries[0].runId, f.original.id); assert.equal(steering.deliveries[0].runId, f.original.id);
});

test('latest continuation cancellation cancels original delivery and cannot be revived by late success', () => {
  const f = continuationFixture(), child = f.continueRun(f.continueRun(f.original), 'cancelled');
  reconcileConversationDeliveries(f.state); assert.equal(f.message.deliveries[0].status, 'cancelled');
  child.status = 'succeeded'; reconcileConversationDeliveries(f.state);
  assert.equal(f.message.deliveries[0].status, 'cancelled'); assert.equal(f.message.deliveries[0].runId, f.original.id);
});

for (const change of ['receipt', 'verification', 'agent', 'room', 'message', 'root', 'cycle'] as const) {
  test(`unverified or altered continuation cannot answer an original delivery: ${change}`, () => {
    const f = continuationFixture(), child = f.continueRun(f.original, 'succeeded');
    if (change === 'receipt') f.state.operatorRequests[0].resumeReceipts = [];
    if (change === 'verification') f.state.operatorRequests[0].history = [];
    if (change === 'agent') child.agentId = f.bob.id;
    if (change === 'room') child.conversationId = room(f.state, { type: 'agent', id: f.alice.id }).id;
    if (change === 'message') child.conversationMessageId = randomUUID();
    if (change === 'root') child.budgetRootRunId = randomUUID();
    if (change === 'cycle') { child.status = 'superseded'; child.continuedByRunId = f.original.id; }
    reconcileConversationDeliveries(f.state);
    assert.equal(f.message.deliveries[0].status, 'delivered'); assert.equal(f.message.deliveries[0].runId, f.original.id);
  });
}

test('current conversation membership revocation takes precedence over a completed verified continuation', () => {
  const f = continuationFixture(); f.continueRun(f.original, 'succeeded');
  f.team.memberIds = [f.bob.id]; reconcileConversationDeliveries(f.state);
  assert.equal(f.message.deliveries[0].status, 'cancelled');
});

function privateDelegationFixture(withObjective = true) {
  const f = fixture();
  f.team.memberIds = [f.alice.id];
  const originTeam = { ...f.team, id: randomUUID(), memberIds: [f.bob.id] }; f.state.teams.push(originTeam);
  const project = { id: randomUUID(), name: '공유 제작', description: '', teamIds: [f.team.id, originTeam.id], version: 1, createdAt: timestamp, updatedAt: timestamp };
  f.state.projects.push(project);
  const originalRoom = createConversation(f.state, { scope: { type: 'project', id: project.id }, title: '공동 작업',
    budgetTeamId: originTeam.id, idempotencyKey: randomUUID() });
  const root = run(f.bob, originalRoom, { status: 'succeeded', budgetProjectId: project.id, budgetTeamId: originTeam.id }); root.budgetRootRunId = root.id;
  const source = run(f.alice, originalRoom, { status: 'waiting', budgetProjectId: project.id, budgetTeamId: originTeam.id, budgetRootRunId: root.id });
  f.state.runs.push(root, source);
  if (withObjective) {
    const objective = { id: randomUUID(), idempotencyKey: randomUUID(), teamId: originTeam.id, scope: { type: 'project' as const, id: project.id },
      title: '공동 목적', purpose: '승인된 제작', constraints: '', conditions: [{ id: 'done', text: '완료', requiresUserConfirmation: false }], confirmations: [],
      status: 'active' as const, version: 1, blockedReason: null, lastInputHash: null, lastEvaluationId: null, createdAt: timestamp, updatedAt: timestamp };
    f.state.objectives.push(objective); root.objectiveId = objective.id; source.objectiveId = objective.id;
  }
  const peer: PeerMessage = { id: randomUUID(), threadId: randomUUID(), scope: { type: 'project', id: project.id }, senderAgentId: f.bob.id,
    recipientAgentId: f.alice.id, content: '합법 제작 위임', taskId: null, replyToId: null, artifactIds: [], idempotencyKey: randomUUID(), status: 'delivered',
    createdAt: timestamp, deliveredAt: timestamp, completedAt: null, budgetProjectId: project.id, budgetTeamId: originTeam.id, budgetRootRunId: root.id };
  f.state.messages.push(peer); f.state.messageOrigins[peer.id] = root.id; f.state.deliveryRuns[peer.id] = source.id; source.messageIds = [peer.id];
  const input = { scope: { type: 'agent' as const, id: f.alice.id }, title: '개인 환경 요청 상담', idempotencyKey: randomUUID(),
    budgetProjectId: project.id, budgetTeamId: originTeam.id };
  return { ...f, originTeam, project, root, source, peer, input };
}

for (const withObjective of [true, false]) test(`trusted private consultation preserves delegated billing without publishing to the project (objective=${withObjective})`, () => {
  const f = privateDelegationFixture(withObjective);
  reject(403, () => createConversation(f.state, f.input));
  const sourceBefore = structuredClone(f.source);
  const conversation = createConversation(f.state, f.input, { sourceRunId: f.source.id });
  assert.deepEqual(conversation.scope, { type: 'agent', id: f.alice.id });
  assert.deepEqual(conversation.participantAgentIds, [f.alice.id]);
  assert.equal(conversation.budgetProjectId, f.project.id); assert.equal(conversation.budgetTeamId, f.originTeam.id);
  assert.equal(canAccessConversation(f.state, f.bob.id, conversation.id), false);
  assert.deepEqual(f.source, sourceBefore);
  const message = postConversationMessage(f.state, null, conversation.id,
    { content: '개인 환경 설명', mode: 'discuss', recipientAgentId: f.alice.id, idempotencyKey: randomUUID() });
  assert.equal(message.budgetTeamId, f.originTeam.id); assert.equal(message.budgetProjectId, f.project.id);
  assert.equal(createConversation(f.state, f.input, { sourceRunId: f.source.id }).id, conversation.id);
  reject(403, () => readConversation(f.state, f.bob.id, conversation.id));
});

test('public conversation input cannot supply trusted source context or impersonate another source agent', () => {
  const f = privateDelegationFixture();
  reject(400, () => createConversation(f.state, { ...f.input, sourceRunId: f.source.id }));
  reject(400, () => createConversation(f.state, { ...f.input, context: { sourceRunId: f.source.id } }));
  reject(404, () => createConversation(f.state, f.input, { sourceRunId: randomUUID() }));
  reject(403, () => createConversation(f.state, f.input, { sourceRunId: f.root.id }));
  reject(403, () => createConversation(f.state, { ...f.input, scope: { type: 'project', id: f.project.id } }, { sourceRunId: f.source.id }));
  reject(403, () => createConversation(f.state, { ...f.input, budgetTeamId: f.team.id }, { sourceRunId: f.source.id }));
  reject(403, () => createConversation(f.state, { ...f.input, budgetProjectId: null }, { sourceRunId: f.source.id }));
});

for (const change of ['delivery', 'origin', 'sender', 'recipient', 'message-root', 'message-team', 'membership', 'project-link', 'root-stop'] as const) {
  test(`private consultation refuses revoked or forged peer attribution: ${change}`, () => {
    const f = privateDelegationFixture(false);
    if (change === 'delivery') f.state.deliveryRuns[f.peer.id] = randomUUID();
    if (change === 'origin') delete f.state.messageOrigins[f.peer.id];
    if (change === 'sender') f.peer.senderAgentId = f.carol.id;
    if (change === 'recipient') f.peer.recipientAgentId = f.carol.id;
    if (change === 'message-root') f.peer.budgetRootRunId = randomUUID();
    if (change === 'message-team') f.peer.budgetTeamId = f.team.id;
    if (change === 'membership') f.team.memberIds = [];
    if (change === 'project-link') f.project.teamIds = [f.team.id];
    if (change === 'root-stop') f.root.status = 'cancelled';
    reject(403, () => createConversation(f.state, f.input, { sourceRunId: f.source.id }));
  });
}

test('private consultation retry revalidates objective authority before returning an existing room', () => {
  const f = privateDelegationFixture(); createConversation(f.state, f.input, { sourceRunId: f.source.id });
  f.state.objectives[0].status = 'paused';
  reject(403, () => createConversation(f.state, f.input, { sourceRunId: f.source.id }));
});
