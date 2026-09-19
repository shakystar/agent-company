import { randomUUID } from 'node:crypto';
import type { WorkspaceState } from './store.ts';
import type { Run } from '../shared/types.ts';
import type { PeerMessage } from '../shared/collaboration.ts';
import { CollaborationError, collaborationMemberIds, canAccessCollaborationScope } from './collaboration.ts';
import { createConversationSchema, sendConversationSchema, conversationToolSchemas,
  type Conversation, type ConversationMessage, type ConversationScope } from '../shared/conversations.ts';
import { projectForScope, teamForScope, peerAttribution, runAttribution } from './budget-attribution.ts';
import { validOperatorContinuation } from './operator-request-resume.ts';
import { objectiveForRun, objectiveRunBlock } from './objectives.ts';
import { runControlBlocked } from './run-control.ts';

const now = () => new Date().toISOString();
const fail = (status: number, message: string): never => { throw new CollaborationError(status, message); };
const sameScope = (a: ConversationScope, b: ConversationScope) => a.type === b.type && a.id === b.id;
const unfinished = (run: Run) => ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status);

function scopeMembers(state: WorkspaceState, scope: ConversationScope): string[] {
  if (scope.type !== 'agent') return collaborationMemberIds(state, { type: scope.type, id: scope.id });
  if (!state.agents.some(agent => agent.id === scope.id)) fail(404, '에이전트가 없습니다.');
  return [scope.id];
}
export function currentConversationMembers(state: WorkspaceState, conversation: Conversation): string[] {
  const current = new Set(scopeMembers(state, conversation.scope));
  return conversation.participantAgentIds.filter(id => current.has(id));
}
export function canAccessConversation(state: WorkspaceState, actor: string | null, id: string): boolean {
  const conversation = state.conversations.find(item => item.id === id);
  if (!conversation) return false;
  try { return actor === null || currentConversationMembers(state, conversation).includes(actor); }
  catch (error) { if (error instanceof CollaborationError) return false; throw error; }
}
function requireConversation(state: WorkspaceState, actor: string | null, id: string): Conversation {
  const conversation = state.conversations.find(item => item.id === id) ?? fail(404, '대화가 없습니다.');
  if (!canAccessConversation(state, actor, id)) fail(403, '현재 대화 참여 권한이 없습니다.');
  return conversation;
}

