import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';
import type { TeamTask } from '../shared/collaboration.ts';
import { OperationalFixtureRuntime, resources, waitFor } from './operational-budget-fixture.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-task-discovery-recovery-'));
  const dataDir = join(directory, 'db');
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'budget'), ownerKey: randomUUID(),
    now: () => new Date('2026-09-07T01:00:00.000Z') });
  await budget.update({ expectedRevision: 0, dailyLimit: 0 });
  let runtime = new OperationalFixtureRuntime();
  let service = await AgentService.create({ runtime, dataDir, operationalBudget: budget, scheduler: resources() });
  let closed = false;
  t.after(async () => {
    if (!closed) await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-task-discovery-recovery-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  return { budget, get runtime() { return runtime; }, get service() { return service; },
    reopen: async (mutate?: (state: WorkspaceState) => void) => {
      await service.close(); closed = true;
      if (mutate) {
        const store = await WorkspaceStore.open(dataDir);
        try { await store.change(mutate); } finally { await store.close(); }
      }
      runtime = new OperationalFixtureRuntime();
      service = await AgentService.create({ runtime, dataDir, operationalBudget: budget, scheduler: resources() });
      closed = false;
    } };
}
async function openTask(service: AgentService, name: string, autoDiscoverTasks = true) {
  const agent = await service.createAgent({ name, persona: 'Controlled task discovery fixture' });
  const team = await service.createTeam({ name: `${name} team`, memberIds: [agent.id], autoDiscoverTasks });
  const task = await service.collaboration('task_create', {
    scope: { type: 'team', id: team.id }, title: `${name} open task`, idempotencyKey: randomUUID(),
  }) as TeamTask;
  return { agent, team, task };
}
async function budgetWaiter(service: AgentService, taskId: string) {
  await service.reconcileTaskDiscovery();
  await waitFor(async () => (await service.workspace()).runs.some(run => run.taskDiscovery?.taskId === taskId && run.modelBudgetPaused));
  const state = await service.workspace();
  const run = state.runs.find(item => item.taskDiscovery?.taskId === taskId)!;
  assert.equal(state.runs.filter(item => item.taskDiscovery?.taskId === taskId).length, 1);
  return run;
}

test('a zero-budget discovery run and its delivery receipt survive restart without another discovery', async t => {
  const f = await fixture(t);
  const { agent, team, task } = await openTask(f.service, 'Persistent discovery');
  const run = await budgetWaiter(f.service, task.id);
  const before = await f.service.workspace();
  const receipts = before.taskDiscoveries?.filter(item => item.taskId === task.id);
  assert.equal(receipts?.length, 1);
  assert.equal(receipts![0].runId, run.id);
  assert.equal(receipts![0].agentId, agent.id);
  assert.equal(receipts![0].teamId, team.id);
  assert.equal(receipts![0].taskVersion, task.version);
  assert.ok(Number.isFinite(Date.parse(receipts![0].createdAt)));
  assert.deepEqual({ teamId: run.taskDiscovery?.teamId, taskId: run.taskDiscovery?.taskId, taskVersion: run.taskDiscovery?.taskVersion },
    { teamId: team.id, taskId: task.id, taskVersion: task.version });
  assert.equal(run.taskDiscovery?.admittedAt, undefined, 'Budget denial must not record an actual model admission');
  assert.equal(before.teamTasks?.find(item => item.id === task.id)?.status, 'open', 'Discovery itself is not a claim');
  assert.equal(f.runtime.calls.length, 0);
  await f.reopen();
  await f.service.reconcileTaskDiscovery();
  await f.service.reconcileModelBudget();
  await f.service.reconcileTaskDiscovery();
  const restored = await f.service.workspace();
  assert.deepEqual(restored.taskDiscoveries?.filter(item => item.taskId === task.id), receipts);
  assert.deepEqual(restored.runs.filter(item => item.taskDiscovery?.taskId === task.id).map(item => item.id), [run.id]);
  assert.equal(restored.runs.find(item => item.id === run.id)?.modelBudgetPaused, true);
  assert.equal(f.runtime.calls.length, 0);
  assert.equal((await f.service.modelBudgetStatus()).used, 0);
});

test('raising the budget resumes the existing discovery once and a declined task version is not redelivered', async t => {
  const f = await fixture(t);
  const { task } = await openTask(f.service, 'Budget resume');
  const run = await budgetWaiter(f.service, task.id);
  await f.reopen();
  const policy = await f.service.modelBudgetStatus();
  await f.service.updateModelBudget({ expectedRevision: policy.revision, dailyLimit: 1 });
  await f.service.reconcileModelBudget();
  await waitFor(() => f.runtime.calls.length === 1);
  assert.equal(f.runtime.calls[0].input.run.id, run.id);
  assert.deepEqual(f.runtime.calls[0].input.run.taskDiscovery, run.taskDiscovery);
  f.runtime.calls[0].finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
  await f.service.reconcileTaskDiscovery();
  await f.reopen();
  await f.service.reconcileTaskDiscovery();
  const state = await f.service.workspace();
  assert.equal(state.runs.filter(item => item.taskDiscovery?.taskId === task.id).length, 1);
  assert.equal(state.taskDiscoveries?.filter(item => item.taskId === task.id).length, 1);
  assert.equal(state.teamTasks?.find(item => item.id === task.id)?.status, 'open');
  assert.equal(f.runtime.calls.length, 0);
  assert.equal((await f.service.modelBudgetStatus()).used, 1);
});

test('explicit pause and cancellation remain authoritative after restart and a discovery budget increase', async t => {
  const f = await fixture(t);
  const pausedTask = await openTask(f.service, 'Paused discovery');
  const cancelledTask = await openTask(f.service, 'Cancelled discovery');
  const pausedRun = await budgetWaiter(f.service, pausedTask.task.id);
  const cancelledRun = await budgetWaiter(f.service, cancelledTask.task.id);
  await f.service.pauseRun(pausedRun.id);
  await f.service.cancelRun(cancelledRun.id);
  await f.reopen();
  const policy = await f.service.modelBudgetStatus();
  await f.service.updateModelBudget({ expectedRevision: policy.revision, dailyLimit: 5 });
  await f.service.reconcileModelBudget();
  await f.service.reconcileTaskDiscovery();
  const state = await f.service.workspace();
  assert.equal(state.runs.find(item => item.id === pausedRun.id)?.status, 'paused');
  assert.equal(state.runs.find(item => item.id === cancelledRun.id)?.status, 'cancelled');
  assert.equal(state.runs.length, 2);
  assert.equal(state.taskDiscoveries?.length, 2);
  assert.equal(f.runtime.calls.length, 0);
  assert.equal((await f.service.modelBudgetStatus()).used, 0);
});

test('persisted global pause blocks both new discovery and budget resumption until the user resumes storage', async t => {
  const f = await fixture(t);
  const waiting = await openTask(f.service, 'Already discovered');
  const run = await budgetWaiter(f.service, waiting.task.id);
  const undiscovered = await openTask(f.service, 'Still undiscovered', false);
  await f.reopen(state => {
    state.operatorPaused = true;
    state.teams.find(item => item.id === undiscovered.team.id)!.autoDiscoverTasks = true;
  });
  const policy = await f.service.modelBudgetStatus();
  await f.budget.update({ expectedRevision: policy.revision, dailyLimit: 2 });
  await f.service.reconcileModelBudget();
  await f.service.reconcileTaskDiscovery();
  assert.equal((await f.service.storageStatus()).paused, true);
  const state = await f.service.workspace();
  assert.deepEqual(state.runs.map(item => item.id), [run.id]);
  assert.equal(state.runs[0].modelBudgetPaused, true);
  assert.equal(state.taskDiscoveries?.length, 1);
  assert.equal(f.runtime.calls.length, 0);
  await f.reopen();
  await f.service.reconcileTaskDiscovery();
  await f.service.reconcileModelBudget();
  assert.equal((await f.service.storageStatus()).paused, true);
  assert.equal((await f.service.workspace()).runs.length, 1);
  assert.equal(f.runtime.calls.length, 0);
  await f.service.resumeStorage();
  await f.service.reconcileModelBudget();
  await f.service.reconcileTaskDiscovery();
  await waitFor(() => f.runtime.calls.length === 2);
  assert.ok(f.runtime.calls.some(call => call.input.run.id === run.id));
  assert.ok(f.runtime.calls.some(call => call.input.run.taskDiscovery?.taskId === undiscovered.task.id));
  for (const call of f.runtime.calls) call.finish();
  await waitFor(async () => (await f.service.workspace()).runs.every(item => item.status === 'succeeded'));
  assert.equal((await f.service.modelBudgetStatus()).used, 2);
});
