import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import type { Project } from '../shared/collaboration.ts';
import { OperationalFixtureRuntime, resources, temporary, waitFor } from './operational-budget-fixture.ts';

for (const blockedBy of ['global', 'project'] as const) {
  test(`cancelling a settled ${blockedBy} budget waiter releases its agent without restarting the controller`, async t => {
    const directory = await temporary(t);
    const budget = await OperationalModelBudget.open({ directory: join(directory, 'ledger'), ownerKey: randomUUID() });
    const runtime = new OperationalFixtureRuntime();
    const service = await AgentService.create({ runtime, scheduler: resources(), operationalBudget: budget });
    t.after(() => service.close());
    const agent = await service.createAgent({ name: 'Budget cancellation', persona: 'Controlled lifecycle fixture' });
    let projectId: string | null = null;
    if (blockedBy === 'project') {
      const team = await service.createTeam({ name: 'Project team', memberIds: [agent.id] });
      const project = await service.collaboration('project_create', { name: 'Paused project budget', teamIds: [team.id] }) as Project;
      projectId = project.id;
      await service.updateModelBudget({ expectedRevision: 0, projectDailyLimits: { [projectId]: 0 } });
    } else await service.updateModelBudget({ expectedRevision: 0, dailyLimit: 0 });
    const run = await service.startRun(agent.id, 'Never start a real model', projectId);
    // Reproduce the live failure after execute.finally has already completed:
    // cancelRun cannot rely on a future executor cleanup callback.
    const lifecycle = service as unknown as { executions: Map<string, unknown> };
    await waitFor(async () => {
      const state = await service.workspace();
      return state.runs.find(item => item.id === run.id)?.modelBudgetBlock?.blockedBy === blockedBy
        && !lifecycle.executions.has(run.id);
    });
    assert.equal((await service.workspace()).agents.find(item => item.id === agent.id)?.status, 'running');
    await service.cancelRun(run.id);
    await service.reconcileModelBudget();
    const state = await service.workspace();
    assert.equal(state.runs.find(item => item.id === run.id)?.status, 'cancelled');
    assert.equal(state.agents.find(item => item.id === agent.id)?.status, 'idle');
    assert.equal(state.resources?.reserved.memoryMiB, 0);
    assert.equal(state.resources?.reserved.cpus, 0);
    assert.equal((await service.modelBudgetStatus()).waiting.length, 0);
    assert.equal((await budget.status()).used, 0);
    assert.equal(runtime.calls.length, 0);
    await service.cancelRun(run.id);
    assert.equal((await service.workspace()).agents.find(item => item.id === agent.id)?.status, 'idle');
  });
}
