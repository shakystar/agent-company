import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentService } from '../server/service.ts';
import { StorageManager, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import type { ResourceScheduler } from '../server/resources.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import { resources, waitFor } from './operational-budget-fixture.ts';

type Internals = {
  store: WorkspaceStore;
  storage: StorageManager;
  scheduler: ResourceScheduler;
  executions: Map<string, { controller: AbortController }>;
  drainBackground(): Promise<void>;
  storageTick(): Promise<void>;
  scheduleInbox(): void;
  scheduleStorage(): void;
  inboxTimer?: ReturnType<typeof setTimeout>;
  storageTimer?: ReturnType<typeof setTimeout>;
  inboxPending?: Promise<void>;
  storagePending?: Promise<void>;
};

async function fixture(t: TestContext, blocked = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-storage-background-'));
  let freeBytes = blocked ? 0 : 100 * 1024 ** 3;
  const config: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'),
    ownerKey: randomUUID(), freeSpace: async () => freeBytes };
  class Runtime extends StorageFixtureRuntime {
    inspections = 0;
    override async inspect() { this.inspections++; return super.inspect(); }
  }
  const runtime = new Runtime(config.ownerKey);
  const create = async () => {
    const service = await AgentService.create({ dataDir: join(config.rootDir, 'db'), runtime, storage: config, scheduler: resources(4) });
    const internal = service as unknown as Internals;
    // These tests drive the production ticks explicitly. Do not also run a
    // wall-clock inbox/backup tick across a controlled quota transition.
    internal.scheduleInbox = () => undefined;
    internal.scheduleStorage = () => undefined;
    clearTimeout(internal.inboxTimer);
    clearTimeout(internal.storageTimer);
    await Promise.all([internal.inboxPending, internal.storagePending]);
    return service;
  };
  let service = await create();
  t.after(async () => {
    await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-storage-background-[^\\/]+$/);
    await rm(directory, { recursive: true });
  });
  return { runtime, get service() { return service; }, get internal() { return service as unknown as Internals; },
    setBlocked(value: boolean) { freeBytes = value ? 0 : 100 * 1024 ** 3; (service as unknown as Internals).storage.invalidate(); },
    async reopen() { await service.close(); service = await create(); } };
}

function observeChanges(store: WorkspaceStore) {
  let count = 0;
  const guard = store.writeGuard;
  store.writeGuard = () => { guard?.(); count++; };
  return () => count;
}

test('over-budget background loops preserve pending inbox, conversation, environment and discovery without writes; recovered space resumes them', async t => {
  const f = await fixture(t, true);
  const agents = await Promise.all(['inbox', 'conversation', 'environment', 'discovery'].map(name =>
    f.service.createAgent({ name, persona: 'No real model fixture' })));
  const team = await f.service.createTeam({ name: 'Space admission', memberIds: agents.map(agent => agent.id), autoDiscoverTasks: true });
  const scope = { type: 'team' as const, id: team.id };
  await f.service.collaboration('message_send', { scope, recipientAgentId: agents[0].id, content: 'Preserve pending message', idempotencyKey: randomUUID() });
  const room = await f.service.createConversation({ scope, title: 'Pending work', idempotencyKey: randomUUID() });
  await f.service.sendConversation(room.id, { mode: 'task', recipientAgentId: agents[1].id, content: 'Preserve delivery', idempotencyKey: randomUUID() });
  await f.service.proposeEnvironment(agents[2].id, { reason: 'Preserve queued build', spec: { packages: [], servers: [] } });
  await f.service.collaboration('task_create', { scope, title: 'Preserve open task', idempotencyKey: randomUUID() });
  // Force the operating-data ceiling itself, independently of the free-space guard.
  const originalLimit = f.internal.storage.limits.dataBytes;
  f.internal.storage.limits.dataBytes = 1;
  const before = await f.internal.store.read();
  const changes = observeChanges(f.internal.store), initialInspections = f.runtime.inspections;
  for (let index = 0; index < 8; index++) {
    await f.internal.drainBackground();
    await f.service.reconcileTaskDiscovery();
  }
  assert.equal(changes(), 0, 'Storage admission must return before a workspace mutation transaction');
  assert.equal(f.runtime.inspections, initialInspections, 'Blocked background work needs no runtime readiness poll');
  assert.deepEqual(await f.internal.store.read(), before);
  assert.equal(f.runtime.calls.length, 0);
  assert.match((await f.service.storageStatus()).reason!, /운영 데이터/);
  f.internal.storage.limits.dataBytes = originalLimit;
  f.setBlocked(false);
  await f.internal.drainBackground();
  const admissionStartedAt = Date.now();
  try {
    await waitFor(() => f.runtime.calls.length === 4, 'four preserved background admissions');
  } catch (cause) {
    const state = await f.internal.store.read();
    throw new Error(JSON.stringify({ expectedCalls: 4, elapsedMs: Date.now() - admissionStartedAt,
      resources: f.internal.scheduler.snapshot(),
      executions: [...f.internal.executions].map(([id, execution]) => ({ id, aborted: execution.controller.signal.aborted })),
      storageScanning: Boolean((f.internal.storage as unknown as { scanning?: Promise<unknown> }).scanning),
      calls: f.runtime.calls.map(call => ({ runId: call.input.run.id,
      agentId: call.input.agent.id, resources: call.input.resources, aborted: call.hooks.signal.aborted })), storageReason: f.internal.storage.reason,
      runs: state.runs.map(run => ({ id: run.id, agentId: run.agentId, kind: run.kind, status: run.status,
        error: run.error, recoveryReason: run.recoveryReason })),
      deliveries: state.conversationMessages.flatMap(message => message.deliveries),
      environments: state.environmentRevisions.map(revision => ({ status: revision.status, buildRunId: revision.buildRunId })),
      discoveries: state.taskDiscoveries }), { cause });
  }
  const after = await f.internal.store.read();
  assert.equal(after.runs.length, 4);
  assert.ok(agents.every(agent => after.runs.some(run => run.agentId === agent.id)));
  assert.equal(after.taskDiscoveries!.length, 1);
  assert.equal(after.environmentRevisions[0].buildRunId, after.runs.find(run => run.agentId === agents[2].id)!.id);
  assert.equal(f.internal.storage.reason, null);
  const allocated = f.internal.scheduler.snapshot();
  assert.equal(allocated.running.length, 4);
  assert.equal(allocated.waiting.length, 0);
  assert.deepEqual(allocated.reserved, { memoryMiB: 4096, cpus: 4 });
  for (const allocation of allocated.running) {
    assert.deepEqual(allocation.minimum, { memoryMiB: 1024, cpus: 1 });
    assert.deepEqual(allocation.preferred, allocation.minimum);
    assert.deepEqual(allocation.resources, allocation.minimum);
  }
  t.diagnostic(`All four admissions completed in ${Date.now() - admissionStartedAt} ms; each reserved 1024 MiB / 1 CPU, including the environment build.`);
});

