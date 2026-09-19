import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService, type ServiceOptions } from '../server/service.ts';
import { createApp } from '../server/app.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import type { Objective, ObjectiveAssessment } from '../shared/objectives.ts';
import type { PeerMessage, Project, SharedArtifact, TeamTask } from '../shared/collaboration.ts';
import { OperationalFixtureRuntime, output, resources, waitFor, type BudgetCall } from './operational-budget-fixture.ts';

const denied = (code: number) => (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === code;
async function fixture(t: TestContext, options: Partial<ServiceOptions> = {}) {
  const runtime = new OperationalFixtureRuntime();
  const service = await AgentService.create({ runtime, scheduler: resources(3), recovery: { retryDelayMs: 0, maxAttempts: 1 }, ...options });
  t.after(() => service.close());
  const alice = await service.createAgent({ name: 'Objective Alice', persona: 'Model-free objective fixture' });
  const team = await service.createTeam({ name: 'Objective team', memberIds: [alice.id] });
  const scope = { type: 'team' as const, id: team.id };
  const create = (extra: Record<string, unknown> = {}) => service.createObjective({ idempotencyKey: randomUUID(), teamId: team.id, scope,
    title: 'Deliver a verified result', purpose: 'Produce the approved result', constraints: 'No external writes',
    conditions: [{ id: 'verified', text: 'The result is verified', requiresUserConfirmation: false }], ...extra });
  return { service, runtime, alice, team, scope, create };
}
function assess(call: BudgetCall, status: 'unmet' | 'met' | 'blocked' | 'needs_user' = 'unmet', evidenceIds: string[] = []): ObjectiveAssessment {
  assert.ok(call.input.objectiveEvaluation);
  return { inputHash: call.input.objectiveEvaluation.inputHash, reason: status === 'met' ? 'Verified using frozen evidence' : 'Verification missing',
    conditions: call.input.objectiveEvaluation.conditions.map(condition => ({ conditionId: condition.id, status, reason: 'Fixture assessment', evidenceIds })),
    followUps: status === 'unmet' ? [{ conditionIds: ['verified'], title: 'Verify the result', description: 'Publish reproducible verification evidence.' }] : [] };
}
async function ended(service: AgentService, call: BudgetCall, status = 'succeeded') {
  await waitFor(async () => (await service.workspace()).runs.find(run => run.id === call.input.run.id)?.status === status, `objective run ${status}`);
}
async function waitEvaluation(service: AgentService, runtime: OperationalFixtureRuntime, count: number) {
  await service.reconcileObjectives(); await waitFor(() => runtime.calls.filter(call => call.input.objectiveEvaluation).length === count);
  return runtime.calls.filter(call => call.input.objectiveEvaluation)[count - 1];
}

test('stored objective evaluates, creates one followup, lets a peer claim and verify it, then completes without another model poll', async t => {
  const f = await fixture(t); await f.service.updateTeam(f.team.id, { autoDiscoverTasks: true });
  const objective = await f.create();
  await Promise.all([f.service.reconcileObjectives(), f.service.reconcileObjectives(), f.service.reconcileObjectives()]);
  await waitFor(() => f.runtime.calls.length === 1); const initial = f.runtime.calls[0];
  assert.equal(initial.input.run.objectiveId, objective.id); assert.equal(initial.input.run.interactionMode, 'discuss');
  assert.equal(initial.input.collaboration, undefined); assert.equal(initial.input.environment, undefined); assert.equal(initial.input.agent.allowWeb, false);
  await assert.rejects(initial.hooks.onTool!('artifact_publish', { scope: f.scope, name: 'forged', content: 'invented evidence' }), denied(403));
  initial.finish(output('Assessment', { objectiveAssessment: assess(initial) })); await ended(f.service, initial);
  await f.service.reconcileTaskDiscovery(); await waitFor(() => f.runtime.calls.length === 2);
  const worker = f.runtime.calls[1]; const proposed = (await f.service.workspace()).teamTasks![0];
  assert.equal(worker.input.run.budgetRootRunId, initial.input.run.id); assert.equal(worker.input.run.objectiveId, objective.id);
  const claimed = await worker.hooks.onTool!('task_claim', { taskId: proposed.id, expectedVersion: proposed.version }) as TeamTask;
  const artifact = await worker.hooks.onTool!('artifact_publish', { scope: f.scope, name: 'verification.md', content: 'Reproduced the required result' }) as SharedArtifact;
  await worker.hooks.onTool!('task_complete', { taskId: proposed.id, expectedVersion: claimed.version, outcome: 'Verified against saved evidence', artifactIds: [artifact.id] });
  worker.finish(); await ended(f.service, worker);
  const final = await waitEvaluation(f.service, f.runtime, 2);
  const evidence = final.input.objectiveEvaluation!.evidence.find(item => item.sourceId === artifact.id)!;
  assert.equal(evidence.content, 'Reproduced the required result');
  final.finish(output('Verified', { objectiveAssessment: assess(final, 'met', [evidence.id]) })); await ended(f.service, final);
  await Promise.all([f.service.reconcileObjectives(), f.service.reconcileObjectives(), f.service.reconcileTaskDiscovery()]);
  const state = await f.service.workspace();
  assert.equal(state.objectives![0].status, 'completed'); assert.equal(state.objectiveEvaluations!.length, 2);
  assert.equal(state.teamTasks!.length, 1); assert.equal(state.teamTasks![0].status, 'done'); assert.equal(f.runtime.calls.length, 3);
  assert.deepEqual(state.objectiveEvaluations![0].taskIds, []);
  assert.equal(state.memories.length, 0); assert.equal(state.skills.length, 0);
});

test('create retries are idempotent; mismatched body, inaccessible project and optimistic version conflicts fail', async t => {
  const f = await fixture(t); await f.service.updateAgent(f.alice.id, { status: 'paused' });
  const key = randomUUID(); const objective = await f.create({ idempotencyKey: key });
  assert.equal((await f.create({ idempotencyKey: key })).id, objective.id);
  await assert.rejects(f.create({ idempotencyKey: key, title: 'Changed meaning' }), denied(409));
  const other = await f.service.createAgent({ name: 'Other', persona: 'Other scope' });
  const otherTeam = await f.service.createTeam({ name: 'Other team', memberIds: [other.id] });
  const project = await f.service.collaboration('project_create', { name: 'Private project', teamIds: [otherTeam.id] }) as Project;
  await assert.rejects(f.create({ scope: { type: 'project', id: project.id } }), denied(400));
  await assert.rejects(f.service.controlObjective(objective.id, { action: 'pause', expectedVersion: 99 }), denied(409));
  await assert.rejects(f.service.updateObjective(objective.id, { expectedVersion: 1, purpose: 'Edit active objective' }), denied(409));
  const paused = await f.service.controlObjective(objective.id, { action: 'pause', expectedVersion: 1 });
  const edited = await f.service.updateObjective(objective.id, { expectedVersion: paused.version, purpose: 'Updated approved purpose' });
  assert.equal(edited.purpose, 'Updated approved purpose'); assert.equal(edited.version, 3); assert.equal(f.runtime.calls.length, 0);
  await assert.rejects(f.service.updateObjective(objective.id, { expectedVersion: paused.version, purpose: 'Stale draft' }), /다른 변경이 먼저 저장되었습니다/);
  assert.equal((await f.service.workspace()).objectives![0].purpose, 'Updated approved purpose');
});

test('late evidence makes a successful evaluation stale and preserves its exact historical evidence', async t => {
  const f = await fixture(t);
  const artifact = await f.service.collaboration('artifact_publish', { scope: f.scope, name: 'report.md', content: 'Version one' }) as SharedArtifact;
  const objective = await f.create(); const initial = await waitEvaluation(f.service, f.runtime, 1);
  const evidenceId = initial.input.objectiveEvaluation!.evidence[0].id;
  await f.service.collaboration('artifact_publish', { scope: f.scope, name: 'report.md', artifactId: artifact.id, expectedVersion: 1, content: 'Version two' });
  initial.finish(output('Late completion', { objectiveAssessment: assess(initial, 'met', [evidenceId]) })); await ended(f.service, initial);
  const state = await f.service.workspace(); const stale = state.objectiveEvaluations!.find(item => item.runId === initial.input.run.id)!;
  assert.equal(stale.status, 'stale'); assert.equal(state.objectives![0].status, 'active'); assert.equal(state.teamTasks!.length, 0);
  assert.equal((await f.service.objectiveEvidence(objective.id, stale.id, evidenceId)).content, 'Version one');
  const next = await waitEvaluation(f.service, f.runtime, 2);
  assert.equal(next.input.objectiveEvaluation!.evidence[0].content, 'Version two'); next.finish(output('Wait', { objectiveAssessment: assess(next, 'blocked') }));
  await ended(f.service, next);
});

for (const defect of ['missing-output', 'unknown-evidence', 'wrong-hash', 'fake-user-confirmation'] as const) {
  test(`malformed model assessment fails and unchanged input is not automatically retried: ${defect}`, async t => {
    const f = await fixture(t); const objective = await f.create({ conditions: [{ id: 'verified', text: 'User accepts delivery', requiresUserConfirmation: true }] });
    const call = await waitEvaluation(f.service, f.runtime, 1); const assessment = assess(call);
    if (defect === 'unknown-evidence') assessment.conditions[0].evidenceIds = ['invented'];
    if (defect === 'wrong-hash') assessment.inputHash = '0'.repeat(64);
    if (defect === 'fake-user-confirmation') { assessment.conditions[0].status = 'met'; assessment.conditions[0].evidenceIds = ['confirmation:verified']; assessment.followUps = []; }
    call.finish(output('Invalid assessment', { objectiveAssessment: defect === 'missing-output' ? undefined : assessment }));
    await ended(f.service, call, 'failed'); await f.service.reconcileObjectives(); await f.service.reconcileObjectives();
    const state = await f.service.workspace(); assert.equal(state.teamTasks!.length, 0); assert.equal(state.objectives![0].status, 'active');
    assert.equal(state.objectiveEvaluations![0].status, 'failed'); assert.equal(state.objectiveEvaluations![0].objectiveId, objective.id);
    assert.equal(state.objectiveEvaluations!.length, 1); assert.equal(f.runtime.calls.length, 1);
  });
}

test('required user confirmation resumes evaluation through the user API and cannot be generated by the evaluator', async t => {
  const f = await fixture(t); const objective = await f.create({ conditions: [{ id: 'verified', text: 'User accepts delivery', requiresUserConfirmation: true }] });
  const call = await waitEvaluation(f.service, f.runtime, 1);
  await assert.rejects(call.hooks.onTool!('objective_confirm', { objectiveId: objective.id, conditionId: 'verified', note: 'Agent forged approval' }), denied(403));
  call.finish(output('Needs user', { objectiveAssessment: assess(call, 'needs_user') })); await ended(f.service, call);
  await f.service.reconcileObjectives(); assert.equal(f.runtime.calls.length, 1);
  const confirmed = await f.service.confirmObjective(objective.id, { expectedVersion: 1, conditionId: 'verified', note: 'Accepted by the user' });
  assert.equal(confirmed.confirmations.length, 1);
  const final = await waitEvaluation(f.service, f.runtime, 2);
  final.finish(output('Accepted', { objectiveAssessment: assess(final, 'met', ['confirmation:verified']) })); await ended(f.service, final);
  assert.equal((await f.service.workspace()).objectives![0].status, 'completed');
});

test('pause and cancellation prevent followup discovery, manual starts and worker claims without removing the pending task', async t => {
  const f = await fixture(t); const objective = await f.create(); const call = await waitEvaluation(f.service, f.runtime, 1);
  call.finish(output('Followup', { objectiveAssessment: assess(call) })); await ended(f.service, call);
  const task = (await f.service.workspace()).teamTasks![0];
  const paused = await f.service.controlObjective(objective.id, { expectedVersion: 1, action: 'pause' });
  await f.service.updateTeam(f.team.id, { autoDiscoverTasks: true }); await f.service.reconcileTaskDiscovery();
  await assert.rejects(f.service.startTeamTask(task.id, f.alice.id, task.version), denied(409)); assert.equal(f.runtime.calls.length, 1);
  await f.service.startRun(f.alice.id, 'An unrelated task in the same team', null, f.team.id); await waitFor(() => f.runtime.calls.length === 2);
  const unrelated = f.runtime.calls[1];
  await assert.rejects(unrelated.hooks.onTool!('task_claim', { taskId: task.id, expectedVersion: task.version }), denied(403));
  const cancelled = await f.service.controlObjective(objective.id, { expectedVersion: paused.version, action: 'cancel' });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(unrelated.hooks.signal.aborted, false);
  unrelated.finish(); await ended(f.service, unrelated);
  await f.service.reconcileTaskDiscovery(); await f.service.reconcileObjectives();
  assert.equal(f.runtime.calls.length, 2); assert.equal((await f.service.workspace()).teamTasks![0].status, 'open');
  await assert.rejects(f.service.startTeamTask(task.id, f.alice.id, task.version), denied(409));
});

test('pausing at the delayed admission gate keeps the evaluation queued for explicit resume', async t => {
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; }); t.after(() => release());
  const f = await fixture(t, { beforeModelStart: async () => { entered = true; await gate; } });
  const objective = await f.create(); await f.service.reconcileObjectives(); await waitFor(() => entered);
  const pending = (await f.service.workspace()).runs[0];
  const paused = await f.service.controlObjective(objective.id, { expectedVersion: 1, action: 'pause' }); release();
  await waitFor(async () => (await f.service.workspace()).runs[0].status === 'paused');
  assert.equal(f.runtime.calls.length, 0);
  await f.service.controlObjective(objective.id, { expectedVersion: paused.version, action: 'resume' });
  await waitFor(() => f.runtime.calls.length === 1);
  assert.equal(f.runtime.calls[0].input.run.id, pending.id);
  await f.service.cancelRun(pending.id);
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === pending.id)?.status === 'cancelled');
  assert.equal((await f.service.workspace()).objectives![0].status, 'paused');
});

