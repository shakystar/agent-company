import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { FileModelBudget } from '../server/model-budget.ts';
import { isBudgetPause, type ModelStartRequest } from '../shared/telemetry.ts';
import { temporary } from './operational-budget-fixture.ts';

const request = (extra: Partial<ModelStartRequest> = {}): ModelStartRequest => ({ runId: randomUUID(), phase: 'task',
  kind: 'test-only', reason: 'No actual model start', ...extra });
const attribution = (projectId: string | null = null) => ({ projectId, rootRunId: randomUUID() });

test('operational last slot is atomic across independent clients and survives reopening', async t => {
  const directory = await temporary(t), ownerKey = randomUUID();
  const first = await OperationalModelBudget.open({ directory, ownerKey });
  assert.equal((await first.status()).dailyLimit, 100);
  await first.update({ expectedRevision: 0, dailyLimit: 1 });
  const second = await OperationalModelBudget.open({ directory, ownerKey });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? first : second).reserve(request(), attribution())));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => isBudgetPause(result.reason)));
  const reopened = await OperationalModelBudget.open({ directory, ownerKey });
  assert.equal(await reopened.canStart(null), false);
  await assert.rejects(reopened.reserve(request({ reason: 'Process restart cannot replenish usage' }), attribution()), isBudgetPause);
});

test('Korean midnight replenishes admission without resetting earlier days or accepting a stale UTC boundary', async t => {
  const directory = await temporary(t), ownerKey = randomUUID();
  let clock = new Date('2026-09-06T14:59:59.999Z');
  const budget = await OperationalModelBudget.open({ directory, ownerKey, now: () => clock });
  await budget.update({ expectedRevision: 0, dailyLimit: 1 });
  await budget.reserve(request(), attribution());
  assert.equal(await budget.canStart(null), false);
  clock = new Date('2026-09-06T15:00:00.000Z');
  assert.equal(await budget.canStart(null), true);
  assert.equal((await budget.status()).date, '2026-09-07');
  assert.equal((await budget.status()).resetAt, '2026-09-07T15:00:00.000Z');
  await budget.reserve(request(), attribution());
  clock = new Date('2026-09-07T00:00:00.000Z');
  assert.equal(await budget.canStart(null), false, 'UTC midnight is not a second KST reset');
  const reopened = await OperationalModelBudget.open({ directory, ownerKey, now: () => clock });
  assert.equal(await reopened.canStart(null), false);
  clock = new Date('2026-09-06T14:59:59.999Z');
  assert.equal(await reopened.canStart(null), false, 'Earlier day history remains exhausted after clock rollback');
  const ledger = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'));
  assert.deepEqual(ledger.starts.map((entry: { date: string }) => entry.date), ['2026-09-06', '2026-09-07']);
});

test('project caps are not reservations; common personal usage and uncapped projects still share the global cap', async t => {
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID() });
  const alpha = randomUUID(), beta = randomUUID();
  await budget.update({ expectedRevision: 0, dailyLimit: 3, projectDailyLimits: { [alpha]: 1, [beta]: null } });
  await budget.reserve(request(), attribution(alpha));
  assert.equal(await budget.canStart(alpha), false); assert.equal(await budget.canStart(beta), true);
  await assert.rejects(budget.reserve(request(), attribution(alpha)), isBudgetPause);
  await budget.reserve(request(), attribution(beta));
  await budget.reserve(request(), attribution(null));
  const status = await budget.status([alpha, beta]);
  assert.equal(status.used, 3);
  assert.equal(status.projects.find(project => project.projectId === alpha)!.used, 1);
  assert.equal(status.projects.find(project => project.projectId === beta)!.used, 1);
  for (const project of [alpha, beta, null]) assert.equal(await budget.canStart(project), false);
  await assert.rejects(budget.reserve(request(), attribution(beta)), isBudgetPause);
});

