import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createOperatorRequestSchema, decideOperatorRequestSchema, operatorRequestContentSchema, operatorRequestListSchema, operatorRequestSchema,
  progressOperatorRequestSchema, reviseOperatorRequestSchema, verifyOperatorRequestSchema, withdrawOperatorRequestSchema,
  type CreateOperatorRequestInput, type OperatorRequest, type OperatorRequestActor,
  type OperatorRequestContent, type OperatorRequestHistory, type OperatorRequestScope,
} from '../shared/operator-requests.ts';
import type { Agent, Run, Team } from '../shared/types.ts';
import type { PeerMessage, Project, TeamTask } from '../shared/collaboration.ts';
import type { EnvironmentRevision } from '../shared/environment.ts';
import type { Objective } from '../shared/objectives.ts';

export interface OperatorRequestState {
  agents: Array<Pick<Agent, 'id'>>; teams: Array<Pick<Team, 'id' | 'memberIds'>>;
  projects: Array<Pick<Project, 'id' | 'teamIds'>>;
  runs: Array<Pick<Run, 'id' | 'agentId'> & Partial<Pick<Run, 'status' | 'continuedFromRunId' | 'continuedByRunId'
    | 'operatorRequestId' | 'budgetRootRunId' | 'budgetTeamId' | 'budgetProjectId' | 'objectiveId'>>>;
  objectives: Array<Pick<Objective, 'id' | 'scope' | 'teamId'>>;
  teamTasks: Array<Pick<TeamTask, 'id' | 'scope' | 'objectiveId'>>;
  environmentRevisions: EnvironmentRevision[]; messages: PeerMessage[]; operatorRequests: OperatorRequest[];
}
export class OperatorRequestError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); this.name = 'OperatorRequestError'; }
}
const now = () => new Date().toISOString();
function fail(status: number, message: string): never { throw new OperatorRequestError(status, message); }
function required<T extends { id: string }>(items: T[], id: string, label: string): T {
  return items.find(item => item.id === id) ?? fail(404, `${label} not found`);
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, result.error.issues.map(issue => issue.message).join('; '));
  return result.data;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sameScope = (a: OperatorRequestScope, b: OperatorRequestScope) => a.type === b.type && a.id === b.id;
