import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService, type ServiceOptions } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { discoverableTasks } from '../server/task-discovery.ts';
import type { WorkspaceState } from '../server/store.ts';
import type { TeamTask, Project } from '../shared/collaboration.ts';
import { OperationalFixtureRuntime, resources, waitFor } from './operational-budget-fixture.ts';

const denied = (code: number) => (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === code;
async function fixture(t: TestContext, options: Partial<ServiceOptions> = {}) {
  const runtime = new OperationalFixtureRuntime();
  const service = await AgentService.create({ runtime, scheduler: resources(4), ...options });
  t.after(() => service.close());
  const alice = await service.createAgent({ name: 'Discovery Alice', persona: 'No real model fixture' });
  const bob = await service.createAgent({ name: 'Discovery Bob', persona: 'No real model fixture' });
  const team = await service.createTeam({ name: 'Opt-in team', memberIds: [alice.id, bob.id], autoDiscoverTasks: true });
  const scope = { type: 'team' as const, id: team.id };
  return { runtime, service, alice, bob, team, scope };
}
async function task(service: AgentService, scope: object, title = 'Open fixture task'): Promise<TeamTask> {
  return service.collaboration('task_create', { scope, title, idempotencyKey: randomUUID() }) as Promise<TeamTask>;
}

test('opt-in discovery notifies without assignment, records one receipt per peer/version, and atomically permits one claimant', async t => {
  const f = await fixture(t); const proposed = await task(f.service, f.scope);
  await Promise.all([f.service.reconcileTaskDiscovery(), f.service.reconcileTaskDiscovery()]);
  await waitFor(() => f.runtime.calls.length === 2);
  let state = await f.service.workspace();
  assert.equal(state.teamTasks![0].status, 'open'); assert.equal(state.teamTasks![0].assigneeAgentId, null);
  assert.equal(state.taskDiscoveries?.length, 2);
  assert.equal(new Set(state.runs.map(run => run.budgetRootRunId)).size, 1);
  assert.ok(state.runs.every(run => run.budgetTeamId === f.team.id && run.budgetProjectId === null && !run.teamTaskId));
  await f.service.updateTeam(f.team.id, { autoDiscoverTasks: false });
  assert.ok(f.runtime.calls.every(call => !call.hooks.signal.aborted), 'Opt-out does not stop already admitted work');
  const claims = await Promise.allSettled(f.runtime.calls.map(call => call.hooks.onTool!('task_claim', { taskId: proposed.id, expectedVersion: proposed.version })));
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  const loser = claims.find(result => result.status === 'rejected');
  assert.ok(loser && loser.status === 'rejected' && denied(409)(loser.reason));
  const winner = claims.findIndex(result => result.status === 'fulfilled');
  const claimed = (await f.service.workspace()).teamTasks![0];
  assert.equal(claimed.claimedRunId, f.runtime.calls[winner].input.run.id);
  await f.runtime.calls[winner].hooks.onTool!('task_complete', { taskId: proposed.id, expectedVersion: claimed.version, outcome: 'Fixture complete' });
  for (const call of f.runtime.calls) call.finish();
  await waitFor(async () => (await f.service.workspace()).runs.every(run => run.status === 'succeeded'));
  await f.service.reconcileTaskDiscovery(); state = await f.service.workspace();
  assert.equal(state.runs.length, 2); assert.equal(state.taskDiscoveries?.length, 2);
  assert.equal(state.teamTasks![0].claimedRunId, f.runtime.calls[winner].input.run.id);
});

test('worker task creation retries are idempotent and cannot reuse another root task key', async t => {
  const f = await fixture(t); await f.service.updateTeam(f.team.id, { autoDiscoverTasks: false });
  const first = await f.service.startRun(f.alice.id, 'Create child once', null, f.team.id);
  await waitFor(() => f.runtime.calls.length === 1); const call = f.runtime.calls[0];
  const args = { scope: f.scope, title: 'Idempotent child', idempotencyKey: 'stable-child' };
  const created = await call.hooks.onTool!('task_create', args) as TeamTask;
  assert.equal((await call.hooks.onTool!('task_create', args) as TeamTask).id, created.id);
  await assert.rejects(call.hooks.onTool!('task_create', { ...args, title: 'Changed body' }), denied(409));
  call.finish(); await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === first.id)?.status === 'succeeded');
  await f.service.startRun(f.alice.id, 'Another root', null, f.team.id); await waitFor(() => f.runtime.calls.length === 2);
  await assert.rejects(f.runtime.calls[1].hooks.onTool!('task_create', args), denied(409));
  assert.equal((await f.service.workspace()).teamTasks?.length, 1); f.runtime.calls[1].finish();
});

