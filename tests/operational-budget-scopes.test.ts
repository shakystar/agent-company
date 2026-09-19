import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { OperationalModelBudget, OperationalBudgetPause, operationalBudgetBlock } from '../server/operational-budget.ts';
import type { BudgetAttribution, OperationalBudgetBlock } from '../shared/operational-budget.ts';
import { updateOperationalBudgetSchema } from '../shared/operational-budget.ts';
import type { ModelStartRequest } from '../shared/telemetry.ts';
import { temporary } from './operational-budget-fixture.ts';

const request = (): ModelStartRequest => ({ runId: randomUUID(), phase: 'task', kind: 'scope-fixture', reason: 'No model call' });
const origin = (extra: Partial<BudgetAttribution> = {}): BudgetAttribution => ({ projectId: null, rootRunId: randomUUID(), ...extra });
const blocked = (by: OperationalBudgetBlock['blockedBy']) => (error: unknown) => error instanceof OperationalBudgetPause && error.block.blockedBy === by;

test('all four caps share one admission and preserve global/project/team/agent precedence', async t => {
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID() });
  const projectId = randomUUID(), teamId = randomUUID(), agentId = randomUUID(), attribution = origin({ projectId, teamId, agentId });
  await budget.update({ expectedRevision: 0, dailyLimit: 0, projectDailyLimits: { [projectId]: 0 }, teamDailyLimits: { [teamId]: 0 }, agentDailyLimits: { [agentId]: 0 } });
  let callbacks = 0;
  const reserve = () => budget.reserve(request(), attribution, async () => { callbacks += 1; });
  await assert.rejects(reserve(), blocked('global'));
  await budget.update({ expectedRevision: 1, dailyLimit: 10 });
  await assert.rejects(reserve(), blocked('project'));
  await budget.update({ expectedRevision: 2, projectDailyLimits: { [projectId]: 10 } });
  await assert.rejects(reserve(), blocked('team'));
  await budget.update({ expectedRevision: 3, teamDailyLimits: { [teamId]: 10 } });
  await assert.rejects(reserve(), blocked('agent'));
  assert.equal(callbacks, 0, 'A denied scope must not consume the development gate');
  await budget.update({ expectedRevision: 4, agentDailyLimits: { [agentId]: 1 } });
  await reserve();
  const status = await budget.status([projectId], { teamIds: [teamId], agentIds: [agentId] });
  assert.equal(status.used, 1, 'A start is not charged four times to the global total');
  assert.equal(status.projects[0].used, 1); assert.equal(status.teams![0].used, 1); assert.equal(status.agents![0].used, 1);
  assert.deepEqual(status.legacyUnattributed, { team: 0, agent: 0 });
  assert.equal(callbacks, 1);
  assert.equal(operationalBudgetBlock(status, projectId, teamId, agentId)?.blockedBy, 'agent');
});

for (const axis of ['team', 'agent'] as const) {
  test(`the last ${axis} slot remains atomic across independent clients`, async t => {
    const directory = await temporary(t), ownerKey = randomUUID(), cappedId = randomUUID();
    const first = await OperationalModelBudget.open({ directory, ownerKey });
    await first.update({ expectedRevision: 0, dailyLimit: 20,
      ...(axis === 'team' ? { teamDailyLimits: { [cappedId]: 1 } } : { agentDailyLimits: { [cappedId]: 1 } }) });
    const second = await OperationalModelBudget.open({ directory, ownerKey });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).reserve(request(),
      origin({ projectId: randomUUID(), teamId: axis === 'team' ? cappedId : randomUUID(), agentId: axis === 'agent' ? cappedId : randomUUID() }))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result => blocked(axis)(result.reason)));
    const reopened = await OperationalModelBudget.open({ directory, ownerKey }), status = await reopened.status();
    assert.equal(status.used, 1); assert.equal(status.remaining, 19);
    assert.equal((axis === 'team' ? status.teams : status.agents)!.find(item => 'teamId' in item ? item.teamId === cappedId : item.agentId === cappedId)!.used, 1);
  });
}

