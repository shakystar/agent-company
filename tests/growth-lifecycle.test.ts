import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService, type ServiceOptions } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { WorkspaceStore } from '../server/store.ts';
import { BudgetPauseError } from '../shared/telemetry.ts';
import { GrowthFixtureRuntime, growthResult, modelAttempt, pairedEvidence, waitFor } from './growth-fixture.ts';

async function fixture(t: TestContext, persistent = false, beforeModelStart?: ServiceOptions['beforeModelStart']) {
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'ac-growth-lifecycle-')) : undefined;
  const runtime = new GrowthFixtureRuntime();
  const resources = () => new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
    defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });
  let scheduler = resources();
  let service = await AgentService.create({ runtime, scheduler, dataDir: directory, recovery: { maxAttempts: 1 }, beforeModelStart });
  let closed = false;
  t.after(async () => {
    if (!closed) await service.close();
    if (directory) {
      const suffix = relative(resolve(tmpdir()), resolve(directory));
      assert.ok(suffix.startsWith('ac-growth-lifecycle-') && !isAbsolute(suffix) && !suffix.split(/[\\/]/).includes('..'));
      const entry = await lstat(directory); assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      await rm(directory, { recursive: true });
    }
  });
  return { directory, runtime, get service() { return service; }, get scheduler() { return scheduler; },
    close: async () => { await service.close(); closed = true; },
    reopen: async () => {
      assert.ok(directory); if (!closed) await service.close();
      scheduler = resources();
      service = await AgentService.create({ runtime, scheduler, dataDir: directory, recovery: { maxAttempts: 1 }, beforeModelStart }); closed = false;
    } };
}
const nextSkill = (content = 'Candidate procedure') => ({ name: 'Verified procedure', description: 'A reusable task procedure',
  content, passed: true, evaluation: 'Author claim is not activation evidence' });
async function finished(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  await waitFor(async () => ['succeeded', 'failed', 'cancelled'].includes((await f.service.workspace()).runs.find(item => item.id === runId)!.status), 'terminal run');
  return f.service.workspace();
}

test('passed and verified claims cannot activate without all three matching persisted model attempts', async t => {
  const f = await fixture(t);
  const variants = [
    { recordCount: 0 }, { recordCount: 2 },
    { mutateAttempt: (attempt: ReturnType<typeof modelAttempt>, index: number) => { if (index === 2) attempt.phase = 'task'; } },
    { mutateAttempt: (attempt: ReturnType<typeof modelAttempt>, index: number) => { if (index === 0) attempt.status = 'failed'; } },
    { mutateAttempt: (attempt: ReturnType<typeof modelAttempt>, index: number) => { if (index === 1) attempt.model = 'other-model'; } },
  ];
  for (const [index, options] of variants.entries()) {
    const agent = await f.service.createAgent({ name: `No unchecked promotion ${index}`, persona: 'fixture', model: 'fixture-growth-model' });
    const run = await f.service.startRun(agent.id, 'Independent evidence required');
    await waitFor(() => f.runtime.calls.length > index);
    const call = f.runtime.calls[index], candidate = nextSkill();
    candidate.evaluation = 'Claimed successful evaluation';
    const comparison = await pairedEvidence(call, candidate, 'improved', options);
    call.resolve(growthResult({ skills: [{ ...candidate, comparison }] }));
    const state = await finished(f, run.id);
    assert.equal(state.runs.find(item => item.id === run.id)!.status, 'succeeded');
    assert.equal(state.skills.filter(item => item.agentId === agent.id && item.status === 'active').length, 0);
    assert.equal(state.growthReviews!.find(item => item.sourceRunId === run.id)!.verdict, 'inconclusive');
    assert.equal(state.skillRevisions!.filter(item => item.agentId === agent.id).length, 1);
    assert.equal(state.repairJobs!.filter(item => item.agentId === agent.id).length, 0);
  }
});

