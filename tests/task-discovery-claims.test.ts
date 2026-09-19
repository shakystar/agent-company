import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import type { Project, TeamTask } from '../shared/collaboration.ts';
import { OperationalFixtureRuntime, resources, waitFor } from './operational-budget-fixture.ts';

class ClaimFixtureRuntime extends OperationalFixtureRuntime {
  heldCleanup = new Set<string>();
  override async settle(runId?: string) {
    if (runId && this.heldCleanup.has(runId)) throw new Error('Fixture cleanup is still pending');
  }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-task-discovery-claims-'));
  const runtime = new ClaimFixtureRuntime();
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'budget'), ownerKey: randomUUID() });
  const service = await AgentService.create({ runtime, dataDir: join(directory, 'db'), operationalBudget: budget,
    scheduler: resources(), recovery: { maxAttempts: 1, retryDelayMs: 0 } });
  t.after(async () => {
    runtime.heldCleanup.clear();
    await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-task-discovery-claims-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  const author = await service.createAgent({ name: 'Task author', persona: 'Fixture only' });
  const claimant = await service.createAgent({ name: 'Volunteering peer', persona: 'Fixture only' });
  const team = await service.createTeam({ name: 'Shared work', memberIds: [author.id, claimant.id] });
  const project = await service.collaboration('project_create', { name: 'Original project', teamIds: [team.id] }) as Project;
  return { service, runtime, author, claimant, team, project,
    start: async (agentId: string, projectId = project.id, teamId = team.id) => {
      const run = await service.startRun(agentId, 'Controlled claim lifecycle', projectId, teamId);
      await waitFor(() => runtime.calls.some(call => call.input.run.id === run.id));
      return { run, call: runtime.calls.find(call => call.input.run.id === run.id)! };
    } };
}
const rejectedWith = (status: number) => (error: unknown) => error instanceof Error
  && 'statusCode' in error && error.statusCode === status;

test('peers may claim across independent roots in the same project and team without erasing either root or reviving stops', async t => {
  const f = await fixture(t);
  const author = await f.start(f.author.id);
  const claimant = await f.start(f.claimant.id);
  const create = (title: string) => author.call.hooks.onTool!('task_create', {
    scope: { type: 'team', id: f.team.id }, title, idempotencyKey: randomUUID(),
  }) as Promise<TeamTask>;
  const task = await create('Independent roots can cooperate');
  const stoppedTask = await create('A stopped source must remain stopped');
  assert.equal(task.budgetRootRunId, author.run.id);
  assert.equal(claimant.call.input.run.budgetRootRunId, claimant.run.id);
  assert.notEqual(author.run.id, claimant.run.id);
  const claimed = await claimant.call.hooks.onTool!('task_claim', { taskId: task.id, expectedVersion: task.version }) as TeamTask;
  assert.equal(claimed.claimedRunId, claimant.run.id);
  assert.equal(claimed.budgetRootRunId, author.run.id);
  assert.deepEqual(claimed.claimRunIds, [claimant.run.id]);
  const state = await f.service.workspace();
  assert.equal(state.runs.find(run => run.id === author.run.id)?.budgetRootRunId, author.run.id);
  assert.equal(state.runs.find(run => run.id === claimant.run.id)?.budgetRootRunId, claimant.run.id);
  assert.equal(claimed.budgetProjectId, f.project.id);
  assert.equal(claimed.budgetTeamId, f.team.id);

  const outsider = await f.service.createAgent({ name: 'Different attribution', persona: 'Fixture only' });
  await f.service.updateTeam(f.team.id, { memberIds: [f.author.id, f.claimant.id, outsider.id] });
  const otherProject = await f.service.collaboration('project_create', { name: 'Other project', teamIds: [f.team.id] }) as Project;
  const wrongProject = await f.start(outsider.id, otherProject.id);
  await assert.rejects(wrongProject.call.hooks.onTool!('task_claim', {
    taskId: stoppedTask.id, expectedVersion: stoppedTask.version,
  }), rejectedWith(403));
  wrongProject.call.finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === wrongProject.run.id)?.status === 'succeeded');
  const otherTeam = await f.service.createTeam({ name: 'Other original team', memberIds: [outsider.id] });
  await f.service.collaboration('project_update', { projectId: f.project.id, expectedVersion: f.project.version,
    name: f.project.name, description: f.project.description, teamIds: [f.team.id, otherTeam.id] });
  const wrongTeam = await f.start(outsider.id, f.project.id, otherTeam.id);
  await assert.rejects(wrongTeam.call.hooks.onTool!('task_claim', {
    taskId: stoppedTask.id, expectedVersion: stoppedTask.version,
  }), rejectedWith(403));
  wrongTeam.call.finish();

  await f.service.pauseRun(author.run.id);
  const claimStopped = () => claimant.call.hooks.onTool!('task_claim', {
    taskId: stoppedTask.id, expectedVersion: stoppedTask.version,
  });
  await assert.rejects(claimStopped(), rejectedWith(403));
  author.call.finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === author.run.id)?.status === 'paused');
  await assert.rejects(claimStopped(), rejectedWith(403));
  await f.service.cancelRun(author.run.id);
  await assert.rejects(claimStopped(), rejectedWith(403));

  const userTask = await f.service.collaboration('task_create', {
    scope: { type: 'team', id: f.team.id }, budgetProjectId: f.project.id, title: 'Current root stop also applies',
  }) as TeamTask;
  await f.service.pauseRun(claimant.run.id);
  await assert.rejects(claimant.call.hooks.onTool!('task_claim', {
    taskId: userTask.id, expectedVersion: userTask.version,
  }), rejectedWith(403));
  const after = await f.service.workspace();
  assert.equal(after.teamTasks?.find(item => item.id === stoppedTask.id)?.status, 'open');
  assert.equal(after.teamTasks?.find(item => item.id === stoppedTask.id)?.version, stoppedTask.version);
  assert.equal(after.teamTasks?.find(item => item.id === task.id)?.budgetRootRunId, author.run.id);
  assert.equal(after.runs.find(run => run.id === claimant.run.id)?.budgetRootRunId, claimant.run.id);
  claimant.call.finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === claimant.run.id)?.status === 'paused');
});