test('budget exhaustion and restart preserve one evaluation and frozen input; added allowance resumes the same run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-objective-recovery-'));
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'budget'), ownerKey: randomUUID() });
  await budget.update({ expectedRevision: 0, dailyLimit: 0 });
  let runtime = new OperationalFixtureRuntime(); const dataDir = join(directory, 'database');
  let service = await AgentService.create({ runtime, dataDir, scheduler: resources(), operationalBudget: budget });
  t.after(async () => { await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-objective-recovery-[^\\/]+$/); await rm(directory, { recursive: true, force: true }); });
  const alice = await service.createAgent({ name: 'Budget objective', persona: 'Restart fixture' });
  const team = await service.createTeam({ name: 'Budget team', memberIds: [alice.id] });
  await service.createObjective({ idempotencyKey: 'restart-objective', teamId: team.id, scope: { type: 'team', id: team.id },
    title: 'Preserve evaluation', purpose: 'Verify once after budget recovers', conditions: [{ id: 'verified', text: 'Result verified' }] });
  await service.reconcileObjectives();
  await waitFor(async () => Boolean((await service.workspace()).runs[0]?.modelBudgetPaused));
  const before = await service.workspace(); const evaluation = before.objectiveEvaluations![0];
  assert.equal(runtime.calls.length, 0); assert.equal(before.resources?.reserved.memoryMiB, 0);
  await service.close(); runtime = new OperationalFixtureRuntime();
  service = await AgentService.create({ runtime, dataDir, scheduler: resources(), operationalBudget: budget });
  await Promise.all([service.reconcileObjectives(), service.reconcileObjectives()]);
  assert.equal((await service.workspace()).objectiveEvaluations!.length, 1); assert.equal(runtime.calls.length, 0);
  await service.updateModelBudget({ expectedRevision: 1, dailyLimit: 1 }); await service.reconcileModelBudget(); await waitFor(() => runtime.calls.length === 1);
  const resumed = runtime.calls[0]; assert.equal(resumed.input.run.id, evaluation.runId);
  assert.equal(resumed.input.objectiveEvaluation!.inputHash, evaluation.inputHash);
  resumed.finish(output('Missing external input', { objectiveAssessment: assess(resumed, 'blocked') })); await ended(service, resumed);
  await service.reconcileObjectives(); assert.equal((await service.workspace()).objectiveEvaluations!.length, 1);
  assert.equal((await service.modelBudgetStatus()).used, 1);
});