/** sourceRunId is trusted service context; it is never accepted in the public input schema. */
export function createConversation(state: WorkspaceState, raw: unknown, context?: { sourceRunId: string }): Conversation {
  const input = createConversationSchema.parse(raw);
  const inherited = context ? privateSourceAttribution(state, input, context.sourceRunId) : undefined;
  const duplicate = state.conversations.find(item => item.id === input.idempotencyKey);
  if (duplicate) {
    if (!sameScope(duplicate.scope, input.scope) || duplicate.title !== input.title || duplicate.legacyThreadId !== input.legacyThreadId
      || input.budgetProjectId !== undefined && input.budgetProjectId !== duplicate.budgetProjectId
      || input.budgetTeamId !== undefined && input.budgetTeamId !== duplicate.budgetTeamId
      || inherited && (duplicate.budgetProjectId !== inherited.projectId || duplicate.budgetTeamId !== inherited.teamId)) {
      fail(409, '동일 요청 식별자로 다른 대화를 만들 수 없습니다.');
    }
    return structuredClone(duplicate);
  }
  let participants = scopeMembers(state, input.scope);
  let budgetProjectId: string | null;
  let budgetTeamId: string | null | undefined;
  if (input.legacyThreadId) {
    const messages = state.messages.filter(message => message.threadId === input.legacyThreadId);
    if (!messages.length) fail(404, '원래 대화가 없습니다.');
    if (messages.some(message => !sameScope(message.scope, input.scope))) fail(403, '다른 공유 공간의 대화를 옮길 수 없습니다.');
    const original = [...new Set(messages.flatMap(message => [message.senderAgentId, message.recipientAgentId]).filter((id): id is string => id !== null))];
    if (original.some(id => !participants.includes(id))) fail(403, '원래 참여자가 현재 공유 공간에서 제외됐습니다.');
    const existing = state.conversations.find(item => item.legacyThreadId === input.legacyThreadId);
    if (existing) return structuredClone(existing);
    participants = original;
    const origins = new Set(messages.map(message => peerAttribution(state, message).projectId));
    if (origins.size !== 1) fail(409, '서로 다른 원래 프로젝트의 대화를 하나로 합칠 수 없습니다.');
    budgetProjectId = [...origins][0];
    const teams = new Set(messages.map(message => peerAttribution(state, message).teamId));
    if (teams.size !== 1) fail(409, '서로 다른 원팀의 대화를 하나로 합칠 수 없습니다.');
    budgetTeamId = [...teams][0];
    if (input.budgetProjectId !== undefined && input.budgetProjectId !== budgetProjectId) fail(403, '기존 대화의 원래 프로젝트 귀속은 유지합니다.');
    if (input.budgetTeamId !== undefined && input.budgetTeamId !== budgetTeamId) fail(403, '기존 대화의 원팀 귀속은 유지합니다.');
  } else if (inherited) {
    budgetProjectId = inherited.projectId; budgetTeamId = inherited.teamId;
  } else {
    budgetProjectId = projectForScope(state, input.scope, input.budgetProjectId);
    budgetTeamId = teamForScope(state, input.scope, budgetProjectId, input.budgetTeamId);
  }
  const conversation: Conversation = { id: input.idempotencyKey, title: input.title, scope: input.scope,
    budgetProjectId, budgetTeamId,
    participantAgentIds: participants, ...(input.legacyThreadId ? { legacyThreadId: input.legacyThreadId } : {}), createdAt: now(), updatedAt: now() };
  state.conversations.push(conversation);
  if (input.legacyThreadId) {
    for (const message of state.messages.filter(item => item.threadId === input.legacyThreadId).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      mirrorInto(state, conversation, message, state.messageOrigins[message.id] ?? null);
      const linkedRunIds = [state.messageOrigins[message.id], state.deliveryRuns[message.id]];
      for (const run of state.runs.filter(item => linkedRunIds.includes(item.id) && unfinished(item) && participants.includes(item.agentId))) {
        const attribution = runAttribution(state, run);
        if (attribution.projectId !== budgetProjectId || attribution.teamId !== budgetTeamId) fail(409, '기존 실행의 원래 프로젝트·팀 귀속이 다릅니다. 별도 작업실을 유지합니다.');
        if (run.conversationId && run.conversationId !== conversation.id) fail(409, '진행 중 작업이 이미 다른 작업실 대화에 연결돼 있습니다. 해당 대화에서 참여할 수 있습니다.');
        run.conversationId = conversation.id;
        run.conversationMessageId ??= state.conversationMessages.find(item => item.conversationId === conversation.id && item.sourcePeerMessageId === message.id)?.id;
      }
    }
  }
  return structuredClone(conversation);
}

function privateSourceAttribution(state: WorkspaceState, input: ReturnType<typeof createConversationSchema.parse>, sourceRunId: string) {
  const source = state.runs.find(run => run.id === sourceRunId) ?? fail(404, '상담 원래 실행이 없습니다.');
  if (input.scope.type !== 'agent' || input.scope.id !== source.agentId || input.legacyThreadId) fail(403, '원래 에이전트의 개인 상담만 같은 실행 귀속을 유지할 수 있습니다.');
  if (!state.agents.some(agent => agent.id === source.agentId)) fail(404, '상담 에이전트가 없습니다.');
  const attribution = runAttribution(state, source);
  if (input.budgetProjectId !== undefined && input.budgetProjectId !== attribution.projectId
    || input.budgetTeamId !== undefined && input.budgetTeamId !== attribution.teamId) fail(403, '상담의 원래 프로젝트·팀 귀속을 변경할 수 없습니다.');
  const ownTeam = attribution.teamId ? state.teams.find(team => team.id === attribution.teamId && team.memberIds.includes(source.agentId)) : undefined;
  if (attribution.projectId) {
    const project = state.projects.find(item => item.id === attribution.projectId);
    if (!project || !attribution.teamId || !project.teamIds.includes(attribution.teamId)
      || !canAccessCollaborationScope(state, source.agentId, { type: 'project', id: project.id })) fail(403, '원래 프로젝트의 현재 연결·읽기 권한이 없습니다.');
    if (!ownTeam && !objectiveForRun(state, source) && !privatePeerDelegation(state, source)) fail(403, '다른 팀에 귀속된 실행의 검증된 위임 근거가 필요합니다.');
  } else if (attribution.teamId && !ownTeam) fail(403, '원래 팀의 현재 접근 권한이 없습니다.');
  const block = objectiveRunBlock(state, source);
  if (block) fail(403, block.reason);
  return attribution;
}