test('team totals span projects and actual agent totals span origin teams without duplicate team charges', async t => {
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID() });
  const projectA = randomUUID(), projectB = randomUUID(), teamA = randomUUID(), teamB = randomUUID(), agentA = randomUUID(), agentB = randomUUID();
  await budget.update({ expectedRevision: 0, teamDailyLimits: { [teamA]: 2 }, agentDailyLimits: { [agentA]: 2 } });
  await budget.reserve(request(), origin({ projectId: projectA, teamId: teamA, agentId: agentA }));
  await budget.reserve(request(), origin({ projectId: projectB, teamId: teamA, agentId: agentB }));
  await assert.rejects(budget.reserve(request(), origin({ projectId: projectA, teamId: teamA, agentId: agentB })), blocked('team'));
  await budget.reserve(request(), origin({ projectId: projectB, teamId: teamB, agentId: agentA }));
  await assert.rejects(budget.reserve(request(), origin({ projectId: projectA, teamId: teamB, agentId: agentA })), blocked('agent'));
  await budget.reserve(request(), origin({ teamId: teamB, agentId: agentB }));
  const status = await budget.status();
  assert.equal(status.used, 4);
  assert.deepEqual(status.teams!.map(row => row.used).sort(), [2, 2]);
  assert.deepEqual(status.agents!.map(row => row.used).sort(), [2, 2]);
  assert.equal(status.projects.find(row => row.projectId === projectA)!.used, 1);
  assert.equal(status.projects.find(row => row.projectId === projectB)!.used, 2);
});

test('explicit no-team bypasses only team caps, while missing legacy attribution remains conservative', async t => {
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID() });
  const teamId = randomUUID(), agentId = randomUUID(), otherAgent = randomUUID();
  await budget.update({ expectedRevision: 0, teamDailyLimits: { [teamId]: 0 }, agentDailyLimits: { [agentId]: 1 } });
  await budget.reserve(request(), origin({ teamId: null, agentId }));
  await assert.rejects(budget.reserve(request(), origin({ teamId: null, agentId })), blocked('agent'));
  await assert.rejects(budget.reserve(request(), origin({ agentId: otherAgent })), blocked('team'));
  await assert.rejects(budget.reserve(request(), origin({ teamId: null })), blocked('agent'));
  await budget.reserve(request(), origin({ teamId: null, agentId: otherAgent }));
  const status = await budget.status();
  assert.equal(status.used, 2); assert.equal(status.teams![0].used, 0);
  assert.deepEqual(status.legacyUnattributed, { team: 0, agent: 0 });
});

test('unrecorded historical usage counts against each individual cap and is disclosed without multiplying global usage', async t => {
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID() });
  const teamA = randomUUID(), teamB = randomUUID(), agentA = randomUUID(), agentB = randomUUID();
  await budget.reserve(request(), origin());
  await budget.reserve(request(), origin({ teamId: null, agentId: agentA }));
  await budget.reserve(request(), origin({ teamId: teamA, agentId: agentB }));
  await budget.update({ expectedRevision: 0, teamDailyLimits: { [teamA]: 2, [teamB]: 1 }, agentDailyLimits: { [agentA]: 2, [agentB]: 3 } });
  const status = await budget.status();
  assert.equal(status.used, 3); assert.deepEqual(status.legacyUnattributed, { team: 1, agent: 1 });
  assert.equal(status.teams!.find(row => row.teamId === teamA)!.used, 2);
  assert.equal(status.teams!.find(row => row.teamId === teamB)!.used, 1);
  assert.equal(status.agents!.find(row => row.agentId === agentA)!.used, 2);
  assert.equal(status.agents!.find(row => row.agentId === agentB)!.used, 2);
  await assert.rejects(budget.reserve(request(), origin({ teamId: teamB, agentId: agentB })), blocked('team'));
  await assert.rejects(budget.reserve(request(), origin({ teamId: null, agentId: agentA })), blocked('agent'));
  await budget.reserve(request(), origin({ teamId: null, agentId: agentB }));
});