test('revoked membership at the model admission gate blocks the evaluator until membership is restored', async t => {
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; }); t.after(() => release());
  const f = await fixture(t, { beforeModelStart: async () => { entered = true; await gate; } });
  await f.create(); await f.service.reconcileObjectives(); await waitFor(() => entered);
  const original = (await f.service.workspace()).runs[0];
  await f.service.updateTeam(f.team.id, { memberIds: [] }); release();
  await waitFor(async () => Boolean((await f.service.workspace()).runs[0].objectiveBlockedReason));
  assert.equal(f.runtime.calls.length, 0); assert.equal((await f.service.workspace()).runs[0].status, 'queued');
  await waitFor(async () => (await f.service.workspace()).resources?.reserved.memoryMiB === 0);
  await f.service.updateTeam(f.team.id, { memberIds: [f.alice.id] }); await f.service.reconcileObjectives();
  await waitFor(() => f.runtime.calls.length === 1);
  const restored = f.runtime.calls[0]; assert.equal(restored.input.run.id, original.id);
  restored.finish(output('Membership changed during evaluation', { objectiveAssessment: assess(restored, 'blocked') })); await ended(f.service, restored);
  assert.equal((await f.service.workspace()).objectiveEvaluations!.find(item => item.runId === original.id)!.status, 'stale');
});

