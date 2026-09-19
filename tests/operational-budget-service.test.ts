import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { FileModelBudget } from '../server/model-budget.ts';
import type { Project, PeerMessage, SharedArtifact } from '../shared/collaboration.ts';
import type { Skill } from '../shared/types.ts';
import { growthTaskPrompt, type GrowthReplayProposal } from '../shared/growth.ts';
import { resolveGrowthReplay } from '../server/growth-replay.ts';
import type { ServiceOptions } from '../server/service.ts';
import { OperationalFixtureRuntime, output, resources, waitFor } from './operational-budget-fixture.ts';
import { pairedEvidence } from './growth-fixture.ts';

async function fixture(t: TestContext, options: { dailyLimit?: number; beforeModelStart?: ServiceOptions['beforeModelStart'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-operational-budget-'));
  const ownerKey = randomUUID(); let clock = new Date('2026-09-06T14:59:59.000Z');
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'installation-budget'), ownerKey, now: () => clock });
  if (options.dailyLimit !== undefined) await budget.update({ expectedRevision: 0, dailyLimit: options.dailyLimit });
  let runtime = new OperationalFixtureRuntime();
  const dataDir = join(directory, 'workspace-db');
  let service = await AgentService.create({ runtime, dataDir, scheduler: resources(4), operationalBudget: budget,
    beforeModelStart: options.beforeModelStart, recovery: { retryDelayMs: 0 } });
  let closed = false;
  t.after(async () => {
    if (!closed) await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-operational-budget-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, budget, get service() { return service; }, get runtime() { return runtime; },
    setDate: (date: string) => { clock = new Date(date); },
    reopen: async () => {
      await service.close(); closed = true; runtime = new OperationalFixtureRuntime();
      service = await AgentService.create({ runtime, dataDir, scheduler: resources(4), operationalBudget: budget,
        beforeModelStart: options.beforeModelStart, recovery: { retryDelayMs: 0 } }); closed = false;
    } };
}
const agent = (service: AgentService, name: string) => service.createAgent({ name, persona: 'Same actual budget test agent' });
async function project(service: AgentService, agentIds: string[], name = 'Project') {
  const team = await service.createTeam({ name: `${name} team`, memberIds: agentIds });
  const project = await service.collaboration('project_create', { name, teamIds: [team.id] }) as Project;
  return { team, project };
}
async function projectTask(service: AgentService, projectId: string, agentId: string) {
  const conversation = await service.createConversation({ scope: { type: 'project', id: projectId },
    idempotencyKey: randomUUID(), title: 'Project work' });
  const message = await service.sendConversation(conversation.id, { content: 'Perform the project task', mode: 'task',
    recipientAgentId: agentId, idempotencyKey: randomUUID() });
  return { conversation, message };
}

test('an exhausted operating gate lets an admitted call finish and queues the next call without CPU or memory', async t => {
  const f = await fixture(t, { dailyLimit: 1 });
  const alice = await agent(f.service, 'A'), bob = await agent(f.service, 'B');
  const first = await f.service.startRun(alice.id, 'Admitted operation');
  await waitFor(() => f.runtime.calls.length === 1);
  const second = await f.service.startRun(bob.id, 'Wait for the next allowance');
  await waitFor(async () => Boolean((await f.service.workspace()).runs.find(run => run.id === second.id)?.modelBudgetBlock));
  assert.equal(f.runtime.calls[0].hooks.signal.aborted, false);
  let state = await f.service.workspace();
  assert.equal(state.runs.find(run => run.id === second.id)!.status, 'queued');
  assert.equal(state.runs.find(run => run.id === second.id)!.modelBudgetBlock?.blockedBy, 'global');
  assert.equal(state.resources?.running.length, 1);
  f.runtime.calls[0].finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === first.id)?.status === 'succeeded');
  assert.equal((await f.service.workspace()).resources?.reserved.memoryMiB, 0);
  const current = await f.service.modelBudgetStatus();
  await f.service.updateModelBudget({ expectedRevision: current.revision, dailyLimit: 2 });
  await f.service.reconcileModelBudget();
  await waitFor(() => f.runtime.calls.length === 2);
  assert.equal(f.runtime.calls[1].input.run.id, second.id);
  f.runtime.calls[1].finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === second.id)?.status === 'succeeded');
  assert.equal((await f.service.modelBudgetStatus()).used, 2);
});