test('paired records activate a skill, independently confirm regression, and repair against preserved input before reactivation', async t => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ name: 'Lifecycle', persona: 'Same persona', model: 'fixture-growth-model' });
  const original = await f.service.addSkill(agent.id, { ...nextSkill('Original known procedure') });
  const first = await f.service.startRun(agent.id, 'Learn a bounded procedure');
  await waitFor(() => f.runtime.calls.length === 1);
  const firstCall = f.runtime.calls[0], learned = nextSkill('Learned procedure');
  firstCall.resolve(growthResult({ memories: [{ kind: 'fact', title: 'Retained user knowledge', content: 'Keep across rollback' }],
    skills: [{ ...learned, comparison: await pairedEvidence(firstCall, learned, 'improved') }] }));
  let state = await finished(f, first.id);
  const active = state.skills.find(item => item.id === original.id)!; assert.equal(active.content, learned.content);
  const activeRevisionId = active.activeRevisionId;
  const task = await f.service.startRun(agent.id, 'The original regression task');
  await waitFor(() => f.runtime.calls.length === 2);
  f.runtime.calls[1].resolve(growthResult({ skillConcerns: [{ skillId: original.id, reason: 'Suspected regression', evidence: 'Needs independent checking' }] }));
  await finished(f, task.id);
  await waitFor(() => f.runtime.calls.some(call => call.input.growth?.mode === 'review'), 'automatic independent review');
  const reviewCall = f.runtime.calls.find(call => call.input.growth?.mode === 'review')!;
  assert.equal((await f.service.workspace()).skills.find(item => item.id === original.id)!.activeRevisionId, activeRevisionId,
    'an author concern must not itself roll back the skill');
  assert.equal(reviewCall.input.growth!.originalPrompt, 'The original regression task');
  const proof = await pairedEvidence(reviewCall, reviewCall.input.growth!.candidate, 'regressed',
    { usefulChanges: ['Reusable safe substep'], failures: ['Completion regressed on the task'] });
  reviewCall.resolve(growthResult({ growthReview: proof, memories: [{ kind: 'fact', title: 'Evaluator memory must not leak', content: 'Not user knowledge' }] }));
  await finished(f, reviewCall.input.run.id);
  await waitFor(() => f.runtime.calls.some(call => call.input.growth?.mode === 'repair'), 'automatic repair');
  const repairCall = f.runtime.calls.find(call => call.input.growth?.mode === 'repair')!;
  state = await f.service.workspace();
  assert.equal(state.skills.find(item => item.id === original.id)!.content, original.content);
  assert.equal(state.memories.length, 1); assert.equal(state.memories[0].content, 'Keep across rollback');
  assert.equal(repairCall.input.growth!.originalPrompt, 'The original regression task');
  assert.deepEqual(repairCall.input.growth!.feedback?.usefulChanges, ['Reusable safe substep']);
  assert.deepEqual(repairCall.input.growth!.feedback?.failures, ['Completion regressed on the task']);
  assert.equal(repairCall.input.growth!.baseline!.content, original.content);
  const repaired = nextSkill('Independently repaired procedure');
  repairCall.resolve(growthResult({ skills: [{ ...repaired, comparison: await pairedEvidence(repairCall, repaired, 'improved') }] }));
  state = await finished(f, repairCall.input.run.id);
  assert.equal(state.skills.find(item => item.id === original.id)!.content, repaired.content);
  assert.deepEqual(state.growthReviews!.map(item => item.decision), ['activated', 'rolled_back', 'activated']);
  assert.equal(state.repairJobs![0].status, 'resolved'); assert.equal(state.repairJobs![0].attempts, 1);
  assert.equal(state.repairJobs![0].sourceRunId, task.id, 'repair must retain the original user task, not the intermediate review run');
  assert.equal(state.skillRevisions!.length, 3);
  assert.equal(state.modelAttempts!.length, 9); assert.equal(state.memories.length, 1);
});

test('selected snapshot forks have independent revision and memory identities while the source remains unchanged', async t => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ name: 'Original', persona: 'Source persona', model: 'fixture-growth-model' });
  await f.service.addMemory(agent.id, { kind: 'fact', title: 'Source', content: 'Original memory' });
  await f.service.addSkill(agent.id, { name: 'Procedure', description: 'Original', content: 'Original body' });
  const snapshot = await f.service.createSnapshot(agent.id, 'Chosen branch point');
  const before = await f.service.workspace();
  const clone = await f.service.forkAgent(agent.id, { name: 'Clone', persona: 'Independent persona', snapshotId: snapshot.id });
  const after = await f.service.workspace();
  const sourceSkill = after.skills.find(item => item.agentId === agent.id)!, cloneSkill = after.skills.find(item => item.agentId === clone.id)!;
  assert.notEqual(cloneSkill.id, sourceSkill.id); assert.notEqual(cloneSkill.activeRevisionId, sourceSkill.activeRevisionId);
  const cloneRevision = after.skillRevisions!.find(item => item.id === cloneSkill.activeRevisionId)!;
  assert.equal(cloneRevision.inheritedFrom!.revisionId, sourceSkill.activeRevisionId);
  await f.service.addSkill(clone.id, { name: cloneSkill.name, description: 'Only clone changes', content: 'Clone body' });
  const final = await f.service.workspace();
  assert.deepEqual(final.skills.filter(item => item.agentId === agent.id), before.skills.filter(item => item.agentId === agent.id));
  assert.deepEqual(final.skillRevisions!.filter(item => item.agentId === agent.id), before.skillRevisions!.filter(item => item.agentId === agent.id));
  assert.deepEqual(final.snapshots.find(item => item.id === snapshot.id), before.snapshots.find(item => item.id === snapshot.id));
  assert.notEqual(final.memories.find(item => item.agentId === clone.id)!.id, final.memories.find(item => item.agentId === agent.id)!.id);
});

