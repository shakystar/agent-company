import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOperatorRequestSchema, operatorRequestTools, type CreateOperatorRequestInput, type OperatorRequestActor } from '../shared/operator-requests.ts';
import { canAccessOperatorRequestScope, createOperatorRequest, decideOperatorRequest, importEnvironmentRequest,
  listOperatorRequests, OperatorRequestError, progressOperatorRequest, promoteMessageRequest, readOperatorRequest,
  reviseOperatorRequest, validateOperatorRequestState, verifyOperatorRequest, withdrawOperatorRequest, type OperatorRequestState } from '../server/operator-requests.ts';

const operator: OperatorRequestActor = { kind: 'operator' };
const owner: OperatorRequestActor = { kind: 'agent', agentId: 'owner' };
const peer: OperatorRequestActor = { kind: 'agent', agentId: 'peer' };
const timestamp = '2026-09-11T00:00:00.000Z';
function state(): OperatorRequestState {
  return { agents: [{ id: 'owner' }, { id: 'peer' }, { id: 'outsider' }],
    teams: [{ id: 'team', memberIds: ['owner', 'peer'] }, { id: 'other-team', memberIds: ['outsider'] }],
    projects: [{ id: 'project', teamIds: ['team'] }, { id: 'other-project', teamIds: ['other-team'] }],
    runs: [{ id: 'run', agentId: 'owner' }, { id: 'peer-run', agentId: 'peer' }],
    objectives: [{ id: 'objective', teamId: 'team', scope: { type: 'project', id: 'project' } }],
    teamTasks: [{ id: 'task', scope: { type: 'project', id: 'project' }, objectiveId: 'objective' }],
    environmentRevisions: [{ id: 'environment', agentId: 'owner', baseRevisionId: null, sourceRunId: 'run', buildRunId: null,
      reason: '외부 도구 접근이 필요합니다.', spec: { packages: [], servers: [] }, requestedAccess: ['업무용 문서 읽기'],
      status: 'blocked', error: '접근 요청', createdAt: timestamp, completedAt: null }],
    messages: [{ id: 'message', scope: { type: 'project', id: 'project' }, senderAgentId: 'owner', recipientAgentId: null,
      taskId: 'task', threadId: 'message', content: '업무용 문서 읽기 연결이 필요합니다.', replyToId: null, artifactIds: [],
      idempotencyKey: 'message-key', status: 'pending', createdAt: timestamp, deliveredAt: null, completedAt: null }], operatorRequests: [] };
}
function input(overrides: Partial<CreateOperatorRequestInput> = {}): CreateOperatorRequestInput {
  return { idempotencyKey: 'connect-work-documents', scope: { type: 'project', id: 'project' },
    links: { objectiveId: 'objective', taskId: 'task' }, category: 'connector', title: '문서 연결 요청',
    reason: '요구사항 문서를 읽어 제작 범위를 확인해야 합니다.', requestedAction: '업무용 문서 계정을 연결합니다.',
    requestedScope: '지정된 프로젝트 문서 읽기', verificationCriteria: '지정된 문서를 읽을 수 있어야 합니다.', ...overrides };
}
function create(s = state(), overrides: Partial<CreateOperatorRequestInput> = {}) { return createOperatorRequest(s, 'owner', input(overrides), 'run'); }
function status(code: number) { return (error: unknown) => error instanceof OperatorRequestError && error.statusCode === code; }
function approve(s: OperatorRequestState) {
  const request = create(s);
  return decideOperatorRequest(s, operator, request.id, { expectedVersion: request.version, status: 'approved', reason: '해당 범위를 승인합니다.' });
}
function ready(s: OperatorRequestState) {
  const request = approve(s);
  return progressOperatorRequest(s, operator, request.id, { expectedVersion: request.version, status: 'verification_pending', detail: '연결 후 검증을 기다립니다.' });
}
function verification(expectedVersion: number) {
  return { expectedVersion, method: 'github', resourceId: 'connection', passed: true, evidence: 'API와 해당 에이전트 읽기 권한 확인', detail: '읽기 검증 통과' };
}