test('only the exhausted project waits while another project and personal work use the same global balance', async t => {
  const f = await fixture(t, { dailyLimit: 3 });
  const alice = await agent(f.service, 'A'), bob = await agent(f.service, 'B'), personal = await agent(f.service, 'Personal');
  const alpha = await project(f.service, [alice.id], 'Alpha'), beta = await project(f.service, [bob.id], 'Beta');
  await f.service.updateModelBudget({ expectedRevision: 1, projectDailyLimits: { [alpha.project.id]: 0 } });
  await projectTask(f.service, alpha.project.id, alice.id);
  await waitFor(async () => (await f.service.modelBudgetStatus()).waiting.length === 1);
  await projectTask(f.service, beta.project.id, bob.id);
  await f.service.startRun(personal.id, 'Personal common-budget task');
  await waitFor(() => f.runtime.calls.length === 2);
  const status = await f.service.modelBudgetStatus();
  assert.equal(status.used, 2); assert.equal(status.remaining, 1);
  assert.equal(status.waiting[0].blockedBy, 'project'); assert.equal(status.waiting[0].projectId, alpha.project.id);
  assert.equal(status.projects.find(item => item.projectId === beta.project.id)!.used, 1);
  assert.equal(status.projects.find(item => item.projectId === alpha.project.id)!.used, 0);
  assert.ok(f.runtime.calls.some(call => call.input.run.budgetProjectId === beta.project.id));
  assert.ok(f.runtime.calls.some(call => call.input.run.agentId === personal.id && call.input.run.budgetProjectId === null));
  for (const call of f.runtime.calls) call.finish();
});

test('KST rollover resumes eligible budget waiters but preserves explicit pause and cancellation across restart', async t => {
  const f = await fixture(t, { dailyLimit: 1 });
  await f.budget.reserve({ runId: 'already-counted', phase: 'task', kind: 'test', reason: 'Earlier operation' }, { projectId: null, rootRunId: 'already-counted' });
  const agents = await Promise.all(['Resume', 'Pause', 'Cancel'].map(name => agent(f.service, name)));
  const runs = await Promise.all(agents.map(item => f.service.startRun(item.id, 'Wait until tomorrow')));
  await waitFor(async () => (await f.service.modelBudgetStatus()).waiting.length === 3);
  await f.service.pauseRun(runs[1].id); await f.service.cancelRun(runs[2].id);
  await f.reopen();
  assert.equal(f.runtime.calls.length, 0);
  f.setDate('2026-09-06T15:00:00.000Z');
  await f.service.reconcileModelBudget();
  await waitFor(() => f.runtime.calls.length === 1);
  assert.equal(f.runtime.calls[0].input.run.id, runs[0].id);
  const state = await f.service.workspace();
  assert.equal(state.runs.find(run => run.id === runs[1].id)!.status, 'paused');
  assert.equal(state.runs.find(run => run.id === runs[2].id)!.status, 'cancelled');
  assert.equal((await f.service.modelBudgetStatus()).used, 1);
  f.runtime.calls[0].finish();
});

test('operating midnight and policy changes never clear an independent exhausted ten-start development gate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-operational-budget-campaign-'));
  const campaign = new FileModelBudget(directory, 10);
  for (let i = 0; i < 10; i++) await campaign.reserve({ runId: `prior-${i}`, phase: 'task', kind: 'fixture', reason: 'Pre-existing development start' });
  const f = await fixture(t, { beforeModelStart: request => campaign.reserve(request) });
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const alice = await agent(f.service, 'Independent gates');
  const run = await f.service.startRun(alice.id, 'No development allowance remains');
  await waitFor(async () => Boolean((await f.service.workspace()).runs.find(item => item.id === run.id)?.modelBudgetPaused));
  assert.equal((await f.service.workspace()).runs.find(item => item.id === run.id)?.modelBudgetBlock ?? null, null);
  assert.equal(f.runtime.calls.length, 0); assert.equal((await f.service.modelBudgetStatus()).used, 0);
  f.setDate('2026-09-06T15:00:00.000Z');
  await f.service.updateModelBudget({ expectedRevision: 0, dailyLimit: 200 });
  await f.service.reconcileModelBudget(); await f.reopen(); await f.service.reconcileModelBudget();
  assert.equal(f.runtime.calls.length, 0);
  assert.equal((await f.service.workspace()).runs.find(item => item.id === run.id)?.modelBudgetPaused, true);
  assert.equal((await campaign.read()).starts.length, 10); assert.equal((await f.service.modelBudgetStatus()).used, 0);
});