test('BudgetPauseError preserves checkpoint and partial usage without keeping CPU resources or restarting after controller reopen', async t => {
  const f = await fixture(t, true);
  const agent = await f.service.createAgent({ name: 'Budget wait', persona: 'fixture', model: 'fixture-growth-model' });
  const run = await f.service.startRun(agent.id, 'Preserve completed phase');
  await waitFor(() => f.runtime.calls.length === 1);
  const call = f.runtime.calls[0];
  const attempt = modelAttempt(call, 'task'); await call.hooks.onAttempt!(attempt);
  await call.hooks.onCheckpoint!({ phase: 'evaluate', previousResult: growthResult({ result: 'Saved work' }),
    growthProgress: { completedBaseline: { id: 'durable-progress' } } });
  call.reject(new BudgetPauseError('Explicit campaign model allowance exhausted'));
  await waitFor(async () => Boolean((await f.service.workspace()).runs.find(item => item.id === run.id)?.modelBudgetPaused));
  await waitFor(() => f.scheduler.snapshot().reserved.memoryMiB === 0);
  let current = (await f.service.workspace()).runs.find(item => item.id === run.id)!;
  assert.equal(current.status, 'queued'); assert.equal(current.inputTokens, 17); assert.equal(current.outputTokens, 3);
  await f.close();
  const stored = await WorkspaceStore.open(f.directory!);
  try {
    const state = await stored.read();
    assert.equal(state.executionStates[run.id].checkpoint!.previousResult!.result, 'Saved work');
    assert.deepEqual(state.executionStates[run.id].checkpoint!.growthProgress, { completedBaseline: { id: 'durable-progress' } });
    assert.equal(state.runs.find(item => item.id === run.id)!.modelBudgetPaused, true);
  } finally { await stored.close(); }
  await f.reopen(); await delay(50);
  current = (await f.service.workspace()).runs.find(item => item.id === run.id)!;
  assert.equal(current.status, 'queued'); assert.equal(current.modelBudgetPaused, true);
  assert.equal(f.runtime.calls.length, 1); assert.equal(f.scheduler.snapshot().reserved.memoryMiB, 0);
  assert.equal((await f.service.workspace()).modelAttempts!.find(item => item.id === attempt.id)!.usage.inputTokens, 17);
});

test('failed and cancelled executions retain actual partial attempt usage and terminal attempt status', async t => {
  const f = await fixture(t);
  for (const [index, status] of ['failed', 'cancelled'].entries()) {
    const agent = await f.service.createAgent({ name: status, persona: 'fixture', model: 'fixture-growth-model' });
    const run = await f.service.startRun(agent.id, 'Observed attempted work');
    await waitFor(() => f.runtime.calls.length > index);
    const call = f.runtime.calls[index];
    const attempt = modelAttempt(call, 'task', { status: status as 'failed' | 'cancelled', error: 'Fixture interruption',
      usage: { status: 'partial', inputTokens: 42, outputTokens: 7, cachedInputTokens: null, reasoningOutputTokens: null } });
    await call.hooks.onAttempt!(attempt);
    if (status === 'cancelled') await f.service.cancelRun(run.id); else call.reject(new Error('Fixture failure'));
    const state = await finished(f, run.id), saved = state.runs.find(item => item.id === run.id)!;
    assert.equal(saved.status, status); assert.equal(saved.inputTokens, 42); assert.equal(saved.outputTokens, 7);
    assert.equal(state.modelAttempts!.find(item => item.id === attempt.id)!.status, status);
    assert.equal(state.modelAttempts!.find(item => item.id === attempt.id)!.usage.status, 'partial');
  }
});

