import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { activeStorage, type StorageConfig } from '../server/storage.ts';
import type { ExecutionHooks, ExecutionInput } from '../shared/types.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import { resources, temporary, waitFor } from './operational-budget-fixture.ts';

class ScopedStorageRuntime extends StorageFixtureRuntime {
  override forkWorkspace(key: string): ScopedStorageRuntime { return new ScopedStorageRuntime(key, this.spaces, this.calls); }
  override async execute(input: ExecutionInput, hooks: ExecutionHooks) {
    await hooks.beforeModelStart!({ runId: input.run.id, phase: 'task', kind: 'fixture', reason: 'Scoped restore fixture; no model' });
    return super.execute(input, hooks);
  }
}

test('restoring a workspace keeps later team and agent charges and policies outside the restored generation', async t => {
  const directory = await temporary(t), ownerKey = randomUUID();
  let clock = new Date('2026-09-06T14:59:00.000Z');
  const budgetDirectory = join(directory, 'installation-budget');
  const budget = await OperationalModelBudget.open({ directory: budgetDirectory, ownerKey, now: () => clock });
  const config: StorageConfig = { rootDir: join(directory, 'workspace'), backupDir: join(directory, 'backups'),
    ownerKey, freeSpace: async () => 100 * 1024 ** 3 };
  const runtime = new ScopedStorageRuntime(ownerKey);
  let service: AgentService | undefined = await AgentService.create({ runtime, storage: config,
    dataDir: join(config.rootDir, 'db'), operationalBudget: budget, scheduler: resources() });
  try {
    const agent = await service.createAgent({ name: 'Scoped backup original', persona: 'Controlled fixture' });
    const team = await service.createTeam({ name: 'Original task team', memberIds: [agent.id] });
    await service.updateModelBudget({ expectedRevision: 0, teamDailyLimits: { [team.id]: 0 }, agentDailyLimits: { [agent.id]: 2 } });
    const room = await service.createConversation({ scope: { type: 'team', id: team.id }, idempotencyKey: randomUUID() });
    const message = await service.sendConversation(room.id, { content: 'Remain queued for restore verification', mode: 'task',
      recipientAgentId: agent.id, idempotencyKey: randomUUID() });
    await waitFor(async () => (await service!.modelBudgetStatus()).waiting.some(item => item.blockedBy === 'team'));
    const pendingRun = (await service.workspace()).runs.find(run => run.conversationMessageId === message.id)!;
    const backup = (await service.createBackup()).backups[0]; assert.equal(backup.verified, true);
    await service.cancelRun(pendingRun.id);
    await service.updateModelBudget({ expectedRevision: 1, teamDailyLimits: { [team.id]: 3 }, agentDailyLimits: { [agent.id]: 2 } });
    const laterRun = randomUUID();
    await budget.reserve({ runId: laterRun, phase: 'task', kind: 'fixture', reason: 'Charge after the backup; no model' },
      { projectId: null, teamId: team.id, agentId: agent.id, rootRunId: laterRun });
    await service.updateAgent(agent.id, { name: 'Newer name' });
    const ledgerBefore = await readFile(join(budgetDirectory, 'ledger.json'));
    const restored = await service.prepareRestore(backup.id); await service.activateRestore(restored.id);
    assert.equal((await service.workspace()).agents[0].name, 'Scoped backup original');
    let status = await service.modelBudgetStatus();
    assert.equal(status.used, 1); assert.equal(status.revision, 2);
    assert.deepEqual(status.teams?.find(item => item.teamId === team.id), { teamId: team.id, limit: 3, used: 1, remaining: 2 });
    assert.deepEqual(status.agents?.find(item => item.agentId === agent.id), { agentId: agent.id, limit: 2, used: 1, remaining: 1 });
    assert.equal((await service.storageStatus()).paused, true);
    assert.deepEqual(await readFile(join(budgetDirectory, 'ledger.json')), ledgerBefore);
    await service.close(); service = undefined;
    const active = await activeStorage(config);
    service = await AgentService.create({ runtime: runtime.forkWorkspace(active.workspaceKey), storage: config,
      dataDir: join(active.dataDir, 'db'), scheduler: resources(),
      operationalBudget: await OperationalModelBudget.open({ directory: budgetDirectory, ownerKey, now: () => clock }) });
    status = await service.modelBudgetStatus(); assert.equal(status.used, 1);
    assert.equal(status.teams?.find(item => item.teamId === team.id)?.used, 1);
    assert.equal(status.agents?.find(item => item.agentId === agent.id)?.used, 1);
    clock = new Date('2026-09-06T15:00:00.000Z'); await service.reconcileModelBudget();
    status = await service.modelBudgetStatus(); assert.equal(status.used, 0);
    assert.equal(status.teams?.find(item => item.teamId === team.id)?.limit, 3);
    assert.equal(status.agents?.find(item => item.agentId === agent.id)?.limit, 2);
    assert.equal((await service.storageStatus()).paused, true); assert.equal(runtime.calls.length, 0);
    assert.deepEqual(await readFile(join(budgetDirectory, 'ledger.json')), ledgerBefore);
  } finally { await service?.close(); }
});
