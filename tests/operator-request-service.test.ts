import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService, type ServiceOptions } from '../server/service.ts';
import type { WorkspaceStore } from '../server/store.ts';
import { validateOperatorRequestState } from '../server/operator-requests.ts';
import { operatorRequestVerified, operatorResourceBlock, validOperatorContinuation } from '../server/operator-request-resume.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import type { Project, PeerMessage } from '../shared/collaboration.ts';
import type { OperatorRequest } from '../shared/operator-requests.ts';
import type { ExecutionHooks, ExecutionInput } from '../shared/types.ts';
import { OperationalFixtureRuntime, output, resources, waitFor, temporary } from './operational-budget-fixture.ts';

class RequestFixtureRuntime extends OperationalFixtureRuntime {
  readonly workspacePersistence = true;
  readonly workspaces = new Map<string, Record<string, string>>();
  override async execute(input: ExecutionInput, hooks: ExecutionHooks) {
    if (!this.workspaces.has(input.run.id)) this.workspaces.set(input.run.id,
      structuredClone(this.workspaces.get(input.run.workspaceSourceRunId ?? '') ?? {}));
    return super.execute(input, hooks);
  }
}
type InternalService = { store: WorkspaceStore; executions: Map<string, unknown>; drainOperatorRequests(): Promise<void> };
const denied = (code: number) => (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === code;
const internals = (service: AgentService) => service as unknown as InternalService;
async function fixture(t: TestContext, options: Partial<ServiceOptions> = {}) {
  const runtime = new RequestFixtureRuntime();
  const service = await AgentService.create({ runtime, scheduler: resources(2), recovery: { maxAttempts: 1, retryDelayMs: 0 }, ...options });
  t.after(() => service.close());
  const agent = await service.createAgent({ name: 'Operator request fixture', persona: 'No real model or provider access', allowWeb: false });
  const team = await service.createTeam({ name: 'Request team', memberIds: [agent.id] });
  const project = await service.collaboration('project_create', { name: 'Request project', teamIds: [team.id] }) as Project;
  const scope = { type: 'project' as const, id: project.id };
  const run = await service.startRun(agent.id, 'Resume the same scoped work after the operator request is verified', project.id, team.id);
  await waitFor(() => runtime.calls.length === 1);
  const call = runtime.calls[0]; const tool = call.hooks.onTool!;
  const requestInput = () => ({ scope, category: 'other' as const, title: '업무 입력 요청', reason: '현재 입력이 없습니다.',
    requestedAction: '업무 입력을 제공합니다.', requestedScope: '이 프로젝트에 지정한 업무 입력',
    verificationCriteria: '입력의 처리 결과를 확인합니다.', idempotencyKey: randomUUID() });
  const create = async (extra: Record<string, unknown> = {}) => tool('operator_request_create', { ...requestInput(), ...extra }) as Promise<OperatorRequest>;
  const current = async (id: string) => (await service.workspace()).operatorRequests!.find(item => item.id === id)!;
  const wait = async (request: OperatorRequest) => {
    await tool('operator_request_wait', { requestId: request.id, reason: '확인된 입력을 기다립니다.' });
    runtime.workspaces.get(run.id)!['draft.txt'] = 'original draft';
    await call.hooks.onCheckpoint?.({ phase: 'task', sessionId: 'original_session' });
    call.finish(output('Waiting with a visible partial result', { artifacts: [{ name: 'partial.md', mediaType: 'text/markdown', content: 'saved partial result' }] }));
    await waitFor(async () => (await service.workspace()).runs.find(item => item.id === run.id)?.status === 'waiting');
    await waitFor(() => !internals(service).executions.has(run.id));
  };
  const approve = async (request: OperatorRequest) => service.updateOperatorRequest(request.id, 'decide', {
    expectedVersion: (await current(request.id)).version, status: 'approved', reason: '기록된 범위를 승인합니다.' });
  const ready = async (request: OperatorRequest) => {
    await approve(request);
    return service.updateOperatorRequest(request.id, 'progress', {
      expectedVersion: (await current(request.id)).version, status: 'verification_pending', detail: '처리 후 검증을 기다립니다.' });
  };
  const verify = async (request: OperatorRequest, extra: Record<string, unknown> = {}) => service.verifyOperatorRequest(request.id, {
    expectedVersion: (await current(request.id)).version, method: 'manual', evidence: '운영자가 업무 입력 처리를 확인했습니다.', detail: '업무 입력 확인', ...extra });
  return { service, runtime, agent, team, project, scope, run, call, tool, create, current, wait, approve, ready, verify };
}
function githubFixture() {
  const repository = 'fixture/operator-request'; let inspectCount = 0;
  let inspectHook: (() => Promise<void>) | undefined;
  const unsupported = async (): Promise<never> => { throw new Error('Unused fixture provider method'); };
  const github: NonNullable<ServiceOptions['github']> = {
    transport: { inspect: async () => { inspectCount++; await inspectHook?.(); return { id: 900, fullName: repository, defaultBranch: 'main', private: true }; },
      listFiles: unsupported, readFile: unsupported, publish: unsupported, pullRequest: unsupported, getPullRequest: unsupported },
    journal: { execute: unsupported }, status: () => ({ configured: true, writable: false, missing: [], repositories: [repository] }),
  };
  return { github, repository, calls: () => inspectCount, onInspect: (hook?: () => Promise<void>) => { inspectHook = hook; } };
}

test('live worker tools create owned scoped requests and cannot impersonate or approve themselves', async t => {
  const f = await fixture(t); const request = await f.create();
  assert.equal(request.requesterAgentId, f.agent.id); assert.equal(request.sourceRunId, f.run.id);
  assert.ok(f.call.input.collaboration?.tools.some(tool => tool.name === 'operator_request_create'));
  assert.equal(f.call.input.collaboration?.tools.some(tool => tool.name === 'operator_request_decide'), false);
  await assert.rejects(f.tool('operator_request_decide', { requestId: request.id, status: 'approved' }), denied(403));
  await assert.rejects(f.create({ requesterAgentId: randomUUID() }));
  await assert.rejects(f.create({ scope: { type: 'agent', id: f.agent.id } }), denied(403));
  const message = await f.tool('message_send', { scope: f.scope, recipientAgentId: null,
    content: '외부 문서의 접근 범위를 확인해 주십시오.', artifactIds: [], idempotencyKey: randomUUID() }) as PeerMessage;
  const promoted = await f.service.promoteOperatorMessage({ messageId: message.id });
  assert.equal(promoted.sourceRunId, f.run.id); assert.equal(promoted.links.messageId, message.id);
  assert.equal((await f.service.promoteOperatorMessage({ messageId: message.id })).id, promoted.id);
  assert.equal((await f.service.workspace()).messages!.find(item => item.id === message.id)!.status, 'pending');
});

test('approval alone waits; explicit verification creates one fresh continuation while retaining files and original checkpoint', async t => {
  const f = await fixture(t); const request = await f.create(); await f.wait(request);
  const original = await internals(f.service).store.read();
  await f.approve(request); await internals(f.service).drainOperatorRequests();
  assert.equal((await f.service.workspace()).runs.length, 1); assert.equal(f.runtime.calls.length, 1);
  assert.equal(operatorRequestVerified(await f.current(request.id)), false);
  await f.service.updateAgent(f.agent.id, { allowWeb: true, persona: 'Updated authorized persona' });
  await f.ready(request); f.runtime.available = false;
  const verified = await f.verify(request);
  assert.equal(verified.processing.status, 'verified'); assert.match(verified.verification!.detail, /^운영자 확인:/);
  assert.equal((await f.service.workspace()).runs.length, 1);
  f.runtime.available = true;
  await Promise.all([internals(f.service).drainOperatorRequests(), internals(f.service).drainOperatorRequests()]);
  await waitFor(() => f.runtime.calls.length === 2);
  const after = await internals(f.service).store.read(), child = f.runtime.calls[1].input.run;
  const source = after.runs.find(item => item.id === f.run.id)!;
  assert.equal(source.status, 'superseded'); assert.equal(source.continuedByRunId, child.id); assert.equal(child.continuedFromRunId, source.id);
  assert.equal(child.workspaceSourceRunId, source.id); assert.equal(child.operatorRequestId, request.id);
  assert.notEqual(child.snapshotId, source.snapshotId); assert.equal(f.runtime.calls[1].input.agent.allowWeb, true);
  assert.equal(after.executionStates[source.id].input.agent.allowWeb, false);
  assert.equal(f.runtime.workspaces.get(child.id)!['draft.txt'], 'original draft');
  assert.deepEqual(after.executionStates[source.id], original.executionStates[source.id]);
  assert.equal(f.runtime.calls[1].input.previousResult?.result, 'Waiting with a visible partial result');
  assert.equal(f.runtime.calls[1].input.checkpoint, undefined, 'A fresh permission snapshot cannot reuse the old model session');
  assert.equal(source.checkpointResults?.[0].artifacts[0].name, 'partial.md');
  assert.equal(validOperatorContinuation(after, after.runs.find(item => item.id === child.id)!)?.id, source.id);
  validateOperatorRequestState(after);
  await internals(f.service).drainOperatorRequests();
  assert.equal((await f.current(request.id)).resumeReceipts.length, 1); assert.equal((await f.service.workspace()).runs.length, 2);
});

test('verified requests preserve explicit pause and cancellation until the user changes that state', async t => {
  for (const control of ['pause', 'cancel'] as const) await t.test(control, async inner => {
    const f = await fixture(inner); const request = await f.create(); await f.wait(request); await f.ready(request);
    if (control === 'pause') await f.service.pauseRun(f.run.id); else await f.service.cancelRun(f.run.id);
    await f.verify(request); await internals(f.service).drainOperatorRequests();
    assert.equal((await f.service.workspace()).runs.length, 1); assert.equal((await f.current(request.id)).resumeReceipts.length, 0);
    assert.equal((await f.service.workspace()).runs[0].status, control === 'pause' ? 'paused' : 'cancelled');
  });
});

test('provider inspection failure is recorded as failed verification without resuming a waiting run', async t => {
  const remote = githubFixture(); const f = await fixture(t, { github: remote.github });
  const connection = await f.service.createConnection({ repository: remote.repository, access: 'read' });
  const request = await f.create({ category: 'connector' }); await f.wait(request); await f.ready(request);
  remote.onInspect(async () => { throw new Error('Fixture remote unavailable'); });
  const failed = await f.verify(request, { method: 'github', resourceId: connection.id });
  assert.equal(remote.calls(), 1); assert.equal(failed.verification!.passed, false); assert.equal(failed.processing.status, 'failed');
  assert.match(failed.verification!.detail, /Fixture remote unavailable/); assert.equal(failed.decision.status, 'approved');
  await internals(f.service).drainOperatorRequests(); assert.equal((await f.service.workspace()).runs.length, 1);
});

test('GitHub verification needs current scoped grants and a verified continuation receives the newly granted snapshot', async t => {
  const remote = githubFixture(); const f = await fixture(t, { github: remote.github });
  const connection = await f.service.createConnection({ repository: remote.repository, access: 'read' });
  const request = await f.create({ category: 'connector' }); await f.wait(request); await f.ready(request);
  const missingGrant = await f.verify(request, { method: 'github', resourceId: connection.id });
  assert.equal(missingGrant.processing.status, 'failed'); assert.match(missingGrant.verification!.detail, /권한/);
  const currentConnection = (await f.service.workspace()).connections.find(item => item.id === connection.id)!;
  await f.service.updateConnection(connection.id, { expectedVersion: currentConnection.version, grants: [{
    agentId: f.agent.id, teamId: f.team.id, projectId: f.project.id, access: 'read' }] });
  await f.ready(request); f.runtime.available = false;
  const verified = await f.verify(request, { method: 'github', resourceId: connection.id });
  assert.equal(verified.processing.status, 'verified'); assert.match(verified.verification!.evidence, /repository identity/);
  f.runtime.available = true; await internals(f.service).drainOperatorRequests(); await waitFor(() => f.runtime.calls.length === 2);
  const after = await internals(f.service).store.read(); const child = f.runtime.calls[1];
  assert.equal(after.executionStates[f.run.id].input.connections.length, 0);
  assert.equal(child.input.connections[0].id, connection.id); assert.equal(child.input.agent.repositoryIds[0], connection.id);
  const result = await child.hooks.onTool!('github_repository', { connectionId: connection.id });
  assert.ok(result); validateOperatorRequestState(await internals(f.service).store.read());
});

test('grant revocation after successful verification blocks the actual resume boundary', async t => {
  const remote = githubFixture(); const f = await fixture(t, { github: remote.github });
  const connection = await f.service.createConnection({ repository: remote.repository, access: 'read' });
  await f.service.verifyConnection(connection.id);
  await f.service.updateConnection(connection.id, { expectedVersion: 2, grants: [{
    agentId: f.agent.id, teamId: f.team.id, projectId: f.project.id, access: 'read' }] });
  const request = await f.create({ category: 'connector' }); await f.wait(request); await f.ready(request); f.runtime.available = false;
  await f.verify(request, { method: 'github', resourceId: connection.id });
  const current = (await f.service.workspace()).connections.find(item => item.id === connection.id)!;
  await f.service.updateConnection(connection.id, { expectedVersion: current.version, grants: [] });
  f.runtime.available = true; await internals(f.service).drainOperatorRequests();
  assert.equal((await f.service.workspace()).runs.length, 1); assert.equal((await f.current(request.id)).resumeReceipts.length, 0);
  assert.match((await f.current(request.id)).resumeBlockReason!, /현재 권한/);
});

test('GitHub grant access downgrade after verification blocks resume despite unchanged repository access', async t => {
  const remote = githubFixture(); const f = await fixture(t, { github: remote.github });
  const connection = await f.service.createConnection({ repository: remote.repository, access: 'write' });
  await f.service.verifyConnection(connection.id);
  const grant = { agentId: f.agent.id, teamId: f.team.id, projectId: f.project.id, access: 'write' as const };
  await f.service.updateConnection(connection.id, { expectedVersion: 2, grants: [grant] });
  const request = await f.create({ category: 'connector' }); await f.wait(request); await f.ready(request); f.runtime.available = false;
  const verified = await f.verify(request, { method: 'github', resourceId: connection.id });
  assert.equal(verified.processing.status, 'verified'); assert.deepEqual(JSON.parse(verified.verification!.evidence).scopedGrants, [grant]);
  const connectionBefore = (await f.service.workspace()).connections.find(item => item.id === connection.id)!;
  await f.service.updateConnection(connection.id, { expectedVersion: connectionBefore.version, grants: [{ ...grant, access: 'read' }] });
  f.runtime.available = true; await internals(f.service).drainOperatorRequests();
  const after = await internals(f.service).store.read();
  assert.equal(after.connections.find(item => item.id === connection.id)!.access, 'write');
  assert.equal(after.runs.find(item => item.id === f.run.id)!.status, 'waiting');
  assert.equal((await f.current(request.id)).resumeReceipts.length, 0); assert.match((await f.current(request.id)).resumeBlockReason!, /현재 권한/);
  const identity = JSON.parse(verified.verification!.evidence);
  for (const evidence of ['null', '[]', JSON.stringify({ ...identity, scopedGrants: [] }), JSON.stringify({ ...identity, scopedGrants: [{ ...grant, agentId: randomUUID() }] })]) {
    const malformed = structuredClone(verified); malformed.verification!.evidence = evidence;
    assert.ok(operatorResourceBlock(after, malformed, after.runs.find(item => item.id === f.run.id)));
  }
});

test('changing request content during a provider check invalidates the in-flight verification', async t => {
  const remote = githubFixture(); const f = await fixture(t, { github: remote.github });
  const connection = await f.service.createConnection({ repository: remote.repository, access: 'read' });
  const request = await f.create({ category: 'connector' }); await f.wait(request); await f.ready(request);
  let release!: () => void; let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  remote.onInspect(async () => { entered = true; await gate; });
  const pending = f.verify(request, { method: 'github', resourceId: connection.id });
  const rejected = assert.rejects(pending, denied(409)); await waitFor(() => entered);
  const current = await f.current(request.id);
  const { scope, links, category, title, reason, requestedAction, verificationCriteria } = current;
  await f.service.updateOperatorRequest(request.id, 'revise', { expectedVersion: current.version,
    scope, links, category, title, reason, requestedAction, verificationCriteria, requestedScope: '새로 지정된 페이지의 범위' });
  release(); await rejected;
  assert.equal((await f.current(request.id)).contentVersion, 2); assert.equal((await f.current(request.id)).verification, null);
  assert.equal((await f.current(request.id)).decision.status, 'pending');
});

test('environment verification rejects failed probes and builds, then selects the verified environment only in the fresh continuation', async t => {
  const f = await fixture(t); const request = await f.create({ category: 'environment' }); await f.wait(request); await f.ready(request);
  const revisionId = randomUUID(), buildRunId = randomUUID(), timestamp = new Date().toISOString();
  await internals(f.service).store.change(state => {
    state.environmentRevisions.push({ id: revisionId, agentId: f.agent.id, baseRevisionId: null, sourceRunId: f.run.id,
      buildRunId, reason: 'Fixture environment readiness', requestedAccess: [], spec: { packages: [], servers: [] },
      status: 'ready', error: null, createdAt: timestamp, completedAt: timestamp,
      report: { imageId: `sha256:${'a'.repeat(64)}`, contentHash: 'b'.repeat(64), lockfileHash: 'c'.repeat(64),
        packages: [], tools: [], checks: [{ name: 'fixture probe', passed: false, detail: 'Not verified yet' }], createdAt: timestamp } });
    state.runs.push({ ...structuredClone(state.runs.find(run => run.id === f.run.id)!), id: buildRunId,
      status: 'failed', kind: 'environment', environmentRevisionId: revisionId, waitingForOperatorRequest: null,
      completedAt: timestamp, error: 'Fixture build not completed' });
  });
  let verified = await f.verify(request, { method: 'environment', resourceId: revisionId });
  assert.equal(verified.processing.status, 'failed'); assert.equal(verified.verification!.passed, false);
  await internals(f.service).store.change(state => { state.environmentRevisions[0].report!.checks[0].passed = true; });
  await f.ready(request); verified = await f.verify(request, { method: 'environment', resourceId: revisionId });
  assert.equal(verified.processing.status, 'failed');
  await internals(f.service).store.change(state => {
    const build = state.runs.find(run => run.id === buildRunId)!; build.status = 'succeeded'; build.error = null;
  });
  await f.ready(request); f.runtime.available = false;
  verified = await f.verify(request, { method: 'environment', resourceId: revisionId });
  assert.equal(verified.processing.status, 'verified'); assert.match(verified.verification!.evidence, /contentHash/);
  assert.equal((await f.service.workspace()).agents[0].environmentRevisionId ?? null, null);
  const beforeResume = await internals(f.service).store.read();
  assert.match(JSON.parse(verified.verification!.evidence).reportHash, /^[a-f0-9]{64}$/);
  for (const mutate of [
    (copy: typeof beforeResume) => { copy.environmentRevisions[0].report!.imageId = `sha256:${'d'.repeat(64)}`; },
    (copy: typeof beforeResume) => { copy.environmentRevisions[0].report!.checks[0].detail = 'Another restored probe'; },
    (copy: typeof beforeResume) => { copy.environmentRevisions[0].spec.packages.push({ name: 'another-package', version: '1.0.0' }); },
  ]) {
    const changed = structuredClone(beforeResume); mutate(changed);
    assert.match(operatorResourceBlock(changed, verified, changed.runs.find(run => run.id === f.run.id))!, /일치하지/);
  }
  await internals(f.service).store.change(state => { state.environmentRevisions[0].report!.imageId = `sha256:${'d'.repeat(64)}`; });
  f.runtime.available = true; await internals(f.service).drainOperatorRequests();
  assert.equal((await f.current(request.id)).resumeReceipts.length, 0);
  assert.match((await f.current(request.id)).resumeBlockReason!, /일치하지/);
  await internals(f.service).store.change(state => { state.environmentRevisions[0].report = structuredClone(beforeResume.environmentRevisions[0].report); });
  await internals(f.service).drainOperatorRequests(); await waitFor(() => f.runtime.calls.length === 2);
  assert.equal(f.runtime.calls[1].input.environment?.revisionId, revisionId);
  const state = await internals(f.service).store.read();
  assert.equal(state.executionStates[f.run.id].input.environment, undefined);
  assert.equal(state.agents[0].environmentRevisionId, revisionId);
  assert.deepEqual((await f.current(request.id)).history.filter(item => item.verification).map(item => item.verification!.passed), [false, false, true]);
  validateOperatorRequestState(state);
});

test('scope revocation before verification rejects the request while preserving its audit record', async t => {
  const f = await fixture(t); const request = await f.create(); await f.wait(request); await f.ready(request);
  await f.service.updateTeam(f.team.id, { memberIds: [] });
  await assert.rejects(f.verify(request), denied(403));
  assert.equal((await f.current(request.id)).processing.status, 'verification_pending');
  assert.equal((await f.current(request.id)).verification, null); assert.equal((await f.service.workspace()).runs.length, 1);
  validateOperatorRequestState(await internals(f.service).store.read());
});

test('successful request verification does not bypass the existing model budget', async t => {
  const directory = await temporary(t);
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'request-budget'), ownerKey: randomUUID() });
  await budget.update({ expectedRevision: 0, dailyLimit: 1 });
  const f = await fixture(t, { operationalBudget: budget });
  const request = await f.create(); await f.wait(request); await f.ready(request); await f.verify(request);
  await internals(f.service).drainOperatorRequests();
  await waitFor(async () => (await f.service.workspace()).runs.some(run => run.continuedFromRunId === f.run.id && run.modelBudgetPaused));
  assert.equal(f.runtime.calls.length, 1); assert.equal((await f.service.modelBudgetStatus()).used, 1);
  assert.equal((await f.current(request.id)).resumeReceipts.length, 1);
  await f.service.updateModelBudget({ expectedRevision: 1, dailyLimit: 2 }); await f.service.reconcileModelBudget();
  await waitFor(() => f.runtime.calls.length === 2); assert.equal((await f.current(request.id)).resumeReceipts.length, 1);
});