test('peer delegation and worker retries retain the originating project even in a team shared by two projects', async t => {
  const f = await fixture(t);
  const alice = await agent(f.service, 'Origin'), bob = await agent(f.service, 'Peer');
  const team = await f.service.createTeam({ name: 'Shared across projects', memberIds: [alice.id, bob.id] });
  const alpha = await f.service.collaboration('project_create', { name: 'Alpha', teamIds: [team.id] }) as Project;
  const beta = await f.service.collaboration('project_create', { name: 'Beta', teamIds: [team.id] }) as Project;
  await projectTask(f.service, alpha.id, alice.id);
  await waitFor(() => f.runtime.calls.length === 1); const first = f.runtime.calls[0];
  await first.hooks.onTool!('message_send', { scope: { type: 'team', id: team.id }, recipientAgentId: bob.id,
    content: 'Help the originating Alpha task', idempotencyKey: randomUUID() }) as PeerMessage;
  await waitFor(() => f.runtime.calls.length === 2); const peer = f.runtime.calls.find(call => call.input.agent.id === bob.id)!;
  assert.equal(peer.input.run.budgetProjectId, alpha.id); assert.equal(peer.input.run.budgetRootRunId, first.input.run.id);
  assert.equal(peer.input.run.budgetTeamId, team.id);
  await peer.hooks.onCheckpoint!({ phase: 'task', sessionId: 'preserved-peer-session', appliedSteeringCount: 0 });
  peer.fail(new Error('Recoverable worker interruption'));
  await waitFor(() => f.runtime.calls.length === 3); const retried = f.runtime.calls[2];
  assert.equal(retried.input.run.id, peer.input.run.id); assert.equal(retried.input.run.budgetProjectId, alpha.id);
  assert.equal(retried.input.run.budgetRootRunId, first.input.run.id);
  assert.equal(retried.input.run.budgetTeamId, team.id);
  const status = await f.service.modelBudgetStatus();
  assert.equal(status.projects.find(item => item.projectId === alpha.id)!.used, 3);
  assert.equal(status.projects.find(item => item.projectId === beta.id)!.used, 0);
  first.finish(); retried.finish();
});

test('a multi-project team requires explicit attribution and never silently assigns the first project', async t => {
  const f = await fixture(t); const alice = await agent(f.service, 'Team agent');
  const team = await f.service.createTeam({ name: 'Ambiguous team', memberIds: [alice.id] });
  const first = await f.service.collaboration('project_create', { name: 'First', teamIds: [team.id] }) as Project;
  await f.service.collaboration('project_create', { name: 'Second', teamIds: [team.id] });
  const create = (extra: object) => f.service.createConversation({ scope: { type: 'team', id: team.id },
    title: 'Explicit purpose', idempotencyKey: randomUUID(), ...extra });
  await assert.rejects(create({}), error => error instanceof Error && 'statusCode' in error && error.statusCode === 400);
  assert.equal((await f.service.workspace()).conversations?.length, 0);
  const common = await create({ budgetProjectId: null });
  assert.equal(common.budgetProjectId, null);
  const selected = await create({ budgetProjectId: first.id });
  assert.equal(selected.budgetProjectId, first.id);
  await assert.rejects(create({ budgetProjectId: randomUUID() }));
  assert.equal(f.runtime.calls.length, 0);
});