const ownerActor = (agentId: string): OperatorRequestActor => ({ kind: 'agent', agentId });
function operatorOnly(actor: OperatorRequestActor) {
  if (actor.kind !== 'operator') fail(403, 'Only the operator can decide, process or verify a request');
}
function ownerOnly(actor: OperatorRequestActor, request: OperatorRequest) {
  if (actor.kind !== 'agent' || actor.agentId !== request.requesterAgentId) fail(403, 'Only the requester can revise or withdraw this request');
}
function expectedVersion(request: OperatorRequest, expected: number) {
  if (request.version !== expected) fail(409, 'Request version changed; read current state before updating');
}
export function canAccessOperatorRequestScope(state: OperatorRequestState, agentId: string, scope: OperatorRequestScope): boolean {
  if (!state.agents.some(agent => agent.id === agentId)) return false;
  if (scope.type === 'agent') return scope.id === agentId;
  if (scope.type === 'team') return Boolean(state.teams.find(team => team.id === scope.id)?.memberIds.includes(agentId));
  const project = state.projects.find(item => item.id === scope.id);
  return Boolean(project?.teamIds.some(id => state.teams.find(team => team.id === id)?.memberIds.includes(agentId)));
}
export function validateOperatorRequestReferences(state: OperatorRequestState, requesterAgentId: string,
  content: OperatorRequestContent, sourceRunId: string | null): void {
  required(state.agents, requesterAgentId, 'Requester');
  if (!canAccessOperatorRequestScope(state, requesterAgentId, content.scope)) fail(403, 'Current request scope membership is required');
  if (sourceRunId && required(state.runs, sourceRunId, 'Source run').agentId !== requesterAgentId) fail(403, 'Source run must belong to the requester');
  const scopedReference = (scope: OperatorRequestScope) => {
    if (!sameScope(scope, content.scope)) fail(400, 'Linked record must belong to the request scope');
    if (!canAccessOperatorRequestScope(state, requesterAgentId, scope)) fail(403, 'Current linked scope membership is required');
  };
  if (content.links.objectiveId) {
    const objective = required(state.objectives, content.links.objectiveId, 'Objective');
    scopedReference(objective.scope);
    required(state.teams, objective.teamId, 'Objective team');
  }
  if (content.links.taskId) {
    const task = required(state.teamTasks, content.links.taskId, 'Task'); scopedReference(task.scope);
    if (content.links.objectiveId && task.objectiveId && task.objectiveId !== content.links.objectiveId) fail(400, 'Linked task belongs to another objective');
  }
  if (content.links.environmentRevisionId) {
    const revision = required(state.environmentRevisions, content.links.environmentRevisionId, 'Environment revision');
    if (revision.agentId !== requesterAgentId) fail(403, 'Linked environment must belong to the requester');
  }
  if (content.links.messageId) {
    const message = required(state.messages, content.links.messageId, 'Message'); scopedReference(message.scope);
    if (message.senderAgentId !== requesterAgentId || message.recipientAgentId !== null) fail(403, 'Only a requester message addressed to the operator can be promoted');
    if (content.links.taskId && message.taskId && content.links.taskId !== message.taskId) fail(400, 'Linked message belongs to another task');
  }
}
function currentReferences(state: OperatorRequestState, request: OperatorRequest) {
  validateOperatorRequestReferences(state, request.requesterAgentId, request, request.sourceRunId);
}
function history(request: OperatorRequest, kind: OperatorRequestHistory['kind'], actor: OperatorRequestActor,
  details: Partial<Pick<OperatorRequestHistory, 'content' | 'decision' | 'processing' | 'verification'>> = {}) {
  request.history.push(structuredClone({ id: randomUUID(), kind, version: request.version,
    contentVersion: request.contentVersion, actor, at: request.updatedAt, ...details }));
}
function touch(request: OperatorRequest) { request.version += 1; request.updatedAt = now(); }
function sourceKey(content: OperatorRequestContent): string | null {
  // A record has one immutable external origin; supporting links do not create another identity.
  if (content.links.environmentRevisionId) return `environment:${content.links.environmentRevisionId}`;
  if (content.links.messageId) return `message:${content.links.messageId}`;
  return null;
}
function sourcesConflict(state: OperatorRequestState, content: OperatorRequestContent): OperatorRequest | undefined {
  return state.operatorRequests.find(request =>
    (content.links.environmentRevisionId && request.links.environmentRevisionId === content.links.environmentRevisionId)
    || (content.links.messageId && request.links.messageId === content.links.messageId));
}
/** Caller supplies requester/sourceRun from authenticated execution, never from tool arguments. */
export function createOperatorRequest(state: OperatorRequestState, requesterAgentId: string,
  raw: CreateOperatorRequestInput, sourceRunId: string | null): OperatorRequest {
  const input = parse(createOperatorRequestSchema, raw);
  const { idempotencyKey, ...content } = input;
  validateOperatorRequestReferences(state, requesterAgentId, content, sourceRunId);
  const creationHash = hash({ requesterAgentId, ...input });
  const duplicate = state.operatorRequests.find(item => item.requesterAgentId === requesterAgentId && item.idempotencyKey === idempotencyKey);
  if (duplicate) {
    if (duplicate.creationHash !== creationHash) fail(409, 'Idempotency key was already used with different request content');
    return structuredClone(duplicate);
  }
  const linked = sourcesConflict(state, content);
  if (linked) fail(409, 'This source already has an operator request; read or revise that request');
  const timestamp = now();
  const request: OperatorRequest = { ...structuredClone(content), id: randomUUID(), requesterAgentId, sourceRunId,
    idempotencyKey, creationHash, sourceKey: sourceKey(content), version: 1, contentVersion: 1,
    decision: { status: 'pending', contentVersion: 1, reason: '', actor: null, at: timestamp },
    processing: { status: 'idle', detail: '', actor: null, at: timestamp }, verification: null,
    resumeReceipts: [], resumeBlockReason: null, history: [], createdAt: timestamp, updatedAt: timestamp };
  history(request, 'created', ownerActor(requesterAgentId), { content });
  state.operatorRequests.unshift(request); return structuredClone(request);
}
export function readOperatorRequest(state: OperatorRequestState, actor: OperatorRequestActor, id: string): OperatorRequest {
  const request = required(state.operatorRequests, id, 'Operator request');
  if (actor.kind === 'agent') { ownerOnly(actor, request); currentReferences(state, request); }
  return structuredClone(request);
}
export function listOperatorRequests(state: OperatorRequestState, actor: OperatorRequestActor, raw: unknown = {}) {
  const { offset, limit } = parse(operatorRequestListSchema, raw);
  if (actor.kind === 'agent') required(state.agents, actor.agentId, 'Agent');
  const visible = state.operatorRequests.filter(request => actor.kind === 'operator'
    || (request.requesterAgentId === actor.agentId && canAccessOperatorRequestScope(state, actor.agentId, request.scope)));
  return structuredClone({ items: visible.slice(offset, offset + limit), total: visible.length,
    nextOffset: offset + limit < visible.length ? offset + limit : null });
}
export function reviseOperatorRequest(state: OperatorRequestState, actor: OperatorRequestActor, id: string, raw: unknown): OperatorRequest {
  const input = parse(reviseOperatorRequestSchema, raw); const request = required(state.operatorRequests, id, 'Operator request');
  if (actor.kind !== 'operator') ownerOnly(actor, request);
  expectedVersion(request, input.expectedVersion); currentReferences(state, request);
  if (request.decision.status === 'withdrawn') fail(409, 'Withdrawn requests cannot be revised');
  const { expectedVersion: _expectedVersion, ...content } = input;
  if (content.links.environmentRevisionId !== request.links.environmentRevisionId || content.links.messageId !== request.links.messageId) fail(400, 'Request source links are immutable');
  validateOperatorRequestReferences(state, request.requesterAgentId, content, request.sourceRunId);
  if (hash(content) === hash(operatorRequestContentSchema.parse(requestContent(request)))) return structuredClone(request);
  Object.assign(request, structuredClone(content)); request.contentVersion += 1; touch(request);
  request.decision = { status: 'pending', contentVersion: request.contentVersion, reason: '', actor: null, at: request.updatedAt };
  request.processing = { status: 'idle', detail: '', actor: null, at: request.updatedAt };
  request.verification = null; request.resumeBlockReason = null;
  history(request, 'revised', actor, { content, decision: request.decision, processing: request.processing });
  return structuredClone(request);
}
function requestContent(request: OperatorRequest): OperatorRequestContent {
  const { scope, links, category, title, reason, requestedAction, requestedScope, verificationCriteria } = request;
  return { scope, links, category, title, reason, requestedAction, requestedScope, verificationCriteria };
}
export function decideOperatorRequest(state: OperatorRequestState, actor: OperatorRequestActor, id: string, raw: unknown): OperatorRequest {
  operatorOnly(actor); const input = parse(decideOperatorRequestSchema, raw);
  const request = required(state.operatorRequests, id, 'Operator request'); expectedVersion(request, input.expectedVersion);
  if (request.decision.status === 'withdrawn') fail(409, 'Withdrawn requests cannot be decided');
  if (input.status === 'approved') currentReferences(state, request);
  if (request.decision.status === input.status && request.decision.contentVersion === request.contentVersion && request.decision.reason === input.reason) return structuredClone(request);
  touch(request);
  request.decision = { status: input.status, reason: input.reason, contentVersion: request.contentVersion, actor: structuredClone(actor), at: request.updatedAt };
  if (input.status !== 'approved') {
    request.processing = { status: 'idle', detail: '', actor: null, at: request.updatedAt };
    request.verification = null; request.resumeBlockReason = null;
  }
  history(request, 'decision', actor, { decision: request.decision, processing: request.processing });
  return structuredClone(request);
}
function requireApproval(request: OperatorRequest) {
  if (request.decision.status !== 'approved' || request.decision.contentVersion !== request.contentVersion) fail(409, 'Current request content must be approved before processing or verification');
}
export function progressOperatorRequest(state: OperatorRequestState, actor: OperatorRequestActor, id: string, raw: unknown): OperatorRequest {
  operatorOnly(actor); const input = parse(progressOperatorRequestSchema, raw);
  const request = required(state.operatorRequests, id, 'Operator request'); expectedVersion(request, input.expectedVersion);
  requireApproval(request); currentReferences(state, request);
  if (request.processing.status === 'verified') fail(409, 'Verified request content cannot be processed again');
  if (request.processing.status === input.status && request.processing.detail === input.detail) return structuredClone(request);
  touch(request); request.processing = { status: input.status, detail: input.detail, actor: structuredClone(actor), at: request.updatedAt };
  request.verification = null; request.resumeBlockReason = null;
  history(request, 'processing', actor, { processing: request.processing }); return structuredClone(request);
}
export function verifyOperatorRequest(state: OperatorRequestState, actor: OperatorRequestActor, id: string, raw: unknown): OperatorRequest {
  operatorOnly(actor); const input = parse(verifyOperatorRequestSchema, raw);
  const request = required(state.operatorRequests, id, 'Operator request'); expectedVersion(request, input.expectedVersion);
  requireApproval(request); currentReferences(state, request);
  if (request.processing.status !== 'verification_pending') fail(409, 'Request must await verification before recording a check');
  if (input.method !== 'manual' && !input.resourceId) fail(400, 'Provider verification requires its resource ID');
  touch(request);
  const { expectedVersion: _expectedVersion, ...check } = input;
  request.verification = { ...check, id: randomUUID(), contentVersion: request.contentVersion,
    actor: structuredClone(actor), verifiedAt: request.updatedAt };
  request.processing = { status: input.passed ? 'verified' : 'failed', detail: input.detail, actor: structuredClone(actor), at: request.updatedAt };
  request.resumeBlockReason = null;
  history(request, 'verification', actor, { verification: request.verification, processing: request.processing });
  return structuredClone(request);
}
export function withdrawOperatorRequest(state: OperatorRequestState, actor: OperatorRequestActor, id: string, raw: unknown): OperatorRequest {
  const input = parse(withdrawOperatorRequestSchema, raw); const request = required(state.operatorRequests, id, 'Operator request');
  ownerOnly(actor, request); expectedVersion(request, input.expectedVersion);
  // Losing team access must not prevent the owner from withdrawing an obsolete request.
  required(state.agents, request.requesterAgentId, 'Requester');
  if (request.decision.status === 'withdrawn') return structuredClone(request);
  touch(request); request.decision = { status: 'withdrawn', reason: input.reason, contentVersion: request.contentVersion,
    actor: structuredClone(actor), at: request.updatedAt };
  request.processing = { status: 'idle', detail: '', actor: null, at: request.updatedAt }; request.verification = null; request.resumeBlockReason = null;
  history(request, 'withdrawn', actor, { decision: request.decision, processing: request.processing }); return structuredClone(request);
}
/** Imports do not execute or approve an environment change. Existing sources are returned unchanged. */
export function importEnvironmentRequest(state: OperatorRequestState, revisionId: string): OperatorRequest | null {
  const revision = required(state.environmentRevisions, revisionId, 'Environment revision');
  const existing = state.operatorRequests.find(item => item.links.environmentRevisionId === revisionId);
  if (existing) return structuredClone(existing);
  if (!revision.requestedAccess.length) return null;
  return createOperatorRequest(state, revision.agentId, {
    idempotencyKey: `environment:${revision.id}`, scope: { type: 'agent', id: revision.agentId },
    links: { environmentRevisionId: revision.id }, category: 'environment', title: '환경 추가 접근 요청',
    reason: revision.reason, requestedAction: '기록된 추가 접근의 대상과 제공 방식을 결정하고 지원되는 환경 구성을 마련합니다.',
    requestedScope: revision.requestedAccess.join('\n'),
    verificationCriteria: '요청한 범위가 제공되고 해당 에이전트의 환경 구축·도구 호출 검증이 통과해야 합니다. 승인만으로 연결 완료나 권한 부여로 처리하지 않습니다.',
  }, revision.sourceRunId);
}
/** Explicit operator promotion preserves the agent as requester and never infers a decision from message text. */
export function promoteMessageRequest(state: OperatorRequestState, actor: OperatorRequestActor, messageId: string,
  raw: Omit<CreateOperatorRequestInput, 'idempotencyKey' | 'scope' | 'links'> & { links?: CreateOperatorRequestInput['links'] },
  sourceRunId: string | null = null): OperatorRequest {
  operatorOnly(actor); const message = required(state.messages, messageId, 'Message');
  if (message.senderAgentId === null || message.recipientAgentId !== null) fail(403, 'Only an agent message addressed to the operator can be promoted');
  const existing = state.operatorRequests.find(item => item.links.messageId === messageId);
  if (existing) return structuredClone(existing);
  if (raw.links?.messageId && raw.links.messageId !== messageId) fail(400, 'Promoted message identity cannot be changed');
  return createOperatorRequest(state, message.senderAgentId, { ...raw, idempotencyKey: `message:${message.id}`,
    scope: message.scope, links: { ...(message.taskId ? { taskId: message.taskId } : {}), ...raw.links, messageId } }, sourceRunId);
}

