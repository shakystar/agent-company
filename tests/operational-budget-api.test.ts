import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';
import { OperationalFixtureRuntime, resources, waitFor } from './operational-budget-fixture.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-operational-budget-'));
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'budget'), ownerKey: randomUUID(),
    now: () => new Date('2026-09-06T14:00:00.000Z') });
  const runtime = new OperationalFixtureRuntime();
  const app = await createApp({ runtime, operationalBudget: budget, scheduler: resources() });
  t.after(async () => { await app.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-operational-budget-[^\\/]+$/); await rm(directory, { recursive: true, force: true }); });
  return { app, runtime, budget };
}
const status = async (app: FastifyInstance): Promise<OperationalBudgetStatus> => {
  const response = await app.inject('/api/model-budget'); assert.equal(response.statusCode, 200, response.body); return response.json();
};
async function post(app: FastifyInstance, url: string, payload: object, expected = 201) {
  const response = await app.inject({ method: 'POST', url, payload });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function patch(app: FastifyInstance, payload: object, expected = 200): Promise<OperationalBudgetStatus> {
  const response = await app.inject({ method: 'PATCH', url: '/api/model-budget', payload });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}

test('operator budget API exposes initial KST policy, strict settings and revision conflicts without allowing ledger edits', async t => {
  const { app, runtime } = await fixture(t);
  const initial = await status(app);
  assert.equal(initial.enabled, true); assert.equal(initial.dailyLimit, 100); assert.equal(initial.used, 0);
  assert.equal(initial.date, '2026-09-06'); assert.equal(initial.timezone, 'Asia/Seoul'); assert.equal(initial.resetAt, '2026-09-06T15:00:00.000Z');
  assert.equal('starts' in initial, false); assert.equal('ownerKey' in initial, false);
  const next = await patch(app, { expectedRevision: initial.revision, dailyLimit: 0 });
  assert.equal(next.dailyLimit, 0); assert.equal(next.revision, initial.revision + 1);
  await patch(app, { expectedRevision: initial.revision, dailyLimit: 200 }, 409);
  for (const dailyLimit of [-1, 1.5, 1_000_001, null, '100']) await patch(app, { expectedRevision: next.revision, dailyLimit }, 400);
  for (const additional of [{ starts: [] }, { used: 0 }, { ownerKey: randomUUID() }, { enabled: false }]) {
    await patch(app, { expectedRevision: next.revision, dailyLimit: 100, ...additional }, 400);
  }
  await patch(app, { expectedRevision: next.revision }, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-budget', headers: { origin: 'https://attacker.test' },
    payload: { expectedRevision: next.revision, dailyLimit: 100 } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/model-budget', headers: { host: 'attacker.test' } })).statusCode, 403);
  assert.equal((await status(app)).dailyLimit, 0); assert.equal(runtime.calls.length, 0);
});

test('project budget settings display the blocked project and a user increase resumes its existing task', async t => {
  const { app, runtime } = await fixture(t);
  const agent = await post(app, '/api/agents', { name: 'Project operator fixture', persona: 'Actual bounded worker' });
  const team = await post(app, '/api/teams', { name: 'Project team', memberIds: [agent.id] });
  const project = await post(app, '/api/collaboration/project_create', { name: 'Project', teamIds: [team.id] }, 200);
  const configured = await patch(app, { expectedRevision: 0, projectDailyLimits: { [project.id]: 0 } });
  const conversation = await post(app, '/api/conversations', { scope: { type: 'project', id: project.id }, idempotencyKey: randomUUID() });
  await post(app, `/api/conversations/${conversation.id}/messages`, { content: 'Run this actual project task', mode: 'task', idempotencyKey: randomUUID() }, 202);
  await waitFor(async () => (await status(app)).waiting.length === 1);
  const waiting = await status(app), blocked = waiting.waiting[0];
  assert.equal(blocked.projectId, project.id); assert.equal(blocked.blockedBy, 'project');
  assert.equal(waiting.used, 0); assert.equal(waiting.remaining, 100); assert.equal(runtime.calls.length, 0);
  const globalHold = await patch(app, { expectedRevision: configured.revision, dailyLimit: 0, projectDailyLimits: { [project.id]: null } });
  assert.equal(globalHold.waiting[0].blockedBy, 'global', 'The displayed blocking limit must follow the current policy');
  const increased = await patch(app, { expectedRevision: globalHold.revision, dailyLimit: 100, projectDailyLimits: { [project.id]: 1 } });
  assert.equal(increased.projectDailyLimits[project.id], 1);
  await waitFor(() => runtime.calls.length === 1);
  assert.equal(runtime.calls[0].input.run.id, blocked.runId); assert.equal(runtime.calls[0].input.run.budgetProjectId, project.id);
  runtime.calls[0].finish();
  await waitFor(async () => (await app.inject('/api/workspace')).json().runs[0].status === 'succeeded');
  const completed = await status(app);
  assert.equal(completed.used, 1); assert.equal(completed.projects.find(item => item.projectId === project.id)!.used, 1);
  const uncapped = await patch(app, { expectedRevision: completed.revision, projectDailyLimits: { [project.id]: null } });
  assert.equal(uncapped.projects.find(item => item.projectId === project.id)!.limit, null);
  assert.equal(uncapped.used, 1, 'Changing a cap never rewinds consumed starts');
});

test('API cannot reassign a project conversation or inject attribution through a message', async t => {
  const { app } = await fixture(t);
  const agent = await post(app, '/api/agents', { name: 'One participant', persona: 'No authority inflation' });
  const team = await post(app, '/api/teams', { name: 'Shared team', memberIds: [agent.id] });
  const first = await post(app, '/api/collaboration/project_create', { name: 'First', teamIds: [team.id] }, 200);
  const second = await post(app, '/api/collaboration/project_create', { name: 'Second', teamIds: [team.id] }, 200);
  const scope = { type: 'project', id: first.id };
  await post(app, '/api/conversations', { scope, budgetProjectId: second.id, idempotencyKey: randomUUID() }, 403);
  await post(app, '/api/conversations', { scope, budgetProjectId: null, idempotencyKey: randomUUID() }, 403);
  const conversation = await post(app, '/api/conversations', { scope, idempotencyKey: randomUUID() });
  for (const fields of [{ budgetProjectId: second.id }, { budgetRootRunId: randomUUID() }]) {
    await post(app, `/api/conversations/${conversation.id}/messages`, { content: 'Do not change attribution', mode: 'task',
      idempotencyKey: randomUUID(), ...fields }, 400);
  }
  assert.equal((await status(app)).used, 0);
  assert.equal((await app.inject('/api/workspace')).json().runs.length, 0);
});
