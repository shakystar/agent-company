import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileModelBudget } from '../server/model-budget.ts';
import { isBudgetPause } from '../shared/telemetry.ts';

test('campaign limit is persistent, counts every start and serializes independent callers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-model-budget-'));
  t.after(() => rm(directory, { recursive: true }));
  const first = new FileModelBudget(directory, 3);
  const second = new FileModelBudget(directory, 3);
  const values = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => (index % 2 ? first : second)
    .reserve({ runId: `run-${index}`, phase: index % 2 ? 'task' : 'evaluate', kind: 'validation', reason: 'controlled test' })));
  assert.equal(values.filter(item => item.status === 'fulfilled').length, 3);
  assert.ok(values.filter(item => item.status === 'rejected').every(item => isBudgetPause(item.reason)));
  const reopened = new FileModelBudget(directory, 3);
  assert.deepEqual((await reopened.read()).starts.map(item => item.sequence), [1, 2, 3]);
  await assert.rejects(() => reopened.reserve({ runId: 'resume', phase: 'task', kind: 'validation', reason: 'resume' }), isBudgetPause);
  await assert.rejects(() => new FileModelBudget(directory, 10).read(), /초기화하지/);
});