/** Persistence validation deliberately ignores current membership: revocation must preserve prior decisions. */
export function validateOperatorRequestState(state: OperatorRequestState): void {
  const seenIds = new Set<string>(); const seenKeys = new Set<string>(); const seenSources = new Set<string>();
  const resumedRunIds = new Set<string>();
  const requireInvariant = (condition: unknown, detail: string): void => { if (!condition) fail(400, `Invalid operator request state: ${detail}`); };
  const same = (a: unknown, b: unknown) => hash(a) === hash(b);
  const requireAgent = (agentId: string) => required(state.agents, agentId, 'Request agent');
  function referenceScope(scope: OperatorRequestScope) {
    if (scope.type === 'agent') requireAgent(scope.id);
    else if (scope.type === 'team') required(state.teams, scope.id, 'Request team');
    else required(state.projects, scope.id, 'Request project');
  }
  function references(content: OperatorRequestContent, requesterAgentId: string) {
    referenceScope(content.scope);
    if (content.scope.type === 'agent') requireInvariant(content.scope.id === requesterAgentId, 'foreign agent scope');
    if (content.links.objectiveId) requireInvariant(sameScope(required(state.objectives, content.links.objectiveId, 'Linked objective').scope, content.scope), 'linked objective scope mismatch');
    if (content.links.taskId) {
      const task = required(state.teamTasks, content.links.taskId, 'Linked task');
      requireInvariant(sameScope(task.scope, content.scope), 'linked task scope mismatch');
      if (content.links.objectiveId && task.objectiveId) requireInvariant(task.objectiveId === content.links.objectiveId, 'linked objective/task mismatch');
    }
    if (content.links.environmentRevisionId) requireInvariant(required(state.environmentRevisions, content.links.environmentRevisionId,
      'Linked environment').agentId === requesterAgentId, 'foreign environment source');
    if (content.links.messageId) {
      const message = required(state.messages, content.links.messageId, 'Linked message');
      requireInvariant(message.senderAgentId === requesterAgentId && message.recipientAgentId === null, 'foreign message source');
      requireInvariant(sameScope(message.scope, content.scope), 'linked message scope mismatch');
      if (content.links.taskId && message.taskId) requireInvariant(message.taskId === content.links.taskId, 'linked message/task mismatch');
    }
  }
  for (const raw of state.operatorRequests) {
    const request = parse(operatorRequestSchema, raw);
    requireInvariant(!seenIds.has(request.id), 'duplicate request ID'); seenIds.add(request.id);
    const key = JSON.stringify([request.requesterAgentId, request.idempotencyKey]);
    requireInvariant(!seenKeys.has(key), 'duplicate idempotency key'); seenKeys.add(key);
    requireAgent(request.requesterAgentId); references(request, request.requesterAgentId);
    if (request.sourceRunId) requireInvariant(required(state.runs, request.sourceRunId, 'Source run').agentId === request.requesterAgentId, 'foreign source run');
    requireInvariant(request.sourceKey === sourceKey(request), 'source key mismatch');
    for (const source of [request.links.environmentRevisionId && `environment:${request.links.environmentRevisionId}`,
      request.links.messageId && `message:${request.links.messageId}`].filter((value): value is string => Boolean(value))) {
      requireInvariant(!seenSources.has(source), 'duplicate imported source'); seenSources.add(source);
    }
    requireInvariant(request.contentVersion <= request.version && request.decision.contentVersion === request.contentVersion, 'content/decision version mismatch');
    requireInvariant(request.updatedAt >= request.createdAt, 'invalid creation/update ordering');
    const first = request.history[0];
    requireInvariant(first.kind === 'created' && first.version === 1 && first.contentVersion === 1 && first.content,
      'missing original creation record');
    requireInvariant(first.at === request.createdAt, 'creation timestamp mismatch');
    requireInvariant(hash({ requesterAgentId: request.requesterAgentId, ...first.content, idempotencyKey: request.idempotencyKey }) === request.creationHash,
      'original request content hash mismatch');
    const seenHistoryIds = new Set<string>(); const seenVerificationIds = new Set<string>();
    let priorVersion = 0; let priorContentVersion = 1; let priorAt = request.createdAt;
    let latestContent = first.content!;
    let latestDecision = { status: 'pending', contentVersion: 1, reason: '', actor: null, at: request.createdAt } as OperatorRequest['decision'];
    let latestProcessing = { status: 'idle', detail: '', actor: null, at: request.createdAt } as OperatorRequest['processing'];
    let latestVerification: OperatorRequest['verification'] = null;
    for (const entry of request.history) {
      requireInvariant(!seenHistoryIds.has(entry.id), 'duplicate history ID'); seenHistoryIds.add(entry.id);
      requireInvariant(entry.version > priorVersion && entry.version <= request.version, 'history version ordering');
      requireInvariant(entry.at >= priorAt && entry.at <= request.updatedAt, 'history timestamp ordering');
      const isOwner = entry.actor.kind === 'agent' && entry.actor.agentId === request.requesterAgentId;
      if (entry.actor.kind === 'agent') requireAgent(entry.actor.agentId);
      if (entry.kind === 'created') requireInvariant(priorVersion === 0 && isOwner, 'invalid creation actor');
      else if (entry.kind === 'revised') requireInvariant(isOwner || entry.actor.kind === 'operator', 'foreign revision actor');
      else if (entry.kind === 'withdrawn') requireInvariant(isOwner, 'foreign withdrawal actor');
      else requireInvariant(entry.actor.kind === 'operator', 'agent cannot decide, process or verify');
      if (entry.kind === 'created') requireInvariant(!entry.decision && !entry.processing && !entry.verification, 'creation carries unauthorized status');
      if (entry.kind === 'processing' || entry.kind === 'verification') requireInvariant(!entry.decision && !entry.content, 'processing event carries a decision or content');
      if (entry.kind === 'revised') requireInvariant(entry.contentVersion === priorContentVersion + 1 && entry.content, 'revision content version');
      else requireInvariant(entry.contentVersion === priorContentVersion, 'unexpected content version change');
      if (entry.content) {
        requireInvariant(entry.kind === 'created' || entry.kind === 'revised', 'content outside revision');
        references(entry.content, request.requesterAgentId);
        requireInvariant(entry.content.links.environmentRevisionId === request.links.environmentRevisionId
          && entry.content.links.messageId === request.links.messageId, 'historical source identity changed');
        latestContent = entry.content;
      }
      if (entry.kind === 'decision') requireInvariant(entry.decision && ['approved', 'rejected', 'needs_information'].includes(entry.decision.status), 'missing decision snapshot');
      if (entry.kind === 'withdrawn') requireInvariant(entry.decision?.status === 'withdrawn', 'missing withdrawal snapshot');
      if (entry.kind === 'revised') {
        requireInvariant(entry.decision?.status === 'pending' && entry.processing?.status === 'idle', 'revision retained old approval');
        latestVerification = null;
      }
      if (entry.kind === 'processing') {
        requireInvariant(latestDecision.status === 'approved' && latestDecision.contentVersion === entry.contentVersion,
          'processing without current approval');
        requireInvariant(entry.processing && ['in_progress', 'verification_pending', 'failed'].includes(entry.processing.status), 'invalid processing snapshot');
        requireInvariant(latestProcessing.status !== 'verified', 'verified request processed again'); latestVerification = null;
      }
      if (entry.kind === 'verification') {
        const check = entry.verification;
        requireInvariant(check && latestDecision.status === 'approved' && latestDecision.contentVersion === entry.contentVersion
          && latestProcessing.status === 'verification_pending', 'verification without approval and pending check');
        if (check) {
          requireInvariant(!seenVerificationIds.has(check.id), 'duplicate verification ID'); seenVerificationIds.add(check.id);
          requireInvariant(check.contentVersion === entry.contentVersion && check.actor.kind === 'operator'
            && check.verifiedAt === entry.at, 'verification provenance mismatch');
          requireInvariant(check.method === 'manual' || check.resourceId, 'missing verified resource');
          requireInvariant(entry.processing?.status === (check.passed ? 'verified' : 'failed'), 'verification result/status mismatch');
          latestVerification = check;
        }
      } else requireInvariant(!entry.verification, 'verification outside verification event');
      if (entry.decision) {
        requireInvariant(entry.decision.contentVersion === entry.contentVersion && entry.decision.at === entry.at, 'decision snapshot mismatch');
        if (entry.decision.status === 'pending') requireInvariant(entry.decision.actor === null, 'pending decision has actor');
        else requireInvariant(same(entry.decision.actor, entry.actor), 'decision actor mismatch');
        latestDecision = entry.decision;
        if (latestDecision.status !== 'approved') latestVerification = null;
      }
      if (entry.processing) {
        // A repeated approval may preserve a prior processing snapshot and timestamp.
        requireInvariant(entry.processing.at <= entry.at, 'future processing timestamp');
        if (entry.processing.status === 'idle') requireInvariant(entry.processing.actor === null, 'idle processing has actor');
        else requireInvariant(entry.processing.actor?.kind === 'operator', 'agent processing actor');
        latestProcessing = entry.processing;
      }
      priorVersion = entry.version; priorContentVersion = entry.contentVersion; priorAt = entry.at;
    }
    requireInvariant(priorContentVersion === request.contentVersion && same(latestContent, requestContent(request)), 'current content/history mismatch');
    requireInvariant(same(latestDecision, request.decision) && same(latestProcessing, request.processing)
      && same(latestVerification, request.verification), 'current decision/processing/verification history mismatch');
    if (request.processing.status !== 'idle') requireInvariant(request.decision.status === 'approved', 'unapproved processing');
    const receiptRuns = new Set<string>();
    for (const receipt of request.resumeReceipts) {
      requireInvariant(!receiptRuns.has(receipt.runId), 'duplicate resume receipt'); receiptRuns.add(receipt.runId);
      requireInvariant(!resumedRunIds.has(receipt.runId), 'run resumed through multiple requests'); resumedRunIds.add(receipt.runId);
      const sourceRun = required(state.runs, receipt.runId, 'Resumed run');
      requireInvariant(sourceRun.agentId === request.requesterAgentId, 'foreign resumed run');
      if (receipt.continuedRunId) {
        requireInvariant(receipt.continuedRunId !== receipt.runId, 'continuation cannot be source run');
        const continuation = required(state.runs, receipt.continuedRunId, 'Continuation run');
        requireInvariant(continuation.agentId === request.requesterAgentId, 'foreign continuation run');
        requireInvariant(sourceRun.status === 'superseded' && sourceRun.continuedByRunId === continuation.id
          && continuation.continuedFromRunId === sourceRun.id && continuation.operatorRequestId === request.id, 'continuation lineage mismatch');
        for (const field of ['budgetRootRunId', 'budgetTeamId', 'budgetProjectId', 'objectiveId'] as const)
          requireInvariant((sourceRun[field] ?? null) === (continuation[field] ?? null), `continuation ${field} mismatch`);
      }
      const checked = request.history.find(entry => entry.verification?.id === receipt.verificationId)?.verification;
      requireInvariant(checked?.passed && checked.contentVersion === receipt.contentVersion && receipt.at >= checked.verifiedAt,
        'resume missing matching successful verification history');
    }
  }
  for (const run of state.runs) {
    if (run.operatorRequestId || run.continuedFromRunId) {
      requireInvariant(run.operatorRequestId && run.continuedFromRunId, 'continuation is missing its request or source');
      const request = required(state.operatorRequests, run.operatorRequestId!, 'Continuation request');
      const receipt = request.resumeReceipts.find(item => item.runId === run.continuedFromRunId && item.continuedRunId === run.id);
      requireInvariant(receipt, 'continuation has no matching resume receipt');
    }
    if (run.continuedByRunId || run.status === 'superseded') {
      requireInvariant(run.status === 'superseded' && run.continuedByRunId, 'superseded run is missing its continuation');
      const child = required(state.runs, run.continuedByRunId!, 'Continuation run');
      requireInvariant(child.continuedFromRunId === run.id && child.operatorRequestId, 'source/continuation reverse link mismatch');
      const request = required(state.operatorRequests, child.operatorRequestId!, 'Continuation request');
      requireInvariant(request.resumeReceipts.some(item => item.runId === run.id && item.continuedRunId === child.id),
        'superseded run has no matching resume receipt');
    }
  }
}
