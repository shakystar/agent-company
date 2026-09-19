import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { WorkspaceStore } from '../server/store.ts';
import type { PeerMessage, Project, TeamTask } from '../shared/collaboration.ts';
import { OperationalFixtureRuntime, resources, waitFor } from './operational-budget-fixture.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-team-budget-'));
  let clock = new Date('2026-09-06T14:59:59.000Z');
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'ledger'), ownerKey: randomUUID(), now: () => clock });
  const runtime = new OperationalFixtureRuntime();
  const service = await AgentService.create({ runtime, scheduler: resources(4), operationalBudget: budget });
  t.after(async () => {
    await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-team-budget-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  const alice = await service.createAgent({ name: 'Alice', persona: 'Origin fixture' });
  const bob = await service.createAgent({ name: 'Bob', persona: 'Collaborator fixture' });
  const alpha = await service.createTeam({ name: 'Alpha', memberIds: [alice.id] });
  const beta = await service.createTeam({ name: 'Beta', memberIds: [bob.id] });
  const project = await service.collaboration('project_create', { name: 'Shared project', teamIds: [alpha.id, beta.id] }) as Project;
  const update = async (values: object) => service.updateModelBudget({ expectedRevision: (await service.modelBudgetStatus()).revision, ...values });
  return { budget, runtime, service, alice, bob, alpha, beta, project, update, setDate: (value: string) => { clock = new Date(value); } };
}
const forbidden = (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 403;

test('cross-team delegation charges one original team and each actual executing agent, waking only its available quota', async t => {
  const f = await fixture(t);
  const repository = await f.service.createConnection({ repository: 'fixture/production', access: 'read' });
  await f.service.updateAgent(f.bob.id, { repositoryIds: [repository.id] });
  await f.update({ teamDailyLimits: { [f.alpha.id]: 1, [f.beta.id]: 0 } });
  const run = await f.service.startRun(f.alice.id, 'Alpha root task', f.project.id, f.alpha.id);
  await waitFor(() => f.runtime.calls.length === 1);
  const origin = f.runtime.calls[0];
  const scope = { type: 'project', id: f.project.id };
  await assert.rejects(origin.hooks.onTool!('message_send', { scope, recipientAgentId: f.bob.id,
    content: 'Cannot alter billing', budgetTeamId: f.beta.id, idempotencyKey: randomUUID() }), forbidden);
  const message = await origin.hooks.onTool!('message_send', { scope, recipientAgentId: f.bob.id,
    content: 'Continue Alpha work on another team', idempotencyKey: randomUUID() }) as PeerMessage;
  assert.equal(message.budgetTeamId, f.alpha.id);
  await waitFor(async () => (await f.service.modelBudgetStatus()).waiting.some(item => item.agentId === f.bob.id));
  let status = await f.service.modelBudgetStatus();
  assert.equal(status.waiting[0].blockedBy, 'team'); assert.equal(status.waiting[0].teamId, f.alpha.id);
  assert.equal(f.runtime.calls.length, 1); assert.equal((await f.service.workspace()).resources?.running.length, 1);
  await f.update({ teamDailyLimits: { [f.alpha.id]: 2 } });
  await waitFor(() => f.runtime.calls.length === 2);
  const peer = f.runtime.calls[1];
  assert.equal(peer.input.run.budgetTeamId, f.alpha.id); assert.equal(peer.input.run.budgetRootRunId, run.id);
  assert.equal(peer.input.run.agentId, f.bob.id);
  assert.deepEqual(peer.input.agent.repositoryIds, []);
  assert.deepEqual(peer.input.connections, []);
  const task = await peer.hooks.onTool!('task_create', { scope, title: 'Original-team follow-up' }) as TeamTask;
  assert.equal(task.budgetTeamId, f.alpha.id); assert.equal(task.budgetRootRunId, run.id);
  status = await f.service.modelBudgetStatus();
  assert.equal(status.used, 2);
  assert.ok(status.teams && status.agents);
  assert.equal(status.teams.find(item => item.teamId === f.alpha.id)!.used, 2);
  assert.equal(status.teams.find(item => item.teamId === f.beta.id)!.used, 0);
  assert.equal(status.agents.find(item => item.agentId === f.alice.id)!.used, 1);
  assert.equal(status.agents.find(item => item.agentId === f.bob.id)!.used, 1);
  origin.finish(); peer.finish();
});

test('an agent-specific cap does not stop another peer, and increasing it resumes the original run', async t => {
  const f = await fixture(t);
  await f.update({ agentDailyLimits: { [f.alice.id]: 0 } });
  const waiting = await f.service.startRun(f.alice.id, 'Wait for own cap', f.project.id, f.alpha.id);
  await waitFor(async () => (await f.service.modelBudgetStatus()).waiting.length === 1);
  await f.service.startRun(f.bob.id, 'Independent executor', f.project.id, f.beta.id);
  await waitFor(() => f.runtime.calls.length === 1);
  assert.equal(f.runtime.calls[0].input.agent.id, f.bob.id);
  assert.equal((await f.service.modelBudgetStatus()).waiting[0].blockedBy, 'agent');
  await f.update({ agentDailyLimits: { [f.alice.id]: 1 } });
  await waitFor(() => f.runtime.calls.length === 2);
  assert.equal(f.runtime.calls[1].input.run.id, waiting.id);
  for (const call of f.runtime.calls) call.finish();
});

test('same-project requests from different original teams cannot mix into one peer run or reply thread', async t => {
  const f = await fixture(t);
  const helper = await f.service.createAgent({ name: 'Shared helper', persona: 'Fixture' });
  await f.service.updateTeam(f.alpha.id, { memberIds: [f.alice.id, helper.id] });
  const scope = { type: 'project', id: f.project.id };
  await f.service.startRun(f.alice.id, 'Alpha source', f.project.id, f.alpha.id);
  await f.service.startRun(f.bob.id, 'Beta source', f.project.id, f.beta.id);
  await waitFor(() => f.runtime.calls.length === 2);
  const a = f.runtime.calls.find(call => call.input.agent.id === f.alice.id)!;
  const b = f.runtime.calls.find(call => call.input.agent.id === f.bob.id)!;
  const first = await a.hooks.onTool!('message_send', { scope, recipientAgentId: helper.id, content: 'Alpha help', idempotencyKey: randomUUID() }) as PeerMessage;
  await waitFor(() => f.runtime.calls.length === 3); const peer = f.runtime.calls[2];
  const second = await b.hooks.onTool!('message_send', { scope, recipientAgentId: helper.id, content: 'Beta help', idempotencyKey: randomUUID() }) as PeerMessage;
  for (const reference of [{ replyToId: second.id }, { threadId: second.threadId }]) {
    await assert.rejects(peer.hooks.onTool!('message_send', { scope, recipientAgentId: f.bob.id, content: 'Wrong root team', idempotencyKey: randomUUID(), ...reference }), forbidden);
  }
  assert.deepEqual(peer.input.run.messageIds, [first.id]);
  peer.finish();
  await waitFor(() => f.runtime.calls.length === 4);
  assert.notEqual(f.runtime.calls[3].input.run.id, peer.input.run.id);
  assert.equal(f.runtime.calls[3].input.run.budgetTeamId, f.beta.id);
  a.finish(); b.finish(); f.runtime.calls[3].finish();
});

test('team quota midnight wakes only budget waiters while user pause and cancellation remain unchanged', async t => {
  const f = await fixture(t);
  const third = await f.service.createAgent({ name: 'Cancelled teammate', persona: 'Fixture' });
  await f.service.updateTeam(f.alpha.id, { memberIds: [f.alice.id, f.bob.id, third.id] });
  await f.update({ teamDailyLimits: { [f.alpha.id]: 1 } });
  await f.budget.reserve({ runId: 'prior-start', phase: 'task', kind: 'fixture', reason: 'Earlier team usage' },
    { projectId: f.project.id, teamId: f.alpha.id, agentId: f.alice.id, rootRunId: 'prior-start' });
  const runs = await Promise.all([f.alice, f.bob, third].map(agent => f.service.startRun(agent.id, 'Tomorrow', f.project.id, f.alpha.id)));
  await waitFor(async () => (await f.service.modelBudgetStatus()).waiting.length === 3);
  await f.service.pauseRun(runs[1].id); await f.service.cancelRun(runs[2].id);
  f.setDate('2026-09-06T15:00:00.000Z');
  await f.service.reconcileModelBudget();
  await waitFor(() => f.runtime.calls.length === 1);
  assert.equal(f.runtime.calls[0].input.run.id, runs[0].id);
  const state = await f.service.workspace();
  assert.equal(state.runs.find(run => run.id === runs[1].id)?.status, 'paused');
  assert.equal(state.runs.find(run => run.id === runs[2].id)?.status, 'cancelled');
  assert.equal(state.agents.find(agent => agent.id === third.id)?.status, 'idle');
  assert.equal((await f.service.modelBudgetStatus()).used, 1);
  f.runtime.calls[0].finish();
});

test('service startup backfills supported original-team history without resetting user caps or guessing orphan records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-team-backfill-'));
  const runtime = new OperationalFixtureRuntime();
  const dataDir = join(directory, 'db');
  let service = await AgentService.create({ runtime, scheduler: resources(), dataDir });
  t.after(async () => { await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-team-backfill-[^\\/]+$/); await rm(directory, { recursive: true, force: true }); });
  const agent = await service.createAgent({ name: 'Recorded executor', persona: 'Fixture' });
  const team = await service.createTeam({ name: 'Original team', memberIds: [agent.id] });
  const task = await service.collaboration('task_create', { scope: { type: 'team', id: team.id }, title: 'Old task' }) as TeamTask;
  const run = await service.startTeamTask(task.id, agent.id, task.version);
  await waitFor(() => runtime.calls.length === 1); runtime.calls[0].finish();
  await waitFor(async () => (await service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
  await service.close();
  const store = await WorkspaceStore.open(dataDir);
  await store.change(state => {
    delete state.runs.find(item => item.id === run.id)!.budgetTeamId;
    delete state.teamTasks.find(item => item.id === task.id)!.budgetTeamId;
    state.teams.find(item => item.id === team.id)!.memberIds = [];
  });
  await store.close();
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'ledger'), ownerKey: randomUUID() });
  await budget.update({ expectedRevision: 0, dailyLimit: 500 });
  for (const id of [run.id, 'missing-original-run']) await budget.reserve({ runId: id, phase: 'task', kind: 'task', reason: 'Legacy record' },
    { projectId: null, rootRunId: id });
  const restarted = new OperationalFixtureRuntime();
  service = await AgentService.create({ runtime: restarted, dataDir, scheduler: resources(), operationalBudget: budget });
  const status = await service.modelBudgetStatus();
  assert.equal(status.dailyLimit, 500); assert.equal(status.revision, 1); assert.equal(status.used, 2);
  assert.deepEqual(status.legacyUnattributed, { team: 1, agent: 1 });
  assert.equal(status.teams?.find(item => item.teamId === team.id)?.used, 2);
  assert.equal(status.agents?.find(item => item.agentId === agent.id)?.used, 2);
  assert.equal(restarted.calls.length, 0);
});
