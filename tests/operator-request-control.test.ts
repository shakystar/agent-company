import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentService } from '../server/service.ts';
import type { WorkspaceStore, WorkspaceState } from '../server/store.ts';
import { currentRun, runControlBlocked } from '../server/run-control.ts';
import { discoverableTasks, taskDiscoveryBlock } from '../server/task-discovery.ts';
import { validateOperatorRequestState } from '../server/operator-requests.ts';
import type { Project, TeamTask } from '../shared/collaboration.ts';
import type { OperatorRequest } from '../shared/operator-requests.ts';
import type { Run } from '../shared/types.ts';
import { OperationalFixtureRuntime, output, resources, waitFor, type BudgetCall } from './operational-budget-fixture.ts';

class ControlRuntime extends OperationalFixtureRuntime { readonly workspacePersistence = true; }
type Internals = { store: WorkspaceStore; executions: Map<string, unknown>; drainOperatorRequests(): Promise<void>; schedule(id: string): void };
const internal = (service: AgentService) => service as unknown as Internals;
const rejected = (status: number) => (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === status;

async function fixture(t: TestContext) {
  const runtime = new ControlRuntime();
  const service = await AgentService.create({ runtime, scheduler: resources(2), recovery: { maxAttempts: 1, retryDelayMs: 0 } });
  t.after(() => service.close());
  const agent = await service.createAgent({ name: 'Control fixture', persona: 'No actual model calls', allowWeb: false });
  const team = await service.createTeam({ name: 'Control team', memberIds: [agent.id] });
  const project = await service.collaboration('project_create', { name: 'Control project', teamIds: [team.id] }) as Project;
  const source = await service.startRun(agent.id, 'Keep root controls across verified continuations', project.id, team.id);
  await waitFor(() => runtime.calls.length === 1);
  const state = () => internal(service).store.read();
  const record = async (id: string) => (await state()).operatorRequests.find(item => item.id === id)!;
  const ready = async (call: BudgetCall) => {
    const request = await call.hooks.onTool!('operator_request_create', { scope: { type: 'project', id: project.id },
      category: 'other', title: 'Fixture input', reason: 'Input pending', requestedAction: 'Provide the fixture input',
      requestedScope: 'This fixture project', verificationCriteria: 'Operator observes the fixture input', idempotencyKey: randomUUID() }) as OperatorRequest;
    await call.hooks.onTool!('operator_request_wait', { requestId: request.id, reason: 'Waiting for verified input' });
    call.finish(output('Saved partial result'));
    await waitFor(async () => (await state()).runs.find(run => run.id === call.input.run.id)?.status === 'waiting');
    await waitFor(() => !internal(service).executions.has(call.input.run.id));
    runtime.available = false;
    await service.updateOperatorRequest(request.id, 'decide', { expectedVersion: (await record(request.id)).version, status: 'approved', reason: 'Fixture scope approved' });
    await service.updateOperatorRequest(request.id, 'progress', { expectedVersion: (await record(request.id)).version, status: 'verification_pending', detail: 'Fixture input ready' });
    await service.verifyOperatorRequest(request.id, { expectedVersion: (await record(request.id)).version, method: 'manual', evidence: 'Fixture observation', detail: 'Input checked' });
    return request;
  };
  const continueCall = async (call: BudgetCall) => {
    const request = await ready(call), count = runtime.calls.length;
    runtime.available = true; await internal(service).drainOperatorRequests();
    await waitFor(() => runtime.calls.length === count + 1);
    return { request, call: runtime.calls[count] };
  };
  return { service, runtime, agent, team, project, source, state, record, ready, continueCall };
}

test('root ID pauses and resumes its verified successor without changing historical source status', async t => {
  const f = await fixture(t); const continued = await f.continueCall(f.runtime.calls[0]);
  const paused = await f.service.pauseRun(f.source.id);
  assert.equal(paused.id, continued.call.input.run.id); assert.ok(paused.pauseRequestedAt);
  continued.call.finish(output('Checkpoint at user pause'));
  await waitFor(async () => currentRun(await f.state(), f.source.id)?.status === 'paused');
  await waitFor(() => !internal(f.service).executions.has(paused.id));
  const held = await f.state();
  assert.equal(held.runs.find(run => run.id === f.source.id)!.status, 'superseded');
  assert.equal(runControlBlocked(held, f.source.id), true);
  const resumed = await f.service.resumeRun(f.source.id);
  assert.equal(resumed.id, paused.id); assert.equal(resumed.pauseRequestedAt, null);
  await waitFor(async () => currentRun(await f.state(), f.source.id)?.status === 'succeeded');
  assert.equal(f.runtime.calls.length, 2, 'Complete checkpoint applies without manufacturing a new model call');
  assert.equal((await f.record(continued.request.id)).resumeReceipts.length, 1);
  validateOperatorRequestState(await f.state());
});

test('root ID steering and cancellation address the live successor and its worker', async t => {
  const f = await fixture(t); const continued = await f.continueCall(f.runtime.calls[0]);
  const steered = await f.service.steerRun(f.source.id, 'Root control follows the current execution');
  assert.equal(steered.id, continued.call.input.run.id);
  assert.equal(steered.steering.at(-1), 'Root control follows the current execution');
  const cancelled = await f.service.cancelRun(f.source.id);
  assert.equal(cancelled.id, continued.call.input.run.id); assert.equal(cancelled.status, 'cancelled');
  await waitFor(() => !internal(f.service).executions.has(cancelled.id));
  assert.equal(continued.call.hooks.signal.aborted, true);
  const state = await f.state(); assert.equal(state.runs.find(run => run.id === f.source.id)!.status, 'superseded');
  assert.equal(currentRun(state, f.source.id)?.id, cancelled.id); assert.equal(runControlBlocked(state, f.source.id), true);
  await assert.rejects(f.service.resumeRun(f.source.id), rejected(409));
  await internal(f.service).drainOperatorRequests();
  assert.equal((await f.state()).runs.length, 2); validateOperatorRequestState(await f.state());
});

test('cancelled continuation blocks discovery and delayed admission of tasks attributed to the original root', async t => {
  const f = await fixture(t); await f.continueCall(f.runtime.calls[0]);
  const peer = await f.service.createAgent({ name: 'Idle downstream member', persona: 'Fixture only' });
  await f.service.updateTeam(f.team.id, { memberIds: [f.agent.id, peer.id] });
  const state = await f.state(), date = new Date().toISOString();
  const task: TeamTask = { id: randomUUID(), scope: { type: 'project', id: f.project.id }, title: 'Downstream task', description: 'Same historical root', status: 'open',
    createdByAgentId: f.agent.id, assigneeAgentId: null, claimedRunId: null, version: 1, outcome: '', artifactIds: [],
    budgetRootRunId: f.source.id, budgetTeamId: f.team.id, budgetProjectId: f.project.id, createdAt: date, updatedAt: date, completedAt: null };
  state.teamTasks.push(task); state.teams.find(team => team.id === f.team.id)!.autoDiscoverTasks = true;
  assert.ok(discoverableTasks(state).some(candidate => candidate.agentId === peer.id && candidate.task.id === task.id));
  const discovery: Run = { ...structuredClone(f.source), id: randomUUID(), agentId: peer.id, status: 'queued',
    taskDiscovery: { taskId: task.id, taskVersion: 1, teamId: f.team.id }, budgetRootRunId: f.source.id };
  assert.equal(taskDiscoveryBlock(state, discovery), null);
  await f.service.cancelRun(f.source.id);
  const controlled = await f.state(); state.runs = controlled.runs;
  assert.equal(discoverableTasks(state).length, 0);
  assert.equal(taskDiscoveryBlock(state, discovery)?.terminal, true);
  assert.match(taskDiscoveryBlock(state, discovery)!.reason, /취소/);
  assert.equal(task.budgetRootRunId, f.source.id, 'Historical budget attribution remains unchanged');
});

test('two verified continuations resolve to the latest execution while missing or forged links fail closed', async t => {
  const f = await fixture(t); const first = await f.continueCall(f.runtime.calls[0]);
  const second = await f.continueCall(first.call), state = await f.state();
  assert.equal(currentRun(state, f.source.id)?.id, second.call.input.run.id);
  assert.equal(currentRun(state, first.call.input.run.id)?.id, second.call.input.run.id);
  assert.equal(state.runs.find(run => run.id === second.call.input.run.id)!.budgetRootRunId, f.source.id);
  assert.equal(runControlBlocked(state, f.source.id), false); validateOperatorRequestState(state);
  const badReceipt = structuredClone(state); badReceipt.operatorRequests.find(item => item.id === second.request.id)!.resumeReceipts = [];
  assert.equal(currentRun(badReceipt, f.source.id), undefined); assert.equal(runControlBlocked(badReceipt, f.source.id), true);
  const wrongAgent = structuredClone(state); wrongAgent.runs.find(run => run.id === second.call.input.run.id)!.agentId = randomUUID();
  assert.equal(currentRun(wrongAgent, f.source.id), undefined);
  const missingChild = structuredClone(state); missingChild.runs.find(run => run.id === f.source.id)!.continuedByRunId = randomUUID();
  assert.equal(currentRun(missingChild, f.source.id), undefined);
  const circular = structuredClone(state); circular.runs.find(run => run.id === second.call.input.run.id)!.continuedByRunId = f.source.id;
  assert.equal(currentRun(circular, f.source.id), undefined);
  const cancelled = await f.service.cancelRun(f.source.id); assert.equal(cancelled.id, second.call.input.run.id);
  assert.equal((await f.state()).runs.find(run => run.id === first.call.input.run.id)!.status, 'superseded');
  await internal(f.service).store.change(saved => { saved.runs.find(run => run.id === f.source.id)!.continuedByRunId = randomUUID(); });
  await assert.rejects(f.service.cancelRun(f.source.id), rejected(409));
});

test('cancellation queued behind an exclusive continuation commit resolves the child inside the mutation', async t => {
  const f = await fixture(t); const request = await f.ready(f.runtime.calls[0]);
  const service = internal(f.service), store = service.store;
  let release!: () => void, entered!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { entered = resolve; });
  const mutationObserved = new Promise<void>(resolve => { observed = resolve; });
  const lock = store.exclusive(async () => { entered(); await gate; });
  await held;
  const originalChange = store.change.bind(store), originalSchedule = service.schedule;
  // A test-only observation of the real serialized mutation boundary. The
  // production drain still creates and validates the continuation itself.
  store.change = (<T>(mutate: (state: WorkspaceState) => T) => { observed(); return originalChange(mutate); }) as WorkspaceStore['change'];
  service.schedule = () => {};
  t.after(() => { release(); store.change = originalChange; service.schedule = originalSchedule; });
  f.runtime.available = true;
  const draining = service.drainOperatorRequests();
  await mutationObserved;
  const cancelling = f.service.cancelRun(f.source.id);
  release(); await lock; await draining;
  const cancelled = await cancelling;
  store.change = originalChange; service.schedule = originalSchedule;
  const state = await f.state(), source = state.runs.find(run => run.id === f.source.id)!;
  assert.equal(source.status, 'superseded'); assert.ok(source.continuedByRunId);
  assert.equal(cancelled.id, source.continuedByRunId); assert.equal(cancelled.status, 'cancelled');
  assert.equal(currentRun(state, f.source.id)?.status, 'cancelled');
  assert.equal(f.runtime.calls.length, 1, 'Cancellation committed before the new worker could be scheduled');
  assert.equal((await f.record(request.id)).resumeReceipts.length, 1); validateOperatorRequestState(state);
});