test('cancelling automatic repair holds that repair and cannot restart it after a controller reopen', async t => {
  const f = await fixture(t, true);
  const agent = await f.service.createAgent({ name: 'Cancel repair', persona: 'fixture', model: 'fixture-growth-model' });
  const run = await f.service.startRun(agent.id, 'Introduce a candidate');
  await waitFor(() => f.runtime.calls.length === 1);
  const next = nextSkill(), call = f.runtime.calls[0];
  call.resolve(growthResult({ skills: [{ ...next, comparison: await pairedEvidence(call, next, 'improved') }] }));
  let state = await finished(f, run.id); const skill = state.skills.find(item => item.agentId === agent.id)!;
  const review = await f.service.reviewSkill(skill.id, run.id);
  await waitFor(() => f.runtime.calls.length === 2);
  const reviewCall = f.runtime.calls[1];
  reviewCall.resolve(growthResult({ growthReview: await pairedEvidence(reviewCall, reviewCall.input.growth!.candidate, 'regressed') }));
  await finished(f, review.id);
  await waitFor(() => f.runtime.calls.length === 3, 'automatic repair before cancellation');
  const repair = f.runtime.calls[2]; assert.equal(repair.input.growth?.mode, 'repair');
  await repair.hooks.onAttempt!(modelAttempt(repair, 'repair', { status: 'cancelled',
    usage: { status: 'partial', inputTokens: 8, outputTokens: 2, cachedInputTokens: null, reasoningOutputTokens: null } }));
  await f.service.cancelRun(repair.input.run.id);
  await finished(f, repair.input.run.id);
  await f.reopen(); await delay(50);
  state = await f.service.workspace();
  assert.equal(state.repairJobs![0].status, 'held'); assert.match(state.repairJobs![0].reason, /취소/);
  assert.equal(state.runs.find(item => item.id === repair.input.run.id)!.status, 'cancelled');
  assert.equal(state.runs.find(item => item.id === repair.input.run.id)!.inputTokens, 8);
  assert.equal(f.runtime.calls.length, 3); assert.equal(state.skills.some(item => item.agentId === agent.id && item.status === 'active'), false);
});

test('terminal repair failure leaves a held repair with evidence, never a permanently running job', async t => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ name: 'Failed repair', persona: 'fixture', model: 'fixture-growth-model' });
  const run = await f.service.startRun(agent.id, 'Original comparison task');
  await waitFor(() => f.runtime.calls.length === 1);
  const next = nextSkill(), initial = f.runtime.calls[0];
  initial.resolve(growthResult({ skills: [{ ...next, comparison: await pairedEvidence(initial, next, 'improved') }] }));
  const initialState = await finished(f, run.id);
  const skill = initialState.skills.find(item => item.agentId === agent.id)!;
  const review = await f.service.reviewSkill(skill.id, run.id);
  await waitFor(() => f.runtime.calls.length === 2);
  const checking = f.runtime.calls[1];
  checking.resolve(growthResult({ growthReview: await pairedEvidence(checking, checking.input.growth!.candidate, 'regressed',
    { failures: ['Independent regression finding'] }) }));
  await finished(f, review.id);
  await waitFor(() => f.runtime.calls.length === 3);
  const repair = f.runtime.calls[2];
  await repair.hooks.onAttempt!(modelAttempt(repair, 'repair', { status: 'failed', error: 'Fixture repair process failed',
    usage: { status: 'partial', inputTokens: 13, outputTokens: 4, cachedInputTokens: null, reasoningOutputTokens: null } }));
  repair.reject(new Error('Fixture repair process failed'));
  const state = await finished(f, repair.input.run.id);
  assert.equal(state.runs.find(item => item.id === repair.input.run.id)!.status, 'failed');
  assert.equal(state.runs.find(item => item.id === repair.input.run.id)!.inputTokens, 13);
  assert.equal(state.repairJobs![0].status, 'held');
  assert.ok(state.repairJobs![0].reason.includes('실패') || state.repairJobs![0].reason.includes('failed'));
  assert.deepEqual(state.repairJobs![0].failures, ['Independent regression finding']);
  assert.equal(state.agents.find(item => item.id === agent.id)!.status, 'idle');
});