test('missing or corrupted usage history fails closed and mismatched installation ownership never resets usage', async t => {
  const directory = await temporary(t), ownerKey = randomUUID();
  const budget = await OperationalModelBudget.open({ directory, ownerKey });
  await budget.reserve(request(), attribution());
  await assert.rejects(OperationalModelBudget.open({ directory, ownerKey: randomUUID() }));
  assert.equal((await budget.status()).used, 1);
  const ledger = join(directory, 'ledger.json'), preserved = join(directory, 'preserved-ledger.json');
  await rename(ledger, preserved);
  await assert.rejects(budget.status());
  await assert.rejects(OperationalModelBudget.open({ directory, ownerKey }));
  await assert.rejects(readFile(ledger), { code: 'ENOENT' });
  await writeFile(ledger, '{corrupted-json', { flag: 'wx' });
  await assert.rejects(OperationalModelBudget.open({ directory, ownerKey }));
  assert.equal(await readFile(ledger, 'utf8'), '{corrupted-json');
  assert.equal(JSON.parse(await readFile(preserved, 'utf8')).starts.length, 1);
});

test('a reservation spanning KST midnight is charged to the actual start day', async t => {
  const directory = await temporary(t); let clock = new Date('2026-09-06T14:59:59.999Z');
  const budget = await OperationalModelBudget.open({ directory, ownerKey: randomUUID(), now: () => clock });
  await budget.update({ expectedRevision: 0, dailyLimit: 1 });
  await budget.reserve(request(), attribution(), async () => { clock = new Date('2026-09-06T15:00:00.000Z'); });
  assert.equal((await budget.status()).used, 1);
  assert.equal(await budget.canStart(null), false);
  assert.equal(JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8')).starts[0].date, '2026-09-07');
});

test('zero caps hold admission, raising caps preserves usage, and stale policy updates never overwrite newer decisions', async t => {
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID() });
  await budget.update({ expectedRevision: 0, dailyLimit: 0 });
  assert.equal(await budget.canStart(null), false);
  await assert.rejects(budget.reserve(request(), attribution()), isBudgetPause);
  await budget.update({ expectedRevision: 1, dailyLimit: 1 });
  await budget.reserve(request(), attribution());
  await budget.update({ expectedRevision: 2, dailyLimit: 2 });
  await budget.reserve(request(), attribution());
  assert.equal(await budget.canStart(null), false);
  await assert.rejects(budget.update({ expectedRevision: 2, dailyLimit: 100 }));
  assert.equal(await budget.canStart(null), false);
});

test('operational and ten-start development gates are independent and denial does not consume the other gate', async t => {
  const directory = await temporary(t);
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'operational'), ownerKey: randomUUID() });
  const campaign = new FileModelBudget(join(directory, 'development-campaign'), 10);
  await budget.update({ expectedRevision: 0, dailyLimit: 0 });
  const start = request();
  await assert.rejects(budget.reserve(start, attribution(), () => campaign.reserve(start)), isBudgetPause);
  assert.equal((await campaign.read()).starts.length, 0);
  await budget.update({ expectedRevision: 1, dailyLimit: 20 });
  for (let index = 0; index < 10; index++) {
    const next = request(); await budget.reserve(next, attribution(), () => campaign.reserve(next));
  }
  const denied = request();
  await assert.rejects(budget.reserve(denied, attribution(), () => campaign.reserve(denied)), isBudgetPause);
  assert.equal((await campaign.read()).starts.length, 10);
  for (let index = 0; index < 10; index++) await budget.reserve(request(), attribution());
  assert.equal(await budget.canStart(null), false, 'The rejected development start must not consume operating capacity');
  assert.equal((await campaign.read()).starts.length, 10, 'Ordinary operational starts must not silently enter the development campaign');
});

test('all model phases and repeated starts of the same run count; model metadata is not a deduplication key', async t => {
  const budget = await OperationalModelBudget.open({ directory: await temporary(t), ownerKey: randomUUID() });
  await budget.update({ expectedRevision: 0, dailyLimit: 5 });
  const runId = randomUUID(), origin = attribution();
  for (const phase of ['task', 'trial', 'evaluate', 'repair', 'task'] as const) {
    await budget.reserve(request({ runId, phase, reason: 'Same run across task, growth and retry' }), origin);
  }
  await assert.rejects(budget.reserve(request({ runId }), origin), isBudgetPause);
});
