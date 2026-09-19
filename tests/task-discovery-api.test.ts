import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import type { TeamTask } from '../shared/collaboration.ts';
import type { Workspace } from '../shared/types.ts';
import { OperationalFixtureRuntime, resources, waitFor } from './operational-budget-fixture.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-task-discovery-api-'));
  const runtime = new OperationalFixtureRuntime();
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'budget'), ownerKey: randomUUID() });
  const app = await createApp({ runtime, dataDir: join(directory, 'db'), operationalBudget: budget, scheduler: resources() });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-task-discovery-api-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  return { app, runtime, budget };
}
async function request(app: FastifyInstance, method: 'POST' | 'PATCH', url: string, payload: object, expected: number) {
  const response = await app.inject({ method, url, payload });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function workspace(app: FastifyInstance): Promise<Workspace> {
  const response = await app.inject('/api/workspace');
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
const rejectedWith = (status: number) => (error: unknown) => error instanceof Error
  && 'statusCode' in error && error.statusCode === status;

test('task discovery is disabled by default and only an explicit boolean team setting enables it', async t => {
  const { app, runtime } = await fixture(t);
  const agent = await request(app, 'POST', '/api/agents', { name: 'Opt-in member', persona: 'Fixture only' }, 201);
  const team = await request(app, 'POST', '/api/teams', { name: 'Default off', memberIds: [agent.id] }, 201);
  assert.equal(team.autoDiscoverTasks, false);
  await request(app, 'POST', '/api/collaboration/task_create', {
    scope: { type: 'team', id: team.id }, title: 'Remain open until enabled',
  }, 200);
  const disabled = await workspace(app);
  assert.equal(disabled.runs.length, 0);
  assert.equal(disabled.taskDiscoveries?.length ?? 0, 0);
  for (const value of ['true', 1, null]) {
    await request(app, 'PATCH', `/api/teams/${team.id}`, { autoDiscoverTasks: value }, 400);
    await request(app, 'POST', '/api/teams', { name: 'Invalid opt-in', memberIds: [], autoDiscoverTasks: value }, 400);
  }
  // Keep this contract test independent from background execution while testing the toggle.
  await request(app, 'PATCH', `/api/agents/${agent.id}`, { status: 'paused' }, 200);
  const enabled = await request(app, 'PATCH', `/api/teams/${team.id}`, { autoDiscoverTasks: true }, 200);
  assert.equal(enabled.autoDiscoverTasks, true);
  assert.equal((await workspace(app)).teams.find(item => item.id === team.id)?.autoDiscoverTasks, true);
  const renamed = await request(app, 'PATCH', `/api/teams/${team.id}`, { name: 'Still enabled' }, 200);
  assert.equal(renamed.autoDiscoverTasks, true, 'An unrelated team edit must preserve opt-in');
  const switchedOff = await request(app, 'PATCH', `/api/teams/${team.id}`, { autoDiscoverTasks: false }, 200);
  assert.equal(switchedOff.autoDiscoverTasks, false);
  const createdOn = await request(app, 'POST', '/api/teams', {
    name: 'Explicit creation opt-in', memberIds: [], autoDiscoverTasks: true,
  }, 201);
  assert.equal(createdOn.autoDiscoverTasks, true);
  assert.equal((await workspace(app)).runs.length, 0);
  assert.equal(runtime.calls.length, 0);
});

test('task creation retries reuse the same task per actor and reject changed input with the same key', async t => {
  const { app, runtime } = await fixture(t);
  const alice = await request(app, 'POST', '/api/agents', { name: 'Alice', persona: 'Fixture author' }, 201);
  const bob = await request(app, 'POST', '/api/agents', { name: 'Bob', persona: 'Fixture author' }, 201);
  const team = await request(app, 'POST', '/api/teams', { name: 'Authors', memberIds: [alice.id, bob.id] }, 201);
  const input = { scope: { type: 'team', id: team.id }, title: 'Idempotent proposal', description: 'Original input', idempotencyKey: randomUUID() };
  const userTask = await request(app, 'POST', '/api/collaboration/task_create', input, 200);
  const retried = await request(app, 'POST', '/api/collaboration/task_create', input, 200);
  assert.equal(retried.id, userTask.id);
  await request(app, 'POST', '/api/collaboration/task_create', { ...input, description: 'Changed input' }, 409);
  for (const agent of [alice, bob]) {
    await request(app, 'POST', `/api/agents/${agent.id}/runs`, { prompt: 'Propose the fixture task' }, 202);
  }
  await waitFor(() => runtime.calls.length === 2);
  const authored: TeamTask[] = [];
  for (const call of runtime.calls) {
    const task = await call.hooks.onTool!('task_create', input) as TeamTask;
    authored.push(task);
    const retry = await call.hooks.onTool!('task_create', input) as TeamTask;
    assert.equal(retry.id, task.id);
    assert.equal(task.createdByAgentId, call.input.agent.id);
    await assert.rejects(call.hooks.onTool!('task_create', { ...input, title: 'Changed proposal' }), rejectedWith(409));
  }
  assert.equal(new Set([userTask.id, ...authored.map(item => item.id)]).size, 3);
  assert.equal((await workspace(app)).teamTasks?.length, 3);
  for (const call of runtime.calls) call.finish();
  await waitFor(async () => (await workspace(app)).runs.every(run => run.status === 'succeeded'));
  assert.equal((await workspace(app)).taskDiscoveries?.length ?? 0, 0);
});

test('task ownership and discovery metadata cannot be forged and worker claims bind only the actual run', async t => {
  const { app, runtime } = await fixture(t);
  const agent = await request(app, 'POST', '/api/agents', { name: 'Actual claimant', persona: 'Fixture only' }, 201);
  const team = await request(app, 'POST', '/api/teams', { name: 'Claim provenance', memberIds: [agent.id] }, 201);
  const input = { scope: { type: 'team', id: team.id }, title: 'Claim lifecycle' };
  for (const forged of [
    { claimedRunId: randomUUID() }, { assigneeAgentId: agent.id }, { createdByAgentId: agent.id },
    { status: 'claimed' }, { taskDiscovery: { teamId: team.id, taskId: randomUUID(), taskVersion: 1 } },
  ]) await request(app, 'POST', '/api/collaboration/task_create', { ...input, ...forged }, 400);
  const task = await request(app, 'POST', '/api/collaboration/task_create', input, 200);
  assert.equal(task.claimedRunId ?? null, null);
  await request(app, 'POST', `/api/agents/${agent.id}/runs`, {
    prompt: 'Reject user-supplied discovery ownership', taskDiscovery: { teamId: team.id, taskId: task.id, taskVersion: task.version },
  }, 400);
  await request(app, 'PATCH', `/api/teams/${team.id}`, { taskDiscoveries: [] }, 400);
  const run = await request(app, 'POST', `/api/agents/${agent.id}/runs`, { prompt: 'Claim and complete the fixture task' }, 202);
  await waitFor(() => runtime.calls.length === 1);
  const tool = runtime.calls[0].hooks.onTool!;
  await assert.rejects(tool('task_claim', { taskId: task.id, expectedVersion: task.version, claimedRunId: randomUUID() }), rejectedWith(400));
  const claimed = await tool('task_claim', { taskId: task.id, expectedVersion: task.version }) as TeamTask;
  assert.equal(claimed.claimedRunId, run.id);
  assert.equal(claimed.assigneeAgentId, agent.id);
  const released = await tool('task_release', { taskId: task.id, expectedVersion: claimed.version }) as TeamTask;
  assert.equal(released.status, 'open');
  assert.equal(released.claimedRunId, null);
  const reclaimed = await tool('task_claim', { taskId: task.id, expectedVersion: released.version }) as TeamTask;
  const completed = await tool('task_complete', { taskId: task.id, expectedVersion: reclaimed.version, outcome: 'Fixture outcome' }) as TeamTask;
  assert.equal(completed.status, 'done');
  assert.equal(completed.claimedRunId, run.id);
  runtime.calls[0].finish();
  await waitFor(async () => (await workspace(app)).runs.find(item => item.id === run.id)?.status === 'succeeded');
  assert.equal((await workspace(app)).teamTasks?.find(item => item.id === task.id)?.claimedRunId, run.id);
});