test('HTTP objective routes enforce origin, schema, versions and evaluation ownership while exposing frozen evidence', async t => {
  const runtime = new OperationalFixtureRuntime();
  const app = await createApp({ runtime, scheduler: resources() }); t.after(() => app.close());
  const agent = (await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'API objective', persona: 'No model fixture' } })).json();
  const team = (await app.inject({ method: 'POST', url: '/api/teams', payload: { name: 'API team', memberIds: [agent.id] } })).json();
  const scope = { type: 'team', id: team.id };
  await app.inject({ method: 'POST', url: '/api/collaboration/artifact_publish', payload: { scope, name: 'proof.md', content: 'Frozen API evidence' } });
  const payload = { idempotencyKey: 'http-objective', teamId: team.id, scope, title: 'API delivery', purpose: 'Verify API delivery',
    conditions: [{ id: 'verified', text: 'User accepts delivery', requiresUserConfirmation: true }] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/objectives', headers: { origin: 'https://untrusted.example' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/objectives', payload: { ...payload, allowExternalWrites: true } })).statusCode, 400);
  const created = await app.inject({ method: 'POST', url: '/api/objectives', payload }); assert.equal(created.statusCode, 201);
  const objective = created.json<Objective>();
  await waitFor(() => runtime.calls.length === 1); const call = runtime.calls[0];
  const evidenceId = call.input.objectiveEvaluation!.evidence[0].id;
  const evidenceUrl = `/api/objectives/${objective.id}/evaluations/${call.input.run.objectiveEvaluationId}/evidence/${encodeURIComponent(evidenceId)}`;
  const evidence = await app.inject({ method: 'GET', url: evidenceUrl }); assert.equal(evidence.statusCode, 200); assert.equal(evidence.json().content, 'Frozen API evidence');
  assert.equal((await app.inject({ method: 'GET', url: evidenceUrl, headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
  const other = (await app.inject({ method: 'POST', url: '/api/objectives', payload: { ...payload, idempotencyKey: 'other-objective', title: 'Other purpose' } })).json<Objective>();
  assert.equal((await app.inject({ method: 'GET', url: evidenceUrl.replace(objective.id, other.id) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/objectives/${objective.id}/confirm`, payload: { expectedVersion: 99, conditionId: 'verified', note: 'Old version' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/objectives/${objective.id}/control`, payload: { expectedVersion: 1, action: 'invented' } })).statusCode, 400);
  call.finish(output('User decision pending', { objectiveAssessment: assess(call, 'needs_user') }));
  await waitFor(async () => (await app.inject({ method: 'GET', url: '/api/workspace' })).json().runs.find((run: { id: string }) => run.id === call.input.run.id)?.status === 'succeeded');
  const confirmed = await app.inject({ method: 'POST', url: `/api/objectives/${objective.id}/confirm`, payload: { expectedVersion: 1, conditionId: 'verified', note: 'User accepted' } });
  assert.equal(confirmed.statusCode, 200); assert.equal(confirmed.json().confirmations[0].note, 'User accepted');
});

test('shared project access does not let another team claim the objective followup through the user task API', async t => {
  const f = await fixture(t); const bob = await f.service.createAgent({ name: 'Other project member', persona: 'Other team' });
  const otherTeam = await f.service.createTeam({ name: 'Other project team', memberIds: [bob.id] });
  const project = await f.service.collaboration('project_create', { name: 'Shared project', teamIds: [f.team.id, otherTeam.id] }) as Project;
  await f.create({ scope: { type: 'project', id: project.id } }); const call = await waitEvaluation(f.service, f.runtime, 1);
  call.finish(output('Followup', { objectiveAssessment: assess(call) })); await ended(f.service, call);
  const before = await f.service.workspace(), task = before.teamTasks![0];
  await assert.rejects(f.service.startTeamTask(task.id, bob.id, task.version), denied(403));
  const after = await f.service.workspace(); assert.deepEqual(after.teamTasks, before.teamTasks); assert.equal(after.runs.length, before.runs.length);
});

test('an objective task delegates to a separate project team, receives its reply and completes without transferring task ownership', async t => {
  const f = await fixture(t); const sales = await f.service.createAgent({ name: 'Separate sales agent', persona: 'Project peer fixture' });
  const skill = await f.service.addSkill(sales.id, { name: 'Review agreed requirements', description: 'Fixture skill', content: 'Compare the result with the agreed requirements.' });
  const salesTeam = await f.service.createTeam({ name: 'Sales', memberIds: [sales.id] });
  const project = await f.service.collaboration('project_create', { name: 'Production and sales', teamIds: [f.team.id, salesTeam.id] }) as Project;
  const scope = { type: 'project' as const, id: project.id }; const objective = await f.create({ scope });
  const initial = await waitEvaluation(f.service, f.runtime, 1); initial.finish(output('Followup', { objectiveAssessment: assess(initial) })); await ended(f.service, initial);
  const task = (await f.service.workspace()).teamTasks![0];
  await f.service.startTeamTask(task.id, f.alice.id, task.version); await waitFor(() => f.runtime.calls.length === 2);
  const production = f.runtime.calls[1];
  const request = await production.hooks.onTool!('message_send', { scope, recipientAgentId: sales.id, taskId: task.id,
    content: 'Verify the customer-facing description and return evidence', idempotencyKey: randomUUID() }) as PeerMessage;
  await production.hooks.onTool!('peer_wait', { messageId: request.id, reason: 'Await the project peer review' });
  production.finish(); await ended(f.service, production, 'waiting'); await waitFor(() => f.runtime.calls.length === 3);
  const peer = f.runtime.calls[2]; assert.equal(peer.input.run.agentId, sales.id); assert.equal(peer.input.run.objectiveId, objective.id);
  assert.equal(peer.input.run.budgetRootRunId, initial.input.run.id); assert.equal(peer.input.run.budgetTeamId, f.team.id);
  const claimed = (await f.service.workspace()).teamTasks![0];
  await assert.rejects(peer.hooks.onTool!('task_claim', { taskId: task.id, expectedVersion: claimed.version }), denied(403));
  await assert.rejects(peer.hooks.onTool!('task_complete', { taskId: task.id, expectedVersion: claimed.version, outcome: 'Cannot take over' }), denied(403));
  const proof = await peer.hooks.onTool!('artifact_publish', { scope, name: 'sales-review.md', content: 'Approved wording verified against agreed requirements' }) as SharedArtifact;
  await peer.hooks.onTool!('message_send', { scope, recipientAgentId: f.alice.id, replyToId: request.id, artifactIds: [proof.id],
    content: 'Review complete; the fixed evidence is attached', idempotencyKey: randomUUID() });
  peer.finish(); await ended(f.service, peer); await waitFor(() => f.runtime.calls.length === 4);
  const resumed = f.runtime.calls[3]; assert.equal(resumed.input.run.id, production.input.run.id);
  const reviewRun = await f.service.reviewSkill(skill.id, peer.input.run.id); await waitFor(() => f.runtime.calls.length === 5);
  const review = f.runtime.calls[4]; assert.equal(review.input.run.id, reviewRun.id); assert.equal(review.input.run.objectiveId, objective.id);
  assert.equal(review.input.growth!.sourceRunId, peer.input.run.id); assert.equal(review.input.run.budgetTeamId, f.team.id);
  review.finish(output('Comparison not established')); await ended(f.service, review);
  await resumed.hooks.onTool!('task_complete', { taskId: task.id, expectedVersion: claimed.version, outcome: 'Verified with the sales peer evidence', artifactIds: [proof.id] });
  resumed.finish(); await ended(f.service, resumed);
  const final = await waitEvaluation(f.service, f.runtime, 2);
  const evidence = final.input.objectiveEvaluation!.evidence.find(item => item.sourceId === proof.id)!;
  final.finish(output('Verified', { objectiveAssessment: assess(final, 'met', [evidence.id]) })); await ended(f.service, final);
  const state = await f.service.workspace(); assert.equal(state.objectives![0].status, 'completed');
  assert.equal(state.teamTasks![0].assigneeAgentId, f.alice.id); assert.equal(state.teamTasks![0].status, 'done');
  assert.ok(state.runs.every(run => run.status === 'succeeded')); assert.equal(state.teams.find(team => team.id === f.team.id)!.memberIds.includes(sales.id), false);
});

test('project access revoked at delegated admission blocks the peer and restoration resumes the same stored delivery', async t => {
  let release!: () => void, entered = false, hold = false;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; }); t.after(() => release());
  const f = await fixture(t, { beforeModelStart: async () => { if (hold) { entered = true; await gate; } } });
  const sales = await f.service.createAgent({ name: 'Revocable sales', persona: 'Revocation fixture' });
  const salesTeam = await f.service.createTeam({ name: 'Sales', memberIds: [sales.id] });
  const project = await f.service.collaboration('project_create', { name: 'Shared project', teamIds: [f.team.id, salesTeam.id] }) as Project;
  const scope = { type: 'project' as const, id: project.id }; const objective = await f.create({ scope });
  const initial = await waitEvaluation(f.service, f.runtime, 1); initial.finish(output('Followup', { objectiveAssessment: assess(initial) })); await ended(f.service, initial);
  const task = (await f.service.workspace()).teamTasks![0]; await f.service.startTeamTask(task.id, f.alice.id, task.version);
  await waitFor(() => f.runtime.calls.length === 2); const origin = f.runtime.calls[1]; hold = true;
  await origin.hooks.onTool!('message_send', { scope, recipientAgentId: sales.id, content: 'Review project evidence', idempotencyKey: randomUUID() });
  await waitFor(() => entered);
  const peerRun = (await f.service.workspace()).runs.find(run => run.agentId === sales.id)!;
  await f.service.collaboration('project_update', { projectId: project.id, expectedVersion: 1, name: project.name, description: project.description, teamIds: [f.team.id] });
  hold = false; release();
  await waitFor(async () => Boolean((await f.service.workspace()).runs.find(run => run.id === peerRun.id)?.objectiveBlockedReason));
  assert.equal(f.runtime.calls.length, 2);
  await f.service.collaboration('project_update', { projectId: project.id, expectedVersion: 2, name: project.name, description: project.description, teamIds: [f.team.id, salesTeam.id] });
  await f.service.reconcileObjectives(); await waitFor(() => f.runtime.calls.length === 3);
  const peer = f.runtime.calls[2]; assert.equal(peer.input.run.id, peerRun.id);
  await f.service.controlObjective(objective.id, { expectedVersion: 1, action: 'pause' });
  await assert.rejects(peer.hooks.onTool!('artifact_publish', { scope, name: 'after-pause.md', content: 'Denied' }), denied(403));
  const paused = (await f.service.workspace()).objectives![0];
  await f.service.controlObjective(objective.id, { expectedVersion: paused.version, action: 'cancel' });
  await waitFor(async () => (await f.service.workspace()).runs.filter(run => [peerRun.id, origin.input.run.id].includes(run.id)).every(run => run.status === 'cancelled'));
  assert.equal((await f.service.workspace()).teamTasks![0].status, 'claimed');
});