test('creation records identity, concrete content, versioned pending decision and idle processing', () => {
  const s = state(); const request = create(s);
  assert.equal(request.sourceRunId, 'run'); assert.equal(request.requesterAgentId, 'owner');
  assert.equal(request.version, 1); assert.equal(request.contentVersion, 1); assert.equal(request.decision.status, 'pending');
  assert.equal(request.processing.status, 'idle'); assert.equal(request.verification, null); assert.equal(request.history.length, 1);
  const { idempotencyKey: _key, ...body } = input();
  assert.deepEqual(request.history[0].content, createOperatorRequestSchema.omit({ idempotencyKey: true }).parse(body));
  assert.deepEqual(request.resumeReceipts, []); assert.equal(request.resumeBlockReason, null);
  request.title = 'mutated copy'; assert.equal(s.operatorRequests[0].title, '문서 연결 요청');
});
test('idempotency is requester scoped and stable across run retries and property order', () => {
  const s = state(); const first = create(s);
  s.runs.push({ id: 'retry-run', agentId: 'owner' });
  const second = createOperatorRequest(s, 'owner', input({ links: { taskId: 'task', objectiveId: 'objective' } }), 'retry-run');
  assert.equal(second.id, first.id); assert.equal(second.sourceRunId, 'run'); assert.equal(s.operatorRequests.length, 1);
  assert.notEqual(createOperatorRequest(s, 'peer', input(), 'peer-run').id, first.id);
});
test('changed payload with the same idempotency key fails without altering the old request', () => {
  const s = state(); const first = create(s);
  assert.throws(() => create(s, { requestedScope: '모든 저장소 쓰기' }), status(409));
  assert.deepEqual(s.operatorRequests[0], first);
});
test('creation rejects unknown fields, blank scope detail and fabricated source run', () => {
  const s = state();
  assert.throws(() => create(s, { requestedScope: ' ' }), status(400));
  assert.throws(() => createOperatorRequest(s, 'owner', { ...input(), requesterAgentId: 'peer' } as CreateOperatorRequestInput, 'run'), status(400));
  assert.throws(() => createOperatorRequest(s, 'owner', input(), 'peer-run'), status(403));
  assert.throws(() => createOperatorRequest(s, 'owner', input(), 'missing-run'), status(404));
  assert.equal(s.operatorRequests.length, 0);
});
test('scope membership and linked object scope are validated at creation', () => {
  const s = state();
  assert.throws(() => create(s, { scope: { type: 'project', id: 'other-project' } }), status(403));
  assert.throws(() => create(s, { scope: { type: 'agent', id: 'peer' } }), status(403));
  assert.throws(() => create(s, { scope: { type: 'team', id: 'team' } }), status(400));
  assert.throws(() => create(s, { links: { taskId: 'missing-task' } }), status(404));
  assert.equal(canAccessOperatorRequestScope(s, 'unknown', { type: 'agent', id: 'unknown' }), false);
});
test('foreign environment and a peer-addressed message cannot be attached', () => {
  const s = state(); s.environmentRevisions[0].agentId = 'peer';
  assert.throws(() => create(s, { links: { environmentRevisionId: 'environment' } }), status(403));
  s.messages[0].recipientAgentId = 'peer';
  assert.throws(() => create(s, { links: { messageId: 'message' } }), status(403));
});
test('task/objective and message/task contradictions are rejected', () => {
  const s = state(); s.teamTasks[0].objectiveId = 'different-objective';
  assert.throws(() => create(s), status(400));
  s.teamTasks[0].objectiveId = 'objective'; s.messages[0].taskId = 'different-task';
  assert.throws(() => create(s, { links: { taskId: 'task', messageId: 'message' } }), status(400));
});
test('approval never grants rights, resumes runs or verifies a connection', () => {
  const s = state(); const before = structuredClone({ agents: s.agents, teams: s.teams, runs: s.runs, environments: s.environmentRevisions });
  const request = approve(s);
  assert.equal(request.decision.status, 'approved'); assert.equal(request.processing.status, 'idle'); assert.equal(request.verification, null);
  assert.deepEqual(request.resumeReceipts, []);
  assert.deepEqual({ agents: s.agents, teams: s.teams, runs: s.runs, environments: s.environmentRevisions }, before);
});
test('requester cannot approve, process or verify its own request', () => {
  const s = state(); const request = create(s);
  assert.throws(() => decideOperatorRequest(s, owner, request.id, { expectedVersion: 1, status: 'approved', reason: '자체 승인' }), status(403));
  assert.throws(() => progressOperatorRequest(s, owner, request.id, { expectedVersion: 1, status: 'in_progress', detail: '시작' }), status(403));
  assert.throws(() => verifyOperatorRequest(s, owner, request.id, verification(1)), status(403));
  assert.equal(s.operatorRequests[0].version, 1);
});
test('only requester or operator can revise and only requester can withdraw', () => {
  const s = state(); const request = create(s); const { idempotencyKey: _key, ...body } = input();
  assert.throws(() => reviseOperatorRequest(s, peer, request.id, { ...body, expectedVersion: 1 }), status(403));
  for (const actor of [operator, peer]) {
    assert.throws(() => withdrawOperatorRequest(s, actor, request.id, { expectedVersion: 1, reason: '철회' }), status(403));
  }
  const revised = reviseOperatorRequest(s, operator, request.id, { ...body, title: '구체화된 요청', expectedVersion: 1 });
  assert.equal(revised.history.at(-1)?.actor.kind, 'operator'); assert.equal(revised.contentVersion, 2);
});
test('every mutation checks the current optimistic version before state changes', () => {
  const s = state(); const request = approve(s); const before = structuredClone(s.operatorRequests);
  const { idempotencyKey: _key, ...body } = input();
  assert.throws(() => reviseOperatorRequest(s, owner, request.id, { ...body, expectedVersion: 1 }), status(409));
  assert.throws(() => decideOperatorRequest(s, operator, request.id, { expectedVersion: 1, status: 'rejected', reason: '거절' }), status(409));
  assert.throws(() => progressOperatorRequest(s, operator, request.id, { expectedVersion: 1, status: 'in_progress', detail: '시작' }), status(409));
  assert.throws(() => verifyOperatorRequest(s, operator, request.id, verification(1)), status(409));
  assert.throws(() => withdrawOperatorRequest(s, owner, request.id, { expectedVersion: 1, reason: '철회' }), status(409));
  assert.deepEqual(s.operatorRequests, before);
});
test('unchanged revision preserves approval and version', () => {
  const s = state(); const request = approve(s); const { idempotencyKey: _key, ...body } = input();
  assert.deepEqual(reviseOperatorRequest(s, owner, request.id, { ...body, expectedVersion: request.version }), request);
});
test('content revision invalidates approval and verification while preserving historical receipts', () => {
  const s = state(); const pending = ready(s); const verified = verifyOperatorRequest(s, operator, pending.id, verification(pending.version));
  s.operatorRequests[0].resumeReceipts.push({ runId: 'run', continuedRunId: 'continued', at: timestamp, contentVersion: 1, verificationId: verified.verification!.id });
  const { idempotencyKey: _key, ...body } = input({ requestedScope: '프로젝트 문서 읽기 및 작성' });
  const revised = reviseOperatorRequest(s, owner, verified.id, { ...body, expectedVersion: verified.version });
  assert.equal(revised.contentVersion, 2); assert.equal(revised.decision.status, 'pending'); assert.equal(revised.processing.status, 'idle');
  assert.equal(revised.verification, null); assert.equal(revised.history.filter(item => item.verification?.passed).length, 1);
  assert.equal(revised.history[0].content?.requestedScope, '지정된 프로젝트 문서 읽기');
  assert.equal(revised.resumeReceipts[0].continuedRunId, 'continued');
  assert.throws(() => verifyOperatorRequest(s, operator, revised.id, verification(revised.version)), status(409));
  // Original creation can be replayed after a revision without reverting the current content.
  assert.equal(create(s).id, revised.id); assert.equal(create(s).contentVersion, 2);
});
test('needs-information and rejection remain decisions without performing changes', () => {
  const s = state(); const request = create(s);
  const more = decideOperatorRequest(s, operator, request.id, { expectedVersion: 1, status: 'needs_information', reason: '대상 페이지를 명시하십시오.' });
  assert.equal(more.processing.status, 'idle');
  const rejected = decideOperatorRequest(s, operator, request.id, { expectedVersion: more.version, status: 'rejected', reason: '범위가 과도합니다.' });
  assert.throws(() => progressOperatorRequest(s, operator, request.id, { expectedVersion: rejected.version, status: 'in_progress', detail: '시작' }), status(409));
});
test('verification requires current-content approval and explicit pending-verification state', () => {
  const s = state(); const request = approve(s);
  assert.throws(() => verifyOperatorRequest(s, operator, request.id, verification(request.version)), status(409));
  s.operatorRequests[0].decision.contentVersion = 0;
  assert.throws(() => progressOperatorRequest(s, operator, request.id, { expectedVersion: request.version, status: 'verification_pending', detail: '검증' }), status(409));
});
test('successful provider verification preserves evidence and verifier without replaying it', () => {
  const s = state(); const pending = ready(s); const verified = verifyOperatorRequest(s, operator, pending.id, verification(pending.version));
  assert.equal(verified.processing.status, 'verified'); assert.equal(verified.verification?.method, 'github');
  assert.equal(verified.verification?.resourceId, 'connection'); assert.deepEqual(verified.verification?.actor, operator);
  assert.equal(verified.verification?.contentVersion, 1); assert.equal(verified.history.at(-1)?.kind, 'verification');
  assert.throws(() => verifyOperatorRequest(s, operator, verified.id, verification(verified.version)), status(409));
  assert.throws(() => progressOperatorRequest(s, operator, verified.id, { expectedVersion: verified.version, status: 'in_progress', detail: '다시' }), status(409));
});
test('failed verification stays failed and preserves its receipt after a later successful retry', () => {
  const s = state(); const pending = ready(s);
  const failed = verifyOperatorRequest(s, operator, pending.id, { ...verification(pending.version), passed: false, detail: '권한 없음' });
  assert.equal(failed.processing.status, 'failed'); assert.equal(failed.decision.status, 'approved');
  const retry = progressOperatorRequest(s, operator, failed.id, { expectedVersion: failed.version, status: 'verification_pending', detail: '권한 처리 후 다시 검증' });
  const passed = verifyOperatorRequest(s, operator, failed.id, verification(retry.version));
  assert.deepEqual(passed.history.filter(item => item.verification).map(item => item.verification?.passed), [false, true]);
});
test('manual verification is explicitly separate and provider checks require a resource identity', () => {
  const s = state(); const pending = ready(s); const { resourceId: _id, ...noResource } = verification(pending.version);
  assert.throws(() => verifyOperatorRequest(s, operator, pending.id, noResource), status(400));
  const manual = verifyOperatorRequest(s, operator, pending.id, { ...noResource, method: 'manual', evidence: '운영자가 작업 완료를 수동으로 확인했습니다.' });
  assert.equal(manual.verification?.method, 'manual'); assert.equal(manual.verification?.resourceId, undefined);
});
test('revoked current membership prevents approvals, processing and verification', () => {
  const s = state(); const pending = ready(s); s.teams[0].memberIds = ['peer'];
  assert.throws(() => verifyOperatorRequest(s, operator, pending.id, verification(pending.version)), status(403));
  assert.throws(() => progressOperatorRequest(s, operator, pending.id, { expectedVersion: pending.version, status: 'failed', detail: '권한 회수' }), status(403));
  assert.throws(() => decideOperatorRequest(s, operator, pending.id, { expectedVersion: pending.version, status: 'approved', reason: '승인' }), status(403));
  assert.equal(listOperatorRequests(s, owner).total, 0); assert.equal(listOperatorRequests(s, operator).total, 1);
  assert.throws(() => readOperatorRequest(s, owner, pending.id), status(403));
  // An owner may still withdraw the obsolete request, and the operator may reject it.
  const rejected = decideOperatorRequest(s, operator, pending.id, { expectedVersion: pending.version, status: 'rejected', reason: '현재 접근 권한이 없습니다.' });
  const withdrawn = withdrawOperatorRequest(s, owner, pending.id, { expectedVersion: rejected.version, reason: '더 이상 담당하지 않습니다.' });
  assert.equal(withdrawn.decision.status, 'withdrawn');
});
test('withdrawal cannot be reversed and does not mutate linked work or existing access', () => {
  const s = state(); const request = ready(s); const work = structuredClone(s.teamTasks);
  const withdrawn = withdrawOperatorRequest(s, owner, request.id, { expectedVersion: request.version, reason: '요청을 철회합니다.' });
  const { idempotencyKey: _key, ...body } = input();
  assert.throws(() => reviseOperatorRequest(s, owner, request.id, { ...body, expectedVersion: withdrawn.version }), status(409));
  assert.throws(() => decideOperatorRequest(s, operator, request.id, { expectedVersion: withdrawn.version, status: 'approved', reason: '승인' }), status(409));
  assert.deepEqual(s.teamTasks, work); assert.equal(withdrawn.verification, null);
});
test('agent reads are owner-only and list projections are cloned', () => {
  const s = state(); const request = create(s);
  assert.throws(() => readOperatorRequest(s, peer, request.id), status(403));
  assert.equal(listOperatorRequests(s, peer).total, 0); assert.equal(listOperatorRequests(s, owner).total, 1);
  const list = listOperatorRequests(s, owner); list.items[0].title = 'tampered';
  assert.equal(readOperatorRequest(s, operator, request.id).title, request.title);
});
test('environment import is source-idempotent even after a revised body and records no approval', () => {
  const s = state(); const first = importEnvironmentRequest(s, 'environment')!;
  assert.equal(first.sourceKey, 'environment:environment'); assert.equal(first.sourceRunId, 'run'); assert.equal(first.decision.status, 'pending');
  assert.equal(first.scope.type, 'agent'); assert.equal(s.environmentRevisions[0].status, 'blocked');
  const { idempotencyKey: _key, ...body } = input({ scope: first.scope, links: first.links, category: first.category });
  const revised = reviseOperatorRequest(s, owner, first.id, { ...body, expectedVersion: first.version });
  assert.deepEqual(importEnvironmentRequest(s, 'environment'), revised); assert.equal(s.operatorRequests.length, 1);
  assert.throws(() => createOperatorRequest(s, 'owner', input({ scope: first.scope, links: first.links, idempotencyKey: 'duplicate-source' }), 'run'), status(409));
});
test('environment requests with ten maximum-length access items can be imported and no-access proposals are ignored', () => {
  const s = state(); s.environmentRevisions[0].requestedAccess = Array.from({ length: 10 }, () => 'x'.repeat(500));
  assert.equal(importEnvironmentRequest(s, 'environment')?.requestedScope.length, 5009);
  const noAccess = state(); noAccess.environmentRevisions[0].requestedAccess = [];
  assert.equal(importEnvironmentRequest(noAccess, 'environment'), null); assert.equal(noAccess.operatorRequests.length, 0);
});
test('explicit message promotion is source-idempotent and preserves task and user delivery state', () => {
  const s = state(); const { scope: _scope, links: _links, idempotencyKey: _key, ...body } = input();
  const first = promoteMessageRequest(s, operator, 'message', body, 'run');
  assert.equal(first.requesterAgentId, 'owner'); assert.equal(first.links.messageId, 'message'); assert.equal(first.links.taskId, 'task');
  assert.equal(s.messages[0].status, 'pending'); assert.equal(first.decision.status, 'pending');
  assert.deepEqual(promoteMessageRequest(s, operator, 'message', { ...body, title: 'another title' }), first);
  assert.throws(() => promoteMessageRequest(s, owner, 'message', body), status(403));
});
test('message promotion rejects foreign or operator-sent messages and cannot forge source links', () => {
  const { scope: _scope, links: _links, idempotencyKey: _key, ...body } = input();
  const s = state();
  assert.throws(() => promoteMessageRequest(s, operator, 'message', { ...body, links: { messageId: 'forged' } }), status(400));
  s.messages[0].senderAgentId = null;
  assert.throws(() => promoteMessageRequest(s, operator, 'message', body), status(403));
  s.messages[0].senderAgentId = 'owner'; s.messages[0].recipientAgentId = 'peer';
  assert.throws(() => promoteMessageRequest(s, operator, 'message', body), status(403));
});
test('revisions cannot replace source identities and evade import deduplication', () => {
  const s = state(); const first = importEnvironmentRequest(s, 'environment')!;
  const { idempotencyKey: _key, ...body } = input({ scope: first.scope, links: {} });
  assert.throws(() => reviseOperatorRequest(s, owner, first.id, { ...body, expectedVersion: first.version }), status(400));
  assert.equal(importEnvironmentRequest(s, 'environment')?.id, first.id);
});
test('agent tool set never exposes approval, verification, impersonation or force-resume arguments', () => {
  assert.deepEqual(operatorRequestTools.map(tool => tool.name), [
    'operator_request_create', 'operator_request_list', 'operator_request_read', 'operator_request_revise', 'operator_request_withdraw',
  ]);
  for (const tool of operatorRequestTools) {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
    for (const forbidden of ['requesterAgentId', 'sourceRunId', 'approved', 'verification', 'resumeReceipts']) assert.equal(Object.hasOwn(schema.properties, forbidden), false);
  }
});