test('claim, release and complete enforce original project/team even for a peer with access to both teams', async t => {
  const f = await fixture(t); await f.service.updateTeam(f.team.id, { autoDiscoverTasks: false });
  const beta = await f.service.createTeam({ name: 'Second team', memberIds: [f.alice.id, f.bob.id] });
  const project = await f.service.collaboration('project_create', { name: 'Both teams', teamIds: [f.team.id, beta.id] }) as Project;
  const otherProject = await f.service.collaboration('project_create', { name: 'Different project', teamIds: [beta.id] }) as Project;
  const scope = { type: 'project', id: project.id };
  await f.service.startRun(f.alice.id, 'First root', project.id, f.team.id);
  await f.service.startRun(f.bob.id, 'Second root', project.id, beta.id);
  await waitFor(() => f.runtime.calls.length === 2);
  const a = f.runtime.calls.find(call => call.input.agent.id === f.alice.id)!;
  const b = f.runtime.calls.find(call => call.input.agent.id === f.bob.id)!;
  const created = await b.hooks.onTool!('task_create', { scope, title: 'Beta child' }) as TeamTask;
  for (const operation of ['task_claim', 'task_release', 'task_complete']) {
    await assert.rejects(a.hooks.onTool!(operation, { taskId: created.id, expectedVersion: 1, ...(operation === 'task_complete' ? { outcome: 'Wrong root' } : {}) }), denied(403));
  }
  const other = await f.service.collaboration('task_create', { scope: { type: 'project', id: otherProject.id }, budgetTeamId: beta.id, title: 'Other project' }) as TeamTask;
  await assert.rejects(b.hooks.onTool!('task_claim', { taskId: other.id, expectedVersion: 1 }), denied(403));
  const claimed = await b.hooks.onTool!('task_claim', { taskId: created.id, expectedVersion: 1 }) as TeamTask;
  assert.equal(claimed.claimedRunId, b.input.run.id);
  assert.equal((await b.hooks.onTool!('task_release', { taskId: created.id, expectedVersion: claimed.version }) as TeamTask).claimedRunId, null);
  a.finish(); b.finish();
});

test('current membership, explicit pauses, unfinished work, cleanup and legacy unknown scopes prevent new discovery', async t => {
  const f = await fixture(t); await f.service.updateAgent(f.alice.id, { status: 'paused' });
  const proposed = await task(f.service, f.scope);
  const state = await f.service.workspace() as unknown as WorkspaceState;
  assert.deepEqual(discoverableTasks(state).map(value => value.agentId), [f.bob.id]);
  state.agents.find(agent => agent.id === f.alice.id)!.status = 'idle';
  state.teams[0].memberIds = [f.bob.id];
  assert.deepEqual(discoverableTasks(state).map(value => value.agentId), [f.bob.id]);
  state.teamTasks[0].budgetTeamId = undefined; assert.equal(discoverableTasks(state).length, 0);
  state.teamTasks[0].budgetTeamId = f.team.id;
  state.operatorPaused = true; assert.equal(discoverableTasks(state).length, 0); state.operatorPaused = false;
  state.runs.push({ id: 'cleanup-fixture', agentId: f.bob.id, status: 'failed', cleanupPending: 'still owned' } as WorkspaceState['runs'][number]);
  assert.equal(discoverableTasks(state).length, 0);
  state.runs[0].cleanupPending = null; state.runs[0].status = 'waiting'; assert.equal(discoverableTasks(state).length, 0);
  state.runs[0].status = 'succeeded'; state.teamTasks[0].budgetRootRunId = 'cleanup-fixture';
  state.runs[0].pauseRequestedAt = '2026-09-07T00:00:00.000Z'; assert.equal(discoverableTasks(state).length, 0);
  state.runs[0].pauseRequestedAt = null; state.runs[0].status = 'cancelled'; assert.equal(discoverableTasks(state).length, 0);
  assert.equal(proposed.status, 'open'); assert.equal(f.runtime.calls.length, 0);
});