test('a pause requested while admission is awaiting another gate prevents the upcoming model from starting', async t => {
  let gateEntered = false, releaseGate!: () => void;
  const held = new Promise<void>(resolveGate => { releaseGate = resolveGate; });
  const f = await fixture(t, { beforeModelStart: async () => { gateEntered = true; await held; } });
  const alice = await agent(f.service, 'Pause before admission finishes');
  const run = await f.service.startRun(alice.id, 'Pause before the next model starts');
  try {
    await waitFor(() => gateEntered);
    const paused = await f.service.pauseRun(run.id); assert.ok(paused.pauseRequestedAt);
    assert.equal(f.runtime.calls.length, 0);
  } finally { releaseGate(); }
  await waitFor(async () => f.runtime.calls.length > 0 || (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'paused');
  assert.equal(f.runtime.calls.length, 0, 'A pending gate is not an already-running model call');
  assert.equal((await f.service.workspace()).runs.find(item => item.id === run.id)!.status, 'paused');
  await f.service.resumeRun(run.id);
  await waitFor(() => f.runtime.calls.length === 1);
  assert.equal(f.runtime.calls[0].input.run.id, run.id);
  f.runtime.calls[0].finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
});

test('growth review and automatic repair retain the original project and task rather than agent membership defaults', async t => {
  const f = await fixture(t); const alice = await agent(f.service, 'Growing project agent');
  const team = await f.service.createTeam({ name: 'Two-project growth team', memberIds: [alice.id] });
  const alpha = await f.service.collaboration('project_create', { name: 'Alpha', teamIds: [team.id] }) as Project;
  const beta = await f.service.collaboration('project_create', { name: 'Beta', teamIds: [team.id] }) as Project;
  const source = await f.service.collaboration('artifact_publish', { scope: { type: 'project', id: alpha.id },
    name: 'procedure-input.json', mediaType: 'application/json', content: '{"requirement":"preserve the safe step"}' }) as SharedArtifact;
  const original = await f.service.addSkill(alice.id, { name: 'Procedure', description: '', content: 'Original procedure' });
  await projectTask(f.service, alpha.id, alice.id);
  await waitFor(() => f.runtime.calls.length === 1); const learning = f.runtime.calls[0];
  const candidate = { name: 'Procedure', description: '', content: 'Candidate procedure', passed: true, evaluation: 'Independent evidence attached' };
  const replay: GrowthReplayProposal = { applicability: 'local', prompt: 'Check the fixed procedure input while preserving the safe step',
    criteria: ['The recorded requirement remains satisfied'], artifactIds: [source.id] };
  const adapted = (call: typeof learning) => ({ ...call, resolve: call.finish, reject: call.fail });
  const comparison = async (call: typeof learning, proposed: Pick<Skill, 'name' | 'description' | 'content'>, verdict: 'improved' | 'regressed') => {
    const evidence = await pairedEvidence(adapted(call), proposed, verdict, { usefulChanges: ['Keep safe part'], failures: verdict === 'regressed' ? ['Completion regressed'] : [] });
    assert.deepEqual(call.input.growthReplay!.artifacts.map(item => item.id), [source.id]);
    const resolved = resolveGrowthReplay(call.input.growthReplay!, replay,
      call.input.growth?.originalPrompt ?? growthTaskPrompt(call.input.run.prompt, call.input.run.steering));
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    evidence.fingerprint.promptHash = hash(resolved.prompt); evidence.fingerprint.replayHash = resolved.replayHash;
    evidence.fingerprint.inputHash = hash({ prompt: resolved.prompt, persona: call.input.agent.persona,
      memories: call.input.memories.map(({ kind, title, content }) => ({ kind, title, content })),
      commonSkills: call.input.skills.filter(skill => skill.status === 'active' && skill.name !== proposed.name)
        .map(({ name, description, content }) => ({ name, description, content })), sourceRunId: null, replayHash: resolved.replayHash });
    evidence.replay = replay; evidence.replayApplicable = true; return evidence;
  };
  learning.finish(output('Learned procedure', { skills: [{ ...candidate, replay, comparison: await comparison(learning, candidate, 'improved') }] }));
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === learning.input.run.id)?.status === 'succeeded');
  const regressionTask = await f.service.startRun(alice.id, 'Original regression task in Alpha', alpha.id);
  await waitFor(() => f.runtime.calls.length === 2); const task = f.runtime.calls[1];
  task.finish(output('Suspected regression', { skillConcerns: [{ skillId: original.id, reason: 'Quality decreased', evidence: 'Compare independently', replay }] }));
  await waitFor(() => f.runtime.calls.some(call => call.input.growth?.mode === 'review'));
  const review = f.runtime.calls.find(call => call.input.growth?.mode === 'review')!;
  assert.equal(review.input.run.budgetProjectId, alpha.id); assert.equal(review.input.run.budgetRootRunId, regressionTask.id);
  assert.equal(review.input.run.budgetTeamId, team.id);
  assert.deepEqual(review.input.growth!.replay, replay);
  review.finish(output('Confirmed regression', { growthReview: await comparison(review, review.input.growth!.candidate, 'regressed') }));
  await waitFor(() => f.runtime.calls.some(call => call.input.growth?.mode === 'repair'));
  const repair = f.runtime.calls.find(call => call.input.growth?.mode === 'repair')!;
  assert.equal(repair.input.run.budgetProjectId, alpha.id); assert.equal(repair.input.run.budgetRootRunId, regressionTask.id);
  assert.equal(repair.input.run.budgetTeamId, team.id);
  assert.equal(repair.input.growth!.sourceRunId, regressionTask.id);
  assert.deepEqual(repair.input.growth!.replay, replay);
  assert.equal(repair.input.growthReplay!.sourceHash, task.input.growthReplay!.sourceHash);
  const status = await f.service.modelBudgetStatus();
  assert.equal(status.projects.find(item => item.projectId === alpha.id)!.used, 4);
  assert.equal(status.projects.find(item => item.projectId === beta.id)!.used, 0);
  await f.service.cancelRun(repair.input.run.id);
});