test('cross-team requester in the same project may link the shared objective without claiming its task', () => {
  const s = state(); s.projects[0].teamIds.push('other-team');
  s.runs.push({ id: 'outside-run', agentId: 'outsider' });
  const request = createOperatorRequest(s, 'outsider', input(), 'outside-run');
  assert.equal(request.links.objectiveId, 'objective'); assert.equal(s.teamTasks.length, 1);
});
test('persistence accepts normal decision, verification, revision and withdrawal histories', () => {
  const s = state(); const request = create(s); validateOperatorRequestState(s);
  let current = decideOperatorRequest(s, operator, request.id, { expectedVersion: request.version, status: 'needs_information', reason: '페이지 범위를 명시하십시오.' });
  validateOperatorRequestState(s);
  const { idempotencyKey: _key, ...body } = input({ title: '페이지를 명시한 요청' });
  current = reviseOperatorRequest(s, operator, request.id, { ...body, expectedVersion: current.version }); validateOperatorRequestState(s);
  current = decideOperatorRequest(s, operator, request.id, { expectedVersion: current.version, status: 'approved', reason: '승인' }); validateOperatorRequestState(s);
  current = progressOperatorRequest(s, operator, request.id, { expectedVersion: current.version, status: 'in_progress', detail: '처리 중' }); validateOperatorRequestState(s);
  current = progressOperatorRequest(s, operator, request.id, { expectedVersion: current.version, status: 'verification_pending', detail: '검증 대기' }); validateOperatorRequestState(s);
  current = verifyOperatorRequest(s, operator, request.id, { ...verification(current.version), passed: false }); validateOperatorRequestState(s);
  current = progressOperatorRequest(s, operator, request.id, { expectedVersion: current.version, status: 'verification_pending', detail: '재검증' }); validateOperatorRequestState(s);
  current = verifyOperatorRequest(s, operator, request.id, verification(current.version)); validateOperatorRequestState(s);
  current = decideOperatorRequest(s, operator, request.id, { expectedVersion: current.version, status: 'approved', reason: '승인 근거 보완' }); validateOperatorRequestState(s);
  current = withdrawOperatorRequest(s, owner, request.id, { expectedVersion: current.version, reason: '철회' }); validateOperatorRequestState(s);
  assert.equal(current.decision.status, 'withdrawn');
});
test('persistence retains valid request history after current project membership is revoked', () => {
  const s = state(); const request = ready(s); verifyOperatorRequest(s, operator, request.id, verification(request.version));
  s.teams[0].memberIds = []; s.projects[0].teamIds = [];
  assert.doesNotThrow(() => validateOperatorRequestState(s));
});
test('persistence rejects duplicate identity, unknown shape, broken references and original-content tampering', () => {
  const s = state(); create(s);
  for (const mutate of [
    (copy: OperatorRequestState) => copy.operatorRequests.push(structuredClone(copy.operatorRequests[0])),
    (copy: OperatorRequestState) => { (copy.operatorRequests[0] as unknown as Record<string, unknown>).secretToken = 'x'; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].sourceRunId = 'peer-run'; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].history[0].content!.requestedScope = 'tampered'; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].title = 'unrecorded title'; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].links.taskId = 'missing'; },
  ]) { const copy = structuredClone(s); mutate(copy); assert.throws(() => validateOperatorRequestState(copy)); }
});
test('persistence rejects forged verification and agent-authored decisions', () => {
  const s = state(); const request = ready(s); verifyOperatorRequest(s, operator, request.id, verification(request.version));
  for (const mutate of [
    (copy: OperatorRequestState) => { copy.operatorRequests[0].verification!.evidence = 'unrecorded evidence'; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].history.find(item => item.kind === 'decision')!.actor = owner; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].history.find(item => item.kind === 'processing')!.processing!.status = 'in_progress'; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].history.find(item => item.kind === 'verification')!.verification!.contentVersion = 2; },
  ]) { const copy = structuredClone(s); mutate(copy); assert.throws(() => validateOperatorRequestState(copy)); }
});
function resumedState() {
  const s = state(); const pending = ready(s); const verified = verifyOperatorRequest(s, operator, pending.id, verification(pending.version));
  Object.assign(s.runs[0], { status: 'superseded', continuedByRunId: 'continued', budgetRootRunId: 'run',
    budgetTeamId: 'team', budgetProjectId: 'project', objectiveId: 'objective' });
  s.runs.push({ id: 'continued', agentId: 'owner', status: 'queued', continuedFromRunId: 'run', operatorRequestId: verified.id,
    budgetRootRunId: 'run', budgetTeamId: 'team', budgetProjectId: 'project', objectiveId: 'objective' });
  s.operatorRequests[0].resumeReceipts.push({ runId: 'run', continuedRunId: 'continued', contentVersion: verified.contentVersion,
    verificationId: verified.verification!.id, at: verified.verification!.verifiedAt });
  return s;
}
test('persistence verifies exact continuation lineage and old verification after a later content revision', () => {
  const s = resumedState(); validateOperatorRequestState(s);
  const { idempotencyKey: _key, ...body } = input({ requestedScope: '새 페이지의 읽기 권한' });
  reviseOperatorRequest(s, owner, s.operatorRequests[0].id, { ...body, expectedVersion: s.operatorRequests[0].version });
  assert.doesNotThrow(() => validateOperatorRequestState(s));
  assert.equal(s.operatorRequests[0].verification, null); assert.equal(s.operatorRequests[0].resumeReceipts[0].contentVersion, 1);
});
test('persistence rejects repeated resumes, foreign continuation and budget or objective reattribution', () => {
  const s = resumedState();
  for (const mutate of [
    (copy: OperatorRequestState) => copy.operatorRequests[0].resumeReceipts.push(structuredClone(copy.operatorRequests[0].resumeReceipts[0])),
    (copy: OperatorRequestState) => { copy.operatorRequests[0].resumeReceipts[0].verificationId = 'missing'; },
    (copy: OperatorRequestState) => { copy.operatorRequests[0].resumeReceipts[0].contentVersion = 2; },
    (copy: OperatorRequestState) => { copy.runs.at(-1)!.continuedFromRunId = 'peer-run'; },
    (copy: OperatorRequestState) => { copy.runs.at(-1)!.agentId = 'peer'; },
    (copy: OperatorRequestState) => { copy.runs.at(-1)!.operatorRequestId = 'another-request'; },
    (copy: OperatorRequestState) => { copy.runs.at(-1)!.budgetRootRunId = 'peer-run'; },
    (copy: OperatorRequestState) => { copy.runs.at(-1)!.budgetTeamId = 'other-team'; },
    (copy: OperatorRequestState) => { copy.runs.at(-1)!.objectiveId = 'different'; },
    (copy: OperatorRequestState) => { copy.runs[0].status = 'succeeded'; },
  ]) { const copy = structuredClone(s); mutate(copy); assert.throws(() => validateOperatorRequestState(copy)); }
});
test('persistence rejects forged continuation links without the reverse receipt even if no receipt points to them', () => {
  const s = resumedState();
  for (const mutate of [
    (copy: OperatorRequestState) => { copy.operatorRequests[0].resumeReceipts = []; },
    (copy: OperatorRequestState) => { copy.runs.push({ id: 'forged', agentId: 'owner', continuedFromRunId: 'run', operatorRequestId: copy.operatorRequests[0].id }); },
    (copy: OperatorRequestState) => { copy.runs.push({ id: 'forged', agentId: 'owner', status: 'superseded' }); },
    (copy: OperatorRequestState) => { copy.runs.push({ id: 'forged', agentId: 'owner', operatorRequestId: copy.operatorRequests[0].id }); },
  ]) { const copy = structuredClone(s); mutate(copy); assert.throws(() => validateOperatorRequestState(copy)); }
});