test('pausing a source Run prevents child discovery; explicit resume retains the shared room for results', async t => {
  const f = await fixture(t); await f.service.updateAgent(f.bob.id, { status: 'paused' });
  const room = await f.service.createConversation({ scope: f.scope, title: 'Actual shared workroom', idempotencyKey: randomUUID() });
  await f.service.sendConversation(room.id, { mode: 'task', recipientAgentId: f.alice.id, content: 'Create cooperative tasks', idempotencyKey: randomUUID() });
  await waitFor(() => f.runtime.calls.length === 1); const source = f.runtime.calls[0];
  const created = await source.hooks.onTool!('task_create', { scope: f.scope, title: 'A child in the same room' }) as TeamTask;
  await f.service.pauseRun(source.input.run.id); source.finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === source.input.run.id)?.status === 'paused');
  await f.service.updateAgent(f.bob.id, { status: 'idle' }); await f.service.reconcileTaskDiscovery();
  assert.equal(f.runtime.calls.length, 1); assert.equal((await f.service.workspace()).taskDiscoveries?.length, 0);
  await f.service.resumeRun(source.input.run.id);
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === source.input.run.id)?.status === 'succeeded');
  await f.service.reconcileTaskDiscovery(); await waitFor(() => f.runtime.calls.length === 3);
  const peers = f.runtime.calls.slice(1);
  assert.ok(peers.every(call => call.input.run.conversationId === room.id && call.input.run.budgetRootRunId === source.input.run.id));
  for (const call of peers) call.finish();
  await waitFor(async () => (await f.service.workspace()).runs.filter(run => run.taskDiscovery?.taskId === created.id).every(run => run.status === 'succeeded'));
  const view = await f.service.getConversation(room.id);
  assert.ok(view.messages.some(message => message.sourceRunId === peers[0].input.run.id));
});

test('opt-out at the delayed model gate blocks the first start without treating a reserved count as permission', async t => {
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  t.after(() => release());
  const f = await fixture(t, { beforeModelStart: async () => { entered = true; await gate; } });
  await f.service.updateAgent(f.bob.id, { status: 'paused' });
  await task(f.service, f.scope); await f.service.reconcileTaskDiscovery(); await waitFor(() => entered);
  await f.service.updateTeam(f.team.id, { autoDiscoverTasks: false }); release();
  await waitFor(async () => (await f.service.workspace()).runs.every(run => run.status === 'failed'));
  assert.equal(f.runtime.calls.length, 0);
  assert.equal((await f.service.workspace()).resources?.running.length, 0);
});

test('a stale first discovery is not a user root cancellation and does not invalidate its already-admitted peer claimant', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-task-discovery-stale-'));
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'budget'), ownerKey: randomUUID() });
  const f = await fixture(t, { operationalBudget: budget });
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-task-discovery-stale-[^\/]+$/); await rm(directory, { recursive: true, force: true }); });
  await f.service.updateModelBudget({ expectedRevision: 0, agentDailyLimits: { [f.alice.id]: 0 } });
  const proposed = await task(f.service, f.scope); await f.service.reconcileTaskDiscovery();
  await waitFor(() => f.runtime.calls.length === 1);
  const peer = f.runtime.calls[0]; assert.equal(peer.input.agent.id, f.bob.id);
  const claimed = await peer.hooks.onTool!('task_claim', { taskId: proposed.id, expectedVersion: proposed.version }) as TeamTask;
  await f.service.reconcileTaskDiscovery();
  const root = (await f.service.workspace()).runs.find(run => run.agentId === f.alice.id)!;
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === root.id)?.status === 'failed');
  await peer.hooks.onTool!('task_complete', { taskId: proposed.id, expectedVersion: claimed.version, outcome: 'No duplicate root cancellation' });
  peer.finish(); await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === peer.input.run.id)?.status === 'succeeded');
  assert.equal((await f.service.modelBudgetStatus()).used, 1);
});