/** Existing peer delivery proves billing provenance; this grants no new tool or membership. */
function privatePeerDelegation(state: WorkspaceState, run: Run, visited = new Set<string>()): boolean {
  if (visited.has(run.id) || !run.budgetProjectId || !run.budgetTeamId || !run.budgetRootRunId) return false;
  const root = state.runs.find(item => item.id === run.budgetRootRunId);
  const ownTeam = state.teams.find(team => team.id === run.budgetTeamId);
  if (!root || root.budgetRootRunId !== root.id || root.budgetProjectId !== run.budgetProjectId || root.budgetTeamId !== run.budgetTeamId
    || runControlBlocked(state, root.id) || !ownTeam?.memberIds.includes(root.agentId)) return false;
  const next = new Set(visited).add(run.id);
  const continued = validOperatorContinuation(state, run);
  if (continued) return privatePeerDelegation(state, continued, next);
  return (run.messageIds ?? []).some(id => {
    const message = state.messages.find(item => item.id === id);
    if (!message || state.deliveryRuns[id] !== run.id || message.recipientAgentId !== run.agentId || !message.senderAgentId
      || message.senderAgentId === run.agentId || message.scope.type !== 'project' || message.scope.id !== run.budgetProjectId
      || message.budgetProjectId !== run.budgetProjectId || message.budgetTeamId !== run.budgetTeamId || message.budgetRootRunId !== run.budgetRootRunId) return false;
    const source = state.runs.find(item => item.id === state.messageOrigins[id]);
    if (!source || source.agentId !== message.senderAgentId || source.budgetProjectId !== run.budgetProjectId
      || source.budgetTeamId !== run.budgetTeamId || source.budgetRootRunId !== run.budgetRootRunId
      || runControlBlocked(state, source.id)
      || !canAccessCollaborationScope(state, source.agentId, { type: 'project', id: run.budgetProjectId! })) return false;
    return ownTeam.memberIds.includes(source.agentId) || privatePeerDelegation(state, source, next);
  });
}

function targets(state: WorkspaceState, conversation: Conversation, actor: string | null, recipient?: string): string[] {
  const members = currentConversationMembers(state, conversation);
  if (recipient) {
    if (!members.includes(recipient) || recipient === actor) fail(403, '현재 대화의 다른 참여자만 지정할 수 있습니다.');
    return [recipient];
  }
  // Publishing a peer message is not permission for an unbounded reply fan-out.
  if (actor !== null) return [];
  const active = state.runs.filter(run => run.conversationId === conversation.id && unfinished(run) && members.includes(run.agentId));
  if (active.length) return [...new Set(active.map(run => run.agentId))];
  const eligible = members.filter(id => state.agents.find(agent => agent.id === id)?.status !== 'paused');
  const lastReply = (id: string) => state.conversationMessages.filter(message => message.conversationId === conversation.id && message.senderAgentId === id)
    .map(message => message.createdAt).sort().at(-1) ?? '';
  eligible.sort((a, b) => Number(state.agents.find(agent => agent.id === b)?.status === 'idle')
    - Number(state.agents.find(agent => agent.id === a)?.status === 'idle') || lastReply(a).localeCompare(lastReply(b)) || a.localeCompare(b));
  if (!eligible.length) fail(409, '응답 가능한 참여자가 없습니다. 에이전트를 재개하거나 수신자를 지정할 수 있습니다.');
  // This rotates initial reception, not team authority or assignment of the task.
  return eligible.slice(0, 1);
}