test('peer requests from different projects wait for separate runs instead of mixing into a busy recipient', async t => {
  const f = await fixture(t);
  const alphaAgent = await agent(f.service, 'Alpha source'), betaAgent = await agent(f.service, 'Beta source'), peerAgent = await agent(f.service, 'Shared peer');
  const team = await f.service.createTeam({ name: 'Shared peers', memberIds: [alphaAgent.id, betaAgent.id, peerAgent.id] });
  const alpha = await f.service.collaboration('project_create', { name: 'Alpha', teamIds: [team.id] }) as Project;
  const beta = await f.service.collaboration('project_create', { name: 'Beta', teamIds: [team.id] }) as Project;
  await projectTask(f.service, alpha.id, alphaAgent.id); await projectTask(f.service, beta.id, betaAgent.id);
  await waitFor(() => f.runtime.calls.length === 2);
  const alphaCall = f.runtime.calls.find(call => call.input.agent.id === alphaAgent.id)!;
  const betaCall = f.runtime.calls.find(call => call.input.agent.id === betaAgent.id)!;
  const scope = { type: 'team', id: team.id };
  const firstMessage = await alphaCall.hooks.onTool!('message_send', { scope, recipientAgentId: peerAgent.id,
    content: 'Alpha request', idempotencyKey: randomUUID() }) as PeerMessage;
  await waitFor(() => f.runtime.calls.length === 3); const firstPeer = f.runtime.calls[2];
  const secondMessage = await betaCall.hooks.onTool!('message_send', { scope, recipientAgentId: peerAgent.id,
    content: 'Beta request', idempotencyKey: randomUUID() }) as PeerMessage;
  assert.equal(firstPeer.input.run.budgetProjectId, alpha.id);
  assert.deepEqual((await f.service.workspace()).runs.find(run => run.id === firstPeer.input.run.id)!.messageIds, [firstMessage.id]);
  await assert.rejects(firstPeer.hooks.onTool!('message_send', { scope, recipientAgentId: betaAgent.id,
    replyToId: secondMessage.id, content: 'Do not answer Beta inside Alpha billing', idempotencyKey: randomUUID() }),
  error => error instanceof Error && 'statusCode' in error && error.statusCode === 403);
  await assert.rejects(firstPeer.hooks.onTool!('message_send', { scope, recipientAgentId: betaAgent.id,
    threadId: secondMessage.threadId, content: 'Do not bypass attribution through threadId', idempotencyKey: randomUUID() }),
  error => error instanceof Error && 'statusCode' in error && error.statusCode === 403);
  assert.equal((await f.service.workspace()).messages?.length, 2);
  firstPeer.finish(output('Alpha completed'));
  await waitFor(() => f.runtime.calls.length === 4); const secondPeer = f.runtime.calls[3];
  assert.notEqual(secondPeer.input.run.id, firstPeer.input.run.id);
  assert.equal(secondPeer.input.run.budgetProjectId, beta.id); assert.equal(secondPeer.input.run.budgetRootRunId, betaCall.input.run.id);
  assert.deepEqual(secondPeer.input.run.messageIds, [secondMessage.id]);
  const status = await f.service.modelBudgetStatus();
  assert.equal(status.projects.find(item => item.projectId === alpha.id)!.used, 2);
  assert.equal(status.projects.find(item => item.projectId === beta.id)!.used, 2);
  alphaCall.finish(); betaCall.finish(); secondPeer.finish();
});