test('explicit budget resume retries the existing gate without resetting its ledger and resumes the saved checkpoint only when allowed', { timeout: 15_000 }, async t => {
  const ledger = { started: 0, limit: 1 };
  const f = await fixture(t, false, async () => {
    if (ledger.started >= ledger.limit) throw new BudgetPauseError('Fixture model allowance exhausted');
    ledger.started += 1;
  });
  const agent = await f.service.createAgent({ name: 'Explicit budget resume', persona: 'fixture', model: 'fixture-growth-model' });
  const run = await f.service.startRun(agent.id, 'Continue only unfinished work');
  await waitFor(() => f.runtime.calls.length === 1);
  const first = f.runtime.calls[0];
  await assert.rejects(f.service.resumeBudgetRun(run.id), { statusCode: 409 });
  await first.hooks.beforeModelStart!({ runId: run.id, phase: 'task', kind: 'fixture-task', reason: 'Initial phase' });
  await first.hooks.onAttempt!(modelAttempt(first, 'task'));
  await first.hooks.onCheckpoint!({ phase: 'evaluate', previousResult: growthResult({ result: 'Completed task must not be replayed' }),
    growthProgress: { taskAlreadyCompleted: true } });
  let firstDenial: Error | undefined;
  try { await first.hooks.beforeModelStart!({ runId: run.id, phase: 'evaluate', kind: 'fixture-judge', reason: 'Unfinished phase' }); }
  catch (error) { assert.ok(error instanceof BudgetPauseError); firstDenial = error; }
  assert.ok(firstDenial); first.reject(firstDenial);
  await waitFor(async () => Boolean((await f.service.workspace()).runs.find(item => item.id === run.id)!.modelBudgetPaused));
  await waitFor(() => f.scheduler.snapshot().reserved.memoryMiB === 0);
  assert.equal(ledger.started, 1);

  await f.service.resumeBudgetRun(run.id);
  await waitFor(() => f.runtime.calls.length === 2);
  const deniedResume = f.runtime.calls[1];
  assert.equal(deniedResume.input.checkpoint!.previousResult!.result, 'Completed task must not be replayed');
  let secondDenial: Error | undefined;
  try { await deniedResume.hooks.beforeModelStart!({ runId: run.id, phase: 'evaluate', kind: 'fixture-judge', reason: 'Still over budget' }); }
  catch (error) { assert.ok(error instanceof BudgetPauseError); secondDenial = error; }
  assert.ok(secondDenial); deniedResume.reject(secondDenial);
  await waitFor(async () => Boolean((await f.service.workspace()).runs.find(item => item.id === run.id)!.modelBudgetPaused));
  await waitFor(() => f.scheduler.snapshot().reserved.memoryMiB === 0);
  assert.equal(ledger.started, 1); assert.equal((await f.service.workspace()).modelAttempts!.length, 1);

  ledger.limit = 2;
  await f.service.resumeBudgetRun(run.id);
  await waitFor(() => f.runtime.calls.length === 3);
  const allowed = f.runtime.calls[2];
  assert.equal(allowed.input.run.id, run.id);
  assert.deepEqual(allowed.input.checkpoint!.growthProgress, { taskAlreadyCompleted: true });
  await allowed.hooks.beforeModelStart!({ runId: run.id, phase: 'evaluate', kind: 'fixture-judge', reason: 'Additional allowance granted' });
  await allowed.hooks.onAttempt!(modelAttempt(allowed, 'evaluate'));
  allowed.resolve(growthResult({ result: 'Finished the remaining phase' }));
  const completed = await finished(f, run.id);
  assert.equal(completed.runs.find(item => item.id === run.id)!.status, 'succeeded');
  assert.equal(completed.runs.find(item => item.id === run.id)!.modelBudgetPaused, false);
  assert.equal(ledger.started, 2); assert.equal(completed.modelAttempts!.length, 2);
  assert.equal(completed.modelAttempts!.filter(item => item.phase === 'task').length, 1);
  await assert.rejects(f.service.resumeBudgetRun(run.id), { statusCode: 409 });

  const cancelled = await f.service.startRun(agent.id, 'A cancelled run is never a budget resume');
  await waitFor(() => f.runtime.calls.length === 4);
  const cancelling = f.runtime.calls[3];
  cancelling.reject(new BudgetPauseError('Pause before cancellation'));
  await waitFor(async () => Boolean((await f.service.workspace()).runs.find(item => item.id === cancelled.id)!.modelBudgetPaused));
  await f.service.cancelRun(cancelled.id);
  await assert.rejects(f.service.resumeBudgetRun(cancelled.id), { statusCode: 409 });
  assert.equal((await f.service.workspace()).runs.find(item => item.id === cancelled.id)!.status, 'cancelled');
  assert.equal(f.runtime.calls.length, 4); assert.equal(ledger.started, 2);
});