export function postConversationMessage(state: WorkspaceState, actor: string | null, id: string, raw: unknown,
  sourceRunId?: string, options?: { recordOnly?: boolean }): ConversationMessage {
  const input = sendConversationSchema.parse(raw);
  if (options?.recordOnly && (actor !== null || input.recipientAgentId || input.mode === 'task')) {
    fail(400, '기록 전용 의견은 사용자 상담 메시지이며 수신자를 지정하지 않습니다.');
  }
  const conversation = requireConversation(state, actor, id);
  if (sourceRunId && !state.runs.some(run => run.id === sourceRunId && run.agentId === actor && run.conversationId === id && unfinished(run))) {
    fail(403, '발신 작업과 대화가 일치하지 않습니다.');
  }
  const duplicate = state.conversationMessages.find(message => message.conversationId === id && message.senderAgentId === actor && message.idempotencyKey === input.idempotencyKey);
  if (duplicate) {
    const requested = (duplicate as ConversationMessage & { requestedRecipientAgentId?: string }).requestedRecipientAgentId;
    if (duplicate.content !== input.content || duplicate.mode !== input.mode || duplicate.replyToId !== (input.replyToId ?? null) || requested !== input.recipientAgentId
      || Boolean(duplicate.recordOnly) !== Boolean(options?.recordOnly)) {
      fail(409, '동일 요청 식별자로 다른 메시지를 보낼 수 없습니다.');
    }
    return structuredClone(duplicate);
  }
  if (input.replyToId && !state.conversationMessages.some(message => message.id === input.replyToId && message.conversationId === id)) {
    fail(400, '답장 대상은 같은 대화에 있어야 합니다.');
  }
  const recipients = options?.recordOnly ? [] : targets(state, conversation, actor, input.recipientAgentId);
  const sourceRun = sourceRunId ? state.runs.find(run => run.id === sourceRunId) : undefined;
  const original = input.replyToId ? state.conversationMessages.find(message => message.id === input.replyToId) : undefined;
  const roomProjectId = conversation.budgetProjectId ?? (conversation.scope.type === 'project' ? conversation.scope.id : null);
  const attribution = sourceRun ? runAttribution(state, sourceRun) : original?.budgetProjectId !== undefined
    ? { projectId: original.budgetProjectId, teamId: original.budgetTeamId, rootRunId: original.budgetRootRunId ?? null }
    : { projectId: roomProjectId,
      // This is a new user task, not historical backfill. Preserve the old room
      // and its messages; only this new task may use today's unambiguous team.
      teamId: conversation.budgetTeamId !== undefined ? conversation.budgetTeamId : actor === null
        ? teamForScope(state, conversation.scope, roomProjectId) : conversation.scope.type === 'team' ? conversation.scope.id : undefined, rootRunId: null };
  if (sourceRun && original?.budgetProjectId !== undefined && (original.budgetProjectId !== attribution.projectId || original.budgetTeamId !== attribution.teamId)) {
    fail(403, '다른 프로젝트·원팀의 요청에는 분리된 실행에서 응답해야 합니다.');
  }
  const message: ConversationMessage & { requestedRecipientAgentId?: string } = {
    budgetProjectId: attribution.projectId, budgetTeamId: attribution.teamId, budgetRootRunId: attribution.rootRunId,
    id: randomUUID(), conversationId: id, senderAgentId: actor, content: input.content,
    mode: input.mode, replyToId: input.replyToId ?? null, sourceRunId: sourceRunId ?? null,
    idempotencyKey: input.idempotencyKey, ...(input.recipientAgentId ? { requestedRecipientAgentId: input.recipientAgentId } : {}),
    ...(options?.recordOnly ? { recordOnly: true } : {}),
    deliveries: recipients.map(agentId => ({ agentId, runId: null, steeringIndex: null, status: 'pending' })), createdAt: now(),
  };
  state.conversationMessages.push(message); conversation.updatedAt = message.createdAt;
  return structuredClone(message);
}

export function readConversation(state: WorkspaceState, actor: string | null, id: string) {
  const conversation = requireConversation(state, actor, id);
  return structuredClone({ conversation, messages: state.conversationMessages.filter(message => message.conversationId === id),
    runs: state.runs.filter(run => run.conversationId === id).map(run => ({ id: run.id, agentId: run.agentId, status: run.status,
      conversationId: run.conversationId, conversationMessageId: run.conversationMessageId,
      consultationOfRunId: run.consultationOfRunId,
      pauseRequestedAt: run.pauseRequestedAt, pausedAt: run.pausedAt, appliedSteeringCount: run.appliedSteeringCount,
      createdAt: run.createdAt, completedAt: run.completedAt })) });
}
export function conversationContext(state: WorkspaceState, actor: string, id: string) {
  const view = readConversation(state, actor, id);
  return { conversation: view.conversation, messages: view.messages.slice(-30), totalMessages: view.messages.length,
    members: currentConversationMembers(state, view.conversation).map(id => {
      const agent = state.agents.find(item => item.id === id)!;
      return { id, name: agent.name, status: agent.status };
    }) };
}
export function mutateConversation(state: WorkspaceState, actor: string | null, name: string, args: unknown, sourceRunId?: string): unknown {
  if (name === 'conversation_list') {
    conversationToolSchemas.conversation_list.parse(args);
    return structuredClone(state.conversations.filter(item => canAccessConversation(state, actor, item.id)));
  }
  if (name === 'conversation_read') {
    const input = conversationToolSchemas.conversation_read.parse(args);
    const view = readConversation(state, actor, input.conversationId);
    return { ...view, messages: view.messages.slice(input.offset, input.offset + input.limit), totalMessages: view.messages.length,
      nextOffset: input.offset + input.limit < view.messages.length ? input.offset + input.limit : null };
  }
  if (name === 'conversation_send') {
    const { conversationId, ...input } = conversationToolSchemas.conversation_send.parse(args);
    return postConversationMessage(state, actor, conversationId, input, sourceRunId);
  }
  return fail(404, '알 수 없는 대화 도구입니다.');
}