test('team and agent policies use revision CAS, null removes only the cap, and lowering never erases usage', async t => {
  const directory = await temporary(t), budget = await OperationalModelBudget.open({ directory, ownerKey: randomUUID() });
  const teamId = randomUUID(), agentId = randomUUID(), attribution = origin({ teamId, agentId });
  await budget.reserve(request(), attribution);
  await budget.update({ expectedRevision: 0, teamDailyLimits: { [teamId]: 0 }, agentDailyLimits: { [agentId]: 1 } });
  await assert.rejects(budget.update({ expectedRevision: 0, teamDailyLimits: { [teamId]: 100 } }));
  await assert.rejects(budget.reserve(request(), attribution), blocked('team'));
  await budget.update({ expectedRevision: 1, teamDailyLimits: { [teamId]: null } });
  await assert.rejects(budget.reserve(request(), attribution), blocked('agent'));
  await budget.update({ expectedRevision: 2, agentDailyLimits: { [agentId]: null } });
  await budget.reserve(request(), attribution);
  const status = await budget.status(), ledger = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'));
  assert.equal(status.used, 2); assert.equal(status.teams![0].remaining, null); assert.equal(status.agents![0].remaining, null);
  assert.equal(ledger.revision, 3); assert.equal(ledger.changes.length, 3);
  assert.deepEqual(ledger.changes[2].teamDailyLimits, { [teamId]: null });
  assert.deepEqual(ledger.changes[2].agentDailyLimits, { [agentId]: null });
});

test('all per-scope usage follows KST days and remains charged after restart and clock rollback', async t => {
  const directory = await temporary(t), ownerKey = randomUUID(), teamId = randomUUID(), agentId = randomUUID();
  let now = new Date('2026-09-06T14:59:59.999Z');
  const budget = await OperationalModelBudget.open({ directory, ownerKey, now: () => now });
  await budget.update({ expectedRevision: 0, teamDailyLimits: { [teamId]: 1 }, agentDailyLimits: { [agentId]: 1 } });
  await budget.reserve(request(), origin({ teamId, agentId }));
  assert.equal(await budget.canStart(null, teamId, agentId), false);
  now = new Date('2026-09-06T15:00:00.000Z');
  const reopened = await OperationalModelBudget.open({ directory, ownerKey, now: () => now });
  assert.equal(await reopened.canStart(null, teamId, agentId), true);
  await reopened.reserve(request(), origin({ teamId, agentId }));
  now = new Date('2026-09-07T00:00:00.000Z');
  assert.equal(await reopened.canStart(null, teamId, agentId), false);
  now = new Date('2026-09-06T14:59:59.999Z');
  assert.equal(await reopened.canStart(null, teamId, agentId), false);
});

test('scope caps are checked again if a callback moves admission to an already-exhausted KST day', async t => {
  const teamId = randomUUID(), agentId = randomUUID(); let now = new Date('2026-09-06T15:00:00.000Z');
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID(), now: () => now });
  await budget.update({ expectedRevision: 0, teamDailyLimits: { [teamId]: 1 } });
  await budget.reserve(request(), origin({ teamId, agentId }));
  now = new Date('2026-09-06T14:59:59.999Z');
  await assert.rejects(budget.reserve(request(), origin({ teamId, agentId }), async () => { now = new Date('2026-09-06T15:00:00.000Z'); }), blocked('team'));
  assert.equal((await budget.status()).used, 1);
});

test('scope policy input keeps strict UUID, integer, maximum, null and empty-change rules', () => {
  const id = randomUUID();
  for (const map of ['teamDailyLimits', 'agentDailyLimits']) {
    for (const limit of [-1, 0.5, 1_000_001, '3', undefined]) {
      assert.throws(() => updateOperationalBudgetSchema.parse({ expectedRevision: 0, [map]: { [id]: limit } }));
    }
    assert.throws(() => updateOperationalBudgetSchema.parse({ expectedRevision: 0, [map]: { 'not-a-uuid': 1 } }));
    assert.deepEqual(updateOperationalBudgetSchema.parse({ expectedRevision: 0, [map]: { [id]: null } }), { expectedRevision: 0, [map]: { [id]: null } });
  }
  assert.throws(() => updateOperationalBudgetSchema.parse({ expectedRevision: 0 }));
  assert.throws(() => updateOperationalBudgetSchema.parse({ expectedRevision: 0, dailyLimit: 1, used: 0 }));
});
