import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AgentService } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';
import type { WorkspaceStore, WorkspaceState } from '../server/store.ts';
import type { SharedArtifact } from '../shared/collaboration.ts';
import type { GrowthReplayProposal, GrowthVerdict } from '../shared/growth.ts';
import { growthTaskPrompt } from '../shared/growth.ts';
import { captureGrowthReplayInput, resolveGrowthReplay, validatePersistedGrowthReplay } from '../server/growth-replay.ts';
import { GrowthFixtureRuntime, growthResult, pairedEvidence, waitFor, type GrowthCall } from './growth-fixture.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nextSkill = (content = 'Verify a local form requirement') => ({ name: 'Source check', description: 'Local checking procedure',
  content, passed: true, evaluation: 'The author claim is not independent evidence' });
const proposal = (artifactId: string, prompt = 'Check the fixed source for missing labels'): GrowthReplayProposal => ({
  applicability: 'local', prompt, criteria: ['Required controls have associated labels'], artifactIds: [artifactId],
});
async function fixture(t: TestContext) {
  const runtime = new GrowthFixtureRuntime();
  const service = await AgentService.create({ runtime, recovery: { maxAttempts: 1 }, scheduler: new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
    defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } }) });
  t.after(() => service.close());
  const agent = await service.createAgent({ name: 'Snapshot author', persona: 'Source checks', model: 'fixture-growth-model', allowWeb: true });
  const team = await service.createTeam({ name: 'Snapshot scope', memberIds: [agent.id], autoDiscoverTasks: false });
  const scope = { type: 'team' as const, id: team.id };
  const artifact = await service.collaboration('artifact_publish', { scope, name: 'source.html', content: '<input required>', mediaType: 'text/html' }) as SharedArtifact;
  const state = () => (service as unknown as { store: WorkspaceStore }).store.read();
  return { runtime, service, agent, team, scope, artifact, state,
    async start(prompt: string) { const before = runtime.calls.length;
      const run = await service.startRun(agent.id, prompt, null, team.id);
      await waitFor(() => runtime.calls.length > before); return { run, call: runtime.calls.at(-1)! }; },
    async finish(runId: string) { await waitFor(async () => (await service.workspace()).runs.find(run => run.id === runId)?.status === 'succeeded'); return service.workspace(); },
  };
}
async function replayEvidence(call: GrowthCall, next: ReturnType<typeof nextSkill>, test: GrowthReplayProposal, verdict: GrowthVerdict = 'improved') {
  const evidence = await pairedEvidence(call, next, verdict, { usefulChanges: ['A reusable checking step'], failures: verdict === 'regressed' ? ['Misses a required condition'] : [] });
  const resolved = resolveGrowthReplay(call.input.growthReplay!, test, call.input.growth?.originalPrompt ?? growthTaskPrompt(call.input.run.prompt, call.input.run.steering));
  evidence.fingerprint.promptHash = hash(resolved.prompt); evidence.fingerprint.replayHash = resolved.replayHash;
  evidence.fingerprint.inputHash = hash({ prompt: resolved.prompt, persona: call.input.agent.persona,
    memories: call.input.memories.map(({ kind, title, content }) => ({ kind, title, content })),
    commonSkills: call.input.skills.filter(skill => skill.status === 'active' && skill.name !== next.name).map(({ name, description, content }) => ({ name, description, content })),
    sourceRunId: null, replayHash: resolved.replayHash });
  evidence.replay = test; evidence.replayApplicable = true; return evidence;
}

test('team admission captures only its scope and later artifact updates cannot alter the comparison source', async t => {
  const f = await fixture(t);
  const other = await f.service.createTeam({ name: 'Other allowed scope', memberIds: [f.agent.id], autoDiscoverTasks: false });
  await f.service.collaboration('artifact_publish', { scope: { type: 'team', id: other.id }, name: 'other.html', content: 'Do not capture', mediaType: 'text/html' });
  const { run, call } = await f.start('Check and publish the form');
  assert.deepEqual(call.input.growthReplay!.artifacts.map(item => item.id), [f.artifact.id]);
  const frozen = structuredClone(call.input.growthReplay!);
  await f.service.collaboration('artifact_publish', { scope: f.scope, artifactId: f.artifact.id, expectedVersion: 1, name: f.artifact.name, mediaType: f.artifact.mediaType, content: 'Later version' });
  const test = proposal(f.artifact.id), next = nextSkill();
  call.resolve(growthResult({ skills: [{ ...next, replay: test, comparison: await replayEvidence(call, next, test) }] }));
  const state = await f.finish(run.id);
  assert.equal(state.growthReviews!.find(review => review.sourceRunId === run.id)!.decision, 'activated');
  assert.deepEqual((await f.state()).executionStates[run.id].input.growthReplay, frozen);
  validatePersistedGrowthReplay(await f.state());
});

test('captured tasks reject downgraded legacy evidence and a different test than the candidate proposed', async t => {
  for (const scenario of ['legacy-downgrade', 'swapped-proposal']) await t.test(scenario, async sub => {
    const f = await fixture(sub), { run, call } = await f.start('Publish corrected output'), next = nextSkill();
    const expected = proposal(f.artifact.id), actual = proposal(f.artifact.id, 'An unrelated easier check');
    const proof = scenario === 'legacy-downgrade' ? await pairedEvidence(call, next, 'improved') : await replayEvidence(call, next, actual);
    call.resolve(growthResult({ skills: [{ ...next, replay: expected, comparison: proof }] }));
    const state = await f.finish(run.id), review = state.growthReviews!.find(item => item.sourceRunId === run.id)!;
    assert.equal(review.decision, 'kept'); assert.equal(review.verdict, 'inconclusive');
  });
});