export function publishConversationResult(state: WorkspaceState, run: Run): void {
  if (!run.conversationId || run.status !== 'succeeded' || !run.result || !canAccessConversation(state, run.agentId, run.conversationId)) return;
  const idempotencyKey = `result:${run.id}`;
  if (state.conversationMessages.some(message => message.conversationId === run.conversationId && message.idempotencyKey === idempotencyKey)) return;
  const message: ConversationMessage = { id: randomUUID(), conversationId: run.conversationId,
    budgetProjectId: run.budgetProjectId ?? null, budgetTeamId: run.budgetTeamId, budgetRootRunId: run.budgetRootRunId ?? run.id,
    senderAgentId: run.agentId, content: run.result, sourceRunId: run.id, replyToId: run.conversationMessageId ?? null,
    ...(run.consultationOfRunId ? { consultationOfRunId: run.consultationOfRunId } : {}),
    mode: run.interactionMode ?? 'auto', idempotencyKey, deliveries: [], createdAt: now() };
  state.conversationMessages.push(message);
  state.conversations.find(item => item.id === run.conversationId)!.updatedAt = message.createdAt;
  reconcileConversationDeliveries(state);
}
function mirrorInto(state: WorkspaceState, conversation: Conversation, peer: PeerMessage, sourceRunId: string | null): void {
  if (state.conversationMessages.some(message => message.conversationId === conversation.id && message.sourcePeerMessageId === peer.id)) return;
  state.conversationMessages.push({ id: randomUUID(), conversationId: conversation.id, senderAgentId: peer.senderAgentId,
    budgetProjectId: peerAttribution(state, peer).projectId, budgetTeamId: peerAttribution(state, peer).teamId, budgetRootRunId: peerAttribution(state, peer).rootRunId,
    content: peer.content, mode: 'auto', replyToId: state.conversationMessages.find(message => message.conversationId === conversation.id && message.sourcePeerMessageId === peer.replyToId)?.id ?? null,
    sourceRunId, sourcePeerMessageId: peer.id, idempotencyKey: `peer:${peer.id}`, deliveries: [], createdAt: peer.createdAt });
  conversation.updatedAt = now();
}
export function mirrorPeerMessage(state: WorkspaceState, run: Run | null, peer: PeerMessage): void {
  // An explicit shared-room execution may publish its own peer exchange to that room.
  const rooms = state.conversations.filter(item => item.legacyThreadId === peer.threadId || item.id === run?.conversationId);
  for (const conversation of rooms) {
    if (!sameScope(conversation.scope, peer.scope)) continue;
    const members = currentConversationMembers(state, conversation);
    if ([peer.senderAgentId, peer.recipientAgentId].some(id => id !== null && !members.includes(id))) continue;
    mirrorInto(state, conversation, peer, run?.id ?? null);
  }
}
export function reconcileConversationDeliveries(state: WorkspaceState): void {
  for (const message of state.conversationMessages) for (const delivery of message.deliveries) {
    if (delivery.status === 'cancelled') continue;
    if (!canAccessConversation(state, delivery.agentId, message.conversationId)) { delivery.status = 'cancelled'; continue; }
    if (!delivery.runId) continue;
    const original = state.runs.find(item => item.id === delivery.runId);
    if (!original || original.agentId !== delivery.agentId) continue;
    const run = continuedConversationRun(state, original, message.conversationId);
    if (!run) continue;
    if (run.status === 'cancelled') delivery.status = 'cancelled';
    else if (run.status === 'succeeded') delivery.status = 'answered';
    else if (delivery.steeringIndex !== null && (run.appliedSteeringCount ?? 0) > delivery.steeringIndex) delivery.status = 'applied';
  }
}

/** Delivery and sender provenance remain attached to the originally notified run. */
function continuedConversationRun(state: WorkspaceState, original: Run, conversationId: string): Run | undefined {
  let current = original;
  const visited = new Set<string>();
  while (current.status === 'superseded') {
    if (visited.has(current.id)) return;
    visited.add(current.id);
    const next = state.runs.find(item => item.id === current.continuedByRunId);
    if (!next || visited.has(next.id) || validOperatorContinuation(state, next)?.id !== current.id
      || current.conversationId !== conversationId || next.conversationId !== conversationId
      || next.conversationMessageId !== current.conversationMessageId) return;
    current = next;
  }
  return current;
}