test('a later run must explicitly inherit a finished claim before completing or releasing it and cancelled claims stay blocked', async t => {
  const f = await fixture(t);
  const author = await f.start(f.author.id);
  const scope = { type: 'team', id: f.team.id };
  for (const ending of ['succeeded', 'failed', 'cancelled'] as const) {
    const task = await author.call.hooks.onTool!('task_create', {
      scope, title: `Claim left by a ${ending} run`, idempotencyKey: randomUUID(),
    }) as TeamTask;
    const previous = await f.start(f.claimant.id);
    const claimed = await previous.call.hooks.onTool!('task_claim', { taskId: task.id, expectedVersion: task.version }) as TeamTask;
    await assert.rejects(f.service.startRun(f.claimant.id, 'Cannot overlap a running claimant', f.project.id, f.team.id), rejectedWith(409));
    if (ending === 'succeeded') {
      f.runtime.heldCleanup.add(previous.run.id);
      previous.call.finish();
      await waitFor(async () => Boolean((await f.service.workspace()).runs.find(run => run.id === previous.run.id)?.cleanupPending));
      await assert.rejects(f.service.startRun(f.claimant.id, 'Cannot inherit before cleanup', f.project.id, f.team.id), rejectedWith(409));
      f.runtime.heldCleanup.delete(previous.run.id);
    } else if (ending === 'failed') {
      previous.call.fail(new Error('Controlled terminal fixture failure'));
    } else {
      await f.service.pauseRun(previous.run.id);
      previous.call.finish();
      await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === previous.run.id)?.status === 'paused');
      await assert.rejects(f.service.startRun(f.claimant.id, 'Cannot replace an explicitly paused claimant', f.project.id, f.team.id), rejectedWith(409));
      await f.service.cancelRun(previous.run.id);
    }
    await waitFor(async () => {
      const state = await f.service.workspace();
      const run = state.runs.find(item => item.id === previous.run.id);
      return run?.status === ending && !run.cleanupPending && state.agents.find(agent => agent.id === f.claimant.id)?.status === 'idle';
    });
    const next = await f.start(f.claimant.id);
    const tool = next.call.hooks.onTool!;
    await assert.rejects(tool('task_complete', { taskId: task.id, expectedVersion: claimed.version, outcome: 'No implicit takeover' }), rejectedWith(403));
    await assert.rejects(tool('task_release', { taskId: task.id, expectedVersion: claimed.version }), rejectedWith(403));
    if (ending === 'cancelled') {
      await assert.rejects(tool('task_claim', { taskId: task.id, expectedVersion: claimed.version }), rejectedWith(409));
      const unchanged = (await f.service.workspace()).teamTasks!.find(item => item.id === task.id)!;
      assert.equal(unchanged.claimedRunId, previous.run.id);
      assert.equal(unchanged.version, claimed.version);
      assert.deepEqual(unchanged.claimRunIds, [previous.run.id]);
    } else {
      await assert.rejects(tool('task_claim', { taskId: task.id, expectedVersion: task.version }), rejectedWith(409));
      await f.service.updateTeam(f.team.id, { memberIds: [f.author.id] });
      await assert.rejects(tool('task_claim', { taskId: task.id, expectedVersion: claimed.version }), rejectedWith(403));
      await f.service.updateTeam(f.team.id, { memberIds: [f.author.id, f.claimant.id] });
      const inherited = await tool('task_claim', { taskId: task.id, expectedVersion: claimed.version }) as TeamTask;
      assert.equal(inherited.claimedRunId, next.run.id);
      assert.equal(inherited.assigneeAgentId, f.claimant.id);
      assert.equal(inherited.version, claimed.version + 1);
      assert.deepEqual(inherited.claimRunIds, [previous.run.id, next.run.id]);
      assert.equal(inherited.budgetRootRunId, author.run.id);
      const state = await f.service.workspace();
      assert.equal(state.runs.find(run => run.id === previous.run.id)?.budgetRootRunId, previous.run.id);
      assert.equal(state.runs.find(run => run.id === next.run.id)?.budgetRootRunId, next.run.id);
      const result = ending === 'succeeded'
        ? await tool('task_complete', { taskId: task.id, expectedVersion: inherited.version, outcome: 'Explicitly inherited completion' }) as TeamTask
        : await tool('task_release', { taskId: task.id, expectedVersion: inherited.version }) as TeamTask;
      assert.equal(result.status, ending === 'succeeded' ? 'done' : 'open');
      assert.equal(result.claimedRunId, ending === 'succeeded' ? next.run.id : null);
      assert.deepEqual(result.claimRunIds, [previous.run.id, next.run.id]);
    }
    next.call.finish();
    await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === next.run.id)?.status === 'succeeded');
  }
  author.call.finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(run => run.id === author.run.id)?.status === 'succeeded');
});