test('completed historical inbox and an opted-in team without open tasks require neither runtime probes nor mutations', async t => {
  const f = await fixture(t, true);
  const agent = await f.service.createAgent({ name: 'History', persona: 'No real model' });
  const team = await f.service.createTeam({ name: 'Idle discovery', memberIds: [agent.id], autoDiscoverTasks: true });
  await f.service.collaboration('message_send', { scope: { type: 'team', id: team.id }, recipientAgentId: agent.id, content: 'Already handled', idempotencyKey: randomUUID() });
  await f.internal.store.change(state => { state.messages[0].status = 'completed'; });
  f.setBlocked(false);
  const changes = observeChanges(f.internal.store), inspections = f.runtime.inspections;
  for (let index = 0; index < 8; index++) await f.internal.drainBackground();
  assert.equal(changes(), 0);
  assert.equal(f.runtime.inspections, inspections);
  assert.equal(f.runtime.calls.length, 0);
});

test('storage suspension preserves checkpoints and completion while explicit pause and cancel win over automatic recovery', async t => {
  const f = await fixture(t);
  const agents = await Promise.all(['complete', 'pause', 'cancel', 'resume'].map(name =>
    f.service.createAgent({ name, persona: 'Checkpoint fixture' })));
  const runs = await Promise.all(agents.map(agent => f.service.startRun(agent.id, agent.name)));
  await waitFor(() => f.runtime.calls.length === 4);
  const calls = agents.map(agent => f.runtime.calls.find(call => call.input.agent.id === agent.id)!);
  f.setBlocked(true);
  await f.internal.drainBackground();
  for (const [index, call] of calls.entries()) {
    await call.hooks.onCheckpoint!({ phase: 'task', sessionId: `preserved-${index}`, appliedSteeringCount: 0 });
  }
  calls[0].finish();
  await waitFor(async () => (await f.internal.store.read()).runs.find(run => run.id === runs[0].id)?.status === 'succeeded');
  await f.service.pauseRun(runs[1].id);
  await f.service.cancelRun(runs[2].id);
  await f.internal.storageTick();
  await waitFor(async () => {
    const state = await f.internal.store.read();
    return state.runs.find(run => run.id === runs[1].id)?.status === 'paused'
      && state.runs.find(run => run.id === runs[3].id)?.status === 'queued';
  });
  const held = await f.internal.store.read();
  assert.equal(held.runs.find(run => run.id === runs[2].id)!.status, 'cancelled');
  for (const [index, run] of runs.entries()) assert.equal(held.executionStates[run.id].checkpoint?.sessionId, `preserved-${index}`);
  f.setBlocked(false);
  await f.internal.drainBackground();
  await waitFor(() => f.runtime.calls.length === 5, 'same suspended Run resumes');
  const resumed = f.runtime.calls[4];
  assert.equal(resumed.input.run.id, runs[3].id);
  assert.equal(resumed.input.checkpoint!.sessionId, 'preserved-3');
  resumed.finish();
  await waitFor(async () => (await f.internal.store.read()).runs.find(run => run.id === runs[3].id)?.status === 'succeeded');
  const final = await f.internal.store.read();
  assert.equal(final.runs.find(run => run.id === runs[1].id)!.status, 'paused');
  assert.equal(final.runs.find(run => run.id === runs[2].id)!.status, 'cancelled');
  assert.equal(final.runs.length, 4);
});

test('a durable complete checkpoint is applied after restart above quota without another model or resource reservation', async t => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ name: 'Complete recovery', persona: 'No repeat model' });
  const run = await f.service.startRun(agent.id, 'Preserve completed output');
  await waitFor(() => f.runtime.calls.length === 1);
  await f.runtime.calls[0].hooks.onCheckpoint!({ phase: 'complete', appliedSteeringCount: 0,
    previousResult: { result: 'Durable completed result', memories: [], skills: [], artifacts: [], inputTokens: 2, outputTokens: 1, appliedSteeringCount: 0 } });
  f.setBlocked(true);
  await f.reopen();
  await waitFor(async () => (await f.internal.store.read()).runs.find(item => item.id === run.id)?.status === 'succeeded');
  assert.equal(f.runtime.calls.length, 1);
  const state = await f.internal.store.read();
  assert.equal(state.runs[0].result, 'Durable completed result');
  assert.equal(state.runs[0].attempt, 1);
  assert.equal((await f.service.workspace()).resources!.reserved.memoryMiB, 0);
  assert.match((await f.service.storageStatus()).reason!, /여유 공간/);
});