test('automatic conversation freezes source after read-only routing and before the first actual task turn', async t => {
  const f = await fixture(t);
  const conversation = await f.service.createConversation({ scope: f.scope, title: 'Source task', idempotencyKey: randomUUID() });
  await f.service.sendConversation(conversation.id, { content: 'Inspect and correct the source', recipientAgentId: f.agent.id, mode: 'auto', idempotencyKey: randomUUID() });
  await waitFor(() => f.runtime.calls.length === 1);
  assert.equal(f.runtime.calls[0].input.run.interactionMode, 'auto'); assert.equal(f.runtime.calls[0].input.growthReplay, undefined);
  await f.service.collaboration('artifact_publish', { scope: f.scope, artifactId: f.artifact.id, expectedVersion: 1, name: f.artifact.name, mediaType: f.artifact.mediaType, content: 'Updated before task admission' });
  f.runtime.calls[0].resolve(growthResult({ route: 'task' }));
  await waitFor(() => f.runtime.calls.length === 2);
  const call = f.runtime.calls[1];
  assert.equal(call.input.run.interactionMode, 'task'); assert.ok(call.input.growthReplay);
  assert.equal(call.input.growthReplay.artifacts[0].version, 2); assert.equal(call.input.growthReplay.artifacts[0].content, 'Updated before task admission');
  call.resolve(growthResult()); await f.finish(call.input.run.id);
  validatePersistedGrowthReplay(await f.state());
});

test('regression review and repair retain the original concern test and source snapshot', async t => {
  const f = await fixture(t), first = await f.start('Create the initial local procedure');
  const initialProposal = proposal(f.artifact.id), next = nextSkill();
  first.call.resolve(growthResult({ skills: [{ ...next, replay: initialProposal, comparison: await replayEvidence(first.call, next, initialProposal) }] }));
  const initial = await f.finish(first.run.id), active = initial.skills.find(skill => skill.name === next.name)!;
  assert.ok(active);
  const concern = await f.start('The procedure misses a requirement on this new task'), concernProposal = proposal(f.artifact.id, 'Reproduce the missing invalid-input condition');
  const originalCapture = concern.call.input.growthReplay;
  concern.call.resolve(growthResult({ skillConcerns: [{ skillId: active.id, reason: 'Potential regression', evidence: 'Requires an independent test', replay: concernProposal }] }));
  await waitFor(() => f.runtime.calls.some(call => call.input.growth?.mode === 'review'));
  const reviewing = f.runtime.calls.find(call => call.input.growth?.mode === 'review')!;
  assert.deepEqual(reviewing.input.growth!.replay, concernProposal); assert.deepEqual(reviewing.input.growthReplay, originalCapture);
  const candidate = { ...next, content: reviewing.input.growth!.candidate.content };
  reviewing.resolve(growthResult({ growthReview: await replayEvidence(reviewing, candidate, concernProposal, 'regressed') }));
  await waitFor(() => f.runtime.calls.some(call => call.input.growth?.mode === 'repair'));
  const repairing = f.runtime.calls.find(call => call.input.growth?.mode === 'repair')!;
  assert.deepEqual(repairing.input.growth!.replay, concernProposal); assert.deepEqual(repairing.input.growthReplay, originalCapture);
  assert.equal(repairing.input.growth!.sourceRunId, concern.run.id);
  const repaired = nextSkill('Repaired procedure preserving the useful check');
  repairing.resolve(growthResult({ skills: [{ ...repaired, replay: concernProposal, comparison: await replayEvidence(repairing, repaired, concernProposal) }] }));
  const state = await f.finish(repairing.input.run.id);
  assert.deepEqual(state.growthReviews!.map(review => review.decision), ['activated', 'rolled_back', 'activated']);
  validatePersistedGrowthReplay(await f.state());
});

test('backup validation preserves legitimate steering drift but rejects changed source, history and ownership', async t => {
  const f = await fixture(t), { run, call } = await f.start('Fixed admission task');
  call.resolve(growthResult()); await f.finish(run.id);
  const baseline = await f.state();
  const changedSteering = structuredClone(baseline); changedSteering.runs.find(item => item.id === run.id)!.steering.push('Later accepted instruction');
  validatePersistedGrowthReplay(changedSteering);
  const variants: Array<(state: WorkspaceState) => void> = [
    state => { state.executionStates[run.id].input.growthReplay!.artifacts[0].content = 'Forged bytes'; },
    state => { state.sharedArtifacts[0].content = 'Lost historical source'; },
    state => { state.sharedArtifacts[0].scope.id = randomUUID(); },
    state => { state.executionStates[run.id].input.agent.id = randomUUID(); },
    state => { const input = state.executionStates[run.id].input; input.growthReplay = captureGrowthReplayInput({ ...input.growthReplay!, taskPrompt: 'Unrelated prompt' }); },
    state => { state.executionStates[run.id].input.growthReplayUnavailable = 'Conflicting unavailable state'; },
  ];
  for (const mutate of variants) { const state = structuredClone(baseline); mutate(state); assert.throws(() => validatePersistedGrowthReplay(state)); }
});