test('operator request consultation is a separate read-only exchange and preserves the original waiting condition', async t => {
  const f = await fixture(t); const request = await f.create(); await f.wait(request);
  const conversation = await f.service.consultOperatorRequest(request.id, { content: '요청 범위를 구체적으로 설명하십시오.', idempotencyKey: randomUUID() });
  await waitFor(() => f.runtime.calls.length === 2);
  const consultation = f.runtime.calls[1];
  assert.equal(consultation.input.run.consultationOfRunId, f.run.id); assert.equal(consultation.input.run.conversationId, conversation.conversationId);
  assert.equal(consultation.input.agent.allowWeb, false); assert.deepEqual(consultation.input.connections, []);
  await assert.rejects(consultation.hooks.onTool!('operator_request_create', {}), denied(403));
  consultation.finish(output('대표에게 공개되는 상담 답변'));
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === consultation.input.run.id)?.status === 'succeeded');
  const after = await f.service.workspace(); const source = after.runs.find(item => item.id === f.run.id)!;
  assert.equal(source.status, 'waiting'); assert.equal(source.waitingForOperatorRequest!.requestId, request.id);
  assert.ok(after.conversationMessages!.some(message => message.content.includes('대표에게 공개되는 상담 답변')));
  assert.equal((await f.current(request.id)).decision.status, 'pending');
});

test('a waiting result preserves its environment access proposal and imports exactly one linked request', async t => {
  const f = await fixture(t), request = await f.create();
  await f.tool('operator_request_wait', { requestId: request.id, reason: '대표 처리 대기' });
  f.call.finish(output('대기하면서 환경 제안을 보존합니다.', { environmentProposal: {
    reason: '연결이 필요한 환경', spec: { packages: [], servers: [] }, requestedAccess: ['지정 업무용 커넥터 접근'],
  } }));
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === f.run.id)?.status === 'waiting');
  const state = await f.service.workspace(), revision = state.environmentRevisions!.find(item => item.sourceRunId === f.run.id)!;
  assert.equal(revision.status, 'blocked');
  const linked = state.operatorRequests!.filter(item => item.links.environmentRevisionId === revision.id);
  assert.equal(linked.length, 1); assert.equal(linked[0].sourceRunId, f.run.id);
  assert.equal(linked[0].decision.status, 'pending'); assert.equal(f.runtime.calls.length, 1);
});
