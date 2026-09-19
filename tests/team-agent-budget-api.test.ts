import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { OperationalFixtureRuntime, resources, temporary, waitFor } from './operational-budget-fixture.ts';

test('team and agent policy API validates IDs, pins original teams, and prevents scope-erasing input', async t => {
  const directory = await temporary(t);
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'ledger'), ownerKey: randomUUID() });
  const runtime = new OperationalFixtureRuntime();
  const app = await createApp({ runtime, scheduler: resources(), operationalBudget: budget });
  t.after(() => app.close());
  async function post(url: string, payload: object, expected = 201) {
    const response = await app.inject({ method: 'POST', url, payload });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  }
  async function policy(payload: object, expected = 200) {
    const response = await app.inject({ method: 'PATCH', url: '/api/model-budget', payload });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  }
  const alice = await post('/api/agents', { name: 'API Alice', persona: 'No model fixture' });
  const alpha = await post('/api/teams', { name: 'Alpha', memberIds: [alice.id] });
  const beta = await post('/api/teams', { name: 'Beta', memberIds: [alice.id] });
  const project = await post('/api/collaboration/project_create', { name: 'Shared', teamIds: [alpha.id, beta.id] }, 200);
  const status = await policy({ expectedRevision: 0, teamDailyLimits: { [alpha.id]: 0 }, agentDailyLimits: { [alice.id]: null } });
  assert.equal(status.dailyLimit, 100); assert.equal(status.teamDailyLimits[alpha.id], 0);
  assert.equal(status.agentDailyLimits[alice.id], null);
  await policy({ expectedRevision: 0, agentDailyLimits: { [alice.id]: 2 } }, 409);
  for (const name of ['teamDailyLimits', 'agentDailyLimits']) {
    await policy({ expectedRevision: 1, [name]: { [randomUUID()]: 1 } }, 404);
    await policy({ expectedRevision: 1, [name]: { [alice.id]: -1 } }, 400);
  }
  const base = { scope: { type: 'project', id: project.id }, title: 'Choose original team' };
  await post('/api/conversations', { ...base, idempotencyKey: randomUUID() }, 400);
  await post('/api/conversations', { ...base, budgetTeamId: null, idempotencyKey: randomUUID() }, 403);
  await post('/api/conversations', { scope: { type: 'team', id: alpha.id }, budgetTeamId: beta.id, idempotencyKey: randomUUID() }, 403);
  const idempotencyKey = randomUUID();
  const room = await post('/api/conversations', { ...base, budgetTeamId: alpha.id, idempotencyKey });
  assert.equal(room.budgetTeamId, alpha.id);
  await post('/api/conversations', { ...base, budgetTeamId: beta.id, idempotencyKey }, 409);
  const personal = await post('/api/conversations', { scope: { type: 'agent', id: alice.id },
    budgetProjectId: null, budgetTeamId: null, idempotencyKey: randomUUID() });
  assert.equal(personal.budgetProjectId, null); assert.equal(personal.budgetTeamId, null);
  const task = await post('/api/collaboration/task_create', { scope: base.scope, title: 'Pinned task', budgetTeamId: alpha.id }, 200);
  assert.equal(task.budgetTeamId, alpha.id);
  await post(`/api/team-tasks/${task.id}/run`, { agentId: alice.id, expectedVersion: task.version, budgetTeamId: beta.id }, 403);
  const run = await post(`/api/team-tasks/${task.id}/run`, { agentId: alice.id, expectedVersion: task.version }, 202);
  await waitFor(async () => (await app.inject('/api/model-budget')).json().waiting.length === 1);
  const waiting = (await app.inject('/api/model-budget')).json().waiting[0];
  assert.equal(waiting.runId, run.id); assert.equal(waiting.teamId, alpha.id); assert.equal(waiting.agentId, alice.id);
  assert.equal(waiting.blockedBy, 'team'); assert.equal(runtime.calls.length, 0);
  await post(`/api/runs/${run.id}/cancel`, {}, 200);
});
