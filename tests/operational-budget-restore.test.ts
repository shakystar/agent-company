import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { activeStorage, type StorageConfig } from '../server/storage.ts';
import type { ExecutionHooks, ExecutionInput } from '../shared/types.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import { resources, waitFor } from './operational-budget-fixture.ts';

class BudgetStorageRuntime extends StorageFixtureRuntime {
  override forkWorkspace(key: string): BudgetStorageRuntime { return new BudgetStorageRuntime(key, this.spaces, this.calls); }
  override async execute(input: ExecutionInput, hooks: ExecutionHooks) {
    await hooks.beforeModelStart!({ runId: input.run.id, phase: 'task', kind: 'fixture', reason: 'Backup admission fixture; no model' });
    return super.execute(input, hooks);
  }
}

test('restoring an older workspace never rewinds installation budget usage or policy and preserves global pause at midnight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-operational-budget-'));
  const ownerKey = randomUUID(); let clock = new Date('2026-09-06T14:59:00.000Z');
  const budgetDirectory = join(directory, 'installation-budget');
  const config: StorageConfig = { rootDir: join(directory, 'workspace'), backupDir: join(directory, 'backups'),
    ownerKey, freeSpace: async () => 100 * 1024 ** 3 };
  const runtime = new BudgetStorageRuntime(ownerKey);
  const budget = await OperationalModelBudget.open({ directory: budgetDirectory, ownerKey, now: () => clock });
  let service: AgentService | undefined;
  try {
    await budget.update({ expectedRevision: 0, dailyLimit: 2 });
    for (let i = 0; i < 2; i++) await budget.reserve({ runId: `prior-${i}`, phase: 'task', kind: 'fixture', reason: 'Prior admission' },
      { projectId: null, rootRunId: `prior-${i}` });
    service = await AgentService.create({ runtime, storage: config, dataDir: join(config.rootDir, 'db'),
      scheduler: resources(), operationalBudget: budget });
    const agent = await service.createAgent({ name: 'Before backup', persona: 'Preserved agent' });
    const waiting = await service.startRun(agent.id, 'Do not resume behind the operator');
    await waitFor(async () => Boolean((await service!.workspace()).runs.find(run => run.id === waiting.id)?.modelBudgetBlock));
    const backup = (await service.createBackup()).backups[0]; assert.equal(backup.verified, true);
    await service.cancelRun(waiting.id);
    await service.updateAgent(agent.id, { name: 'After backup' });
    await budget.update({ expectedRevision: 1, dailyLimit: 3 });
    await budget.reserve({ runId: 'after-backup', phase: 'evaluate', kind: 'fixture', reason: 'Latest admission must survive restore' },
      { projectId: null, rootRunId: 'after-backup' });
    await budget.update({ expectedRevision: 2, dailyLimit: 1 });
    const latestLedger = await readFile(join(budgetDirectory, 'ledger.json'));
    const restored = await service.prepareRestore(backup.id);
    await service.activateRestore(restored.id);
    assert.equal((await service.workspace()).agents[0].name, 'Before backup');
    let status = await service.modelBudgetStatus();
    assert.equal(status.used, 3); assert.equal(status.dailyLimit, 1); assert.equal(status.revision, 3);
    assert.deepEqual(await readFile(join(budgetDirectory, 'ledger.json')), latestLedger);
    assert.equal((await service.storageStatus()).paused, true);
    await service.close(); service = undefined;
    const active = await activeStorage(config);
    service = await AgentService.create({ runtime: runtime.forkWorkspace(active.workspaceKey), storage: config,
      dataDir: join(active.dataDir, 'db'), scheduler: resources(),
      operationalBudget: await OperationalModelBudget.open({ directory: budgetDirectory, ownerKey, now: () => clock }) });
    status = await service.modelBudgetStatus(); assert.equal(status.used, 3); assert.equal(status.dailyLimit, 1);
    clock = new Date('2026-09-06T15:00:00.000Z');
    await service.reconcileModelBudget();
    assert.equal((await service.storageStatus()).paused, true); assert.equal(runtime.calls.length, 0);
    await assert.rejects(service.startRun(agent.id, 'Still globally paused'), /일시정지|일시 정지/);
    assert.deepEqual(await readFile(join(budgetDirectory, 'ledger.json')), latestLedger);
    const history = JSON.parse(latestLedger.toString('utf8'));
    assert.equal(history.starts.length, 3); assert.equal(history.changes.length, 3);
  } finally {
    await service?.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-operational-budget-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
  }
});
