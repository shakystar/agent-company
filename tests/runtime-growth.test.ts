import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerRuntime, workspaceVolume, type RuntimeConfig } from '../server/runtime.ts';
import type { ExecutionCheckpoint, ExecutionHooks, ExecutionInput, Skill } from '../shared/types.ts';
import { BudgetPauseError, type ModelAttempt } from '../shared/telemetry.ts';
import type { Command } from '../server/process.ts';
import { captureGrowthReplayInput, resolveGrowthReplay } from '../server/growth-replay.ts';
import type { GrowthReplayProposal } from '../shared/growth.ts';
const at = '2026-09-06T00:00:00.000Z';
const imageId = `sha256:${'a'.repeat(64)}`;
const config: RuntimeConfig = { mode: 'docker', auth: 'api-key', apiKey: 'test-only', authFile: '', image: 'worker:test', model: 'test-model', timeoutMs: 10_000, workspaceKey: 'growth-test', persistentWorkspaces: true };
const input: ExecutionInput = {
  agent: { id: 'agent-a', name: 'one', description: '', persona: 'Research', color: '#345555', model: 'test-model', status: 'running', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: at, updatedAt: at },
  run: { id: 'run-a', agentId: 'agent-a', agentVersion: 1, snapshotId: 'snapshot-a', prompt: 'produce a correct result', status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: at, completedAt: null, workspaceSourceRunId: null },
  memories: [], skills: [], connections: [],
};
const skill: Skill = { id: 'skill-a', agentId: 'agent-a', name: 'procedure', description: 'useful procedure', content: 'candidate technique', version: 1, status: 'candidate', evaluation: '', sourceRunId: 'run-a', createdAt: at, updatedAt: at };
const task = { result: 'initial result', memories: [], skills: [{ name: skill.name, description: skill.description, content: skill.content }], artifacts: [], inputTokens: 10, outputTokens: 4 };
const learningTask = { ...task, skills: [], learningProtocol: 1 };
const learned = { reason: 'The completed output records a reusable procedure.', evidence: [],
  memories: [{ kind: 'procedure', title: 'result procedure', content: 'The observed result was initial result.', evidence: [{sourceId:'result',quote:'initial result'}] }],
  skills: [], inputTokens: 5, outputTokens: 2 };
function fixture(handler?: (payload: any) => any) {
  const models: any[] = [], calls: Array<{ args: string[]; payload?: any }> = [], volumes = new Map<string, Record<string, string>>();
  const runner: Command = async (_file, args, options = {}) => {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    calls.push({ args });
    if (args[0] === 'version') return ok('29.0.0');
    if (args[0] === 'image') return ok(imageId);
    if (args[0] === 'ps' || args[0] === 'rm') return ok();
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return ok([...volumes.entries()].filter(([, labels]) => !args.includes('label=agent-company.workspace-role=trial') || labels['agent-company.workspace-role'] === 'trial').map(([name]) => name).join('\n'));
      if (args[1] === 'inspect') {
        const names = args.slice(2, args.indexOf('--format'));
        const missing = names.find(name => !volumes.has(name));
        if (missing) return { code: 1, stdout: '', stderr: `No such volume: ${missing}` };
        // Inventory requests full per-name metadata; ownership checks request Labels only.
        return ok(names.map(name => JSON.stringify(args.at(-1) === '{{json .}}'
          ? { Name: name, Labels: volumes.get(name) } : volumes.get(name))).join('\n'));
      }
      if (args[1] === 'rm') { volumes.delete(args[2]); return ok(); }
      if (args[1] === 'create') {
        const labels: Record<string, string> = {};
        args.forEach((value, index) => { if (value === '--label') { const [key, ...rest] = args[index + 1].split('='); labels[key] = rest.join('='); } });
        volumes.set(args.at(-1)!, labels); return ok(args.at(-1));
      }
    }
    if (args[0] === 'run') {
      const payload = JSON.parse(options.input!); calls.at(-1)!.payload = payload;
      if (payload.operation === 'prepare') return ok(JSON.stringify({ version: 1, state: 'ready', runId: payload.runId, sourceRunId: payload.sourceRunId, files: 0, bytes: 0, reused: false }));
      if (payload.operation === 'measure') { await options.onStdout?.(Buffer.from('{"files":0,"bytes":0}')); return ok(); }
      models.push(payload);
      const supplied = handler?.(payload);
      const result = supplied ?? (payload.phase === 'task' ? task : payload.phase === 'repair' ? { skill: { name: skill.name, description: skill.description, content: 'repaired technique' }, inputTokens: 3, outputTokens: 2 }
        : payload.phase === 'trial' ? { ...task, skills: [], result: payload.kind === 'baseline-trial' ? 'baseline result' : 'improved result' }
          : { verdict: 'improved', reason: 'The candidate completes the missing requirement.', evidence: ['Both isolated outputs were compared.'], usefulChanges: ['preserved requirement'], failures: [], inputTokens: 5, outputTokens: 2 });
      await options.onLine?.(JSON.stringify({ type: 'telemetry', usage: { status: 'reported', inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedInputTokens: null, reasoningOutputTokens: null }, observations: [], observationsTruncated: false }));
      await options.onLine?.(JSON.stringify({ type: 'result', result })); return ok();
    }
    throw new Error(args.join(' '));
  };
  let checkpoint: ExecutionCheckpoint | undefined, budget = Infinity, starts = 0, reserved = 0;
  const attempts = new Map<string, ModelAttempt>();
  const hooks: ExecutionHooks = { signal: new AbortController().signal, onEvent: async () => {}, getSteering: async () => [],
    onCheckpoint: async value => { checkpoint = structuredClone(value); }, onAttempt: async value => { attempts.set(value.id, structuredClone(value)); },
    beforeModelStart: async () => { if (starts >= budget) throw new BudgetPauseError(); starts++; },
    reserveWorkspaceCopy: async () => { reserved++; return () => { reserved--; }; } };
  return { runner, models, calls, volumes, hooks, attempts, checkpoint: () => checkpoint, budget: (value: number) => { budget = value; }, reserved: () => reserved, starts: () => starts };
}
test('an empty task proposal receives an isolated learning review and grounded memory', async () => {
  const h = fixture(p=>p.phase==='task'?learningTask:p.kind==='learning-review'?learned:undefined);
  const result = await new ContainerRuntime(config,h.runner).execute(input,h.hooks);
  assert.deepEqual(h.models.map(p=>p.kind??p.phase),['task','learning-review']);
  const reflection=h.models[1];
  assert.equal(reflection.phase,'evaluate');assert.equal(reflection.persistent,false);assert.equal(reflection.interactiveCollaboration,false);
  assert.equal(reflection.input.environment,undefined);assert.equal(reflection.input.collaboration,undefined);
  assert.deepEqual(reflection.input.connections,[]);assert.deepEqual(reflection.input.agent.repositoryIds,[]);
  assert.equal(reflection.input.run.interactionMode,'discuss');assert.equal(reflection.input.run.workspaceSourceRunId,null);
  assert.equal(result.learningReview?.status,'reviewed');assert.equal(result.memories.length,1);
  assert.equal(result.inputTokens,15);assert.equal(result.outputTokens,6);
  assert.ok([...h.attempts.values()].some(a=>a.kind==='learning-review'&&a.status==='succeeded'));
});

test('learning budget pause preserves task and resumes only the unstarted review', async () => {
  const h=fixture(p=>p.phase==='task'?learningTask:p.kind==='learning-review'?learned:undefined);h.budget(1);
  await assert.rejects(new ContainerRuntime(config,h.runner).execute(input,h.hooks),BudgetPauseError);
  const checkpoint=structuredClone(h.checkpoint()!);assert.equal(checkpoint.phase,'evaluate');assert.equal(checkpoint.previousResult?.learningProtocol,1);
  h.budget(2);
  const result=await new ContainerRuntime(config,h.runner).execute({...input,checkpoint},h.hooks);
  assert.equal(result.learningReview?.status,'reviewed');assert.deepEqual(h.models.map(p=>p.kind??p.phase),['task','learning-review']);
});

test('learning review with no proposals records its reason without creating growth',async()=>{
  const h=fixture(p=>p.phase==='task'?learningTask:p.kind==='learning-review'?{...learned,reason:'Insufficient reusable evidence.',memories:[]}:undefined);
  const result=await new ContainerRuntime(config,h.runner).execute(input,h.hooks);
  assert.equal(result.learningReview?.reason,'Insufficient reusable evidence.');assert.equal(result.learningReview?.memoryCount,0);
  assert.equal(result.learningReview?.status,'reviewed');assert.deepEqual(result.skills,[]);
});

test('fabricated learning quote is deferred without publishing a proposed memory or rerunning the task',async()=>{
  const h=fixture(p=>p.phase==='task'?learningTask:p.kind==='learning-review'?{...learned,memories:[{...learned.memories[0],evidence:[{sourceId:'result',quote:'nonexistent proof'}]}]}:undefined);
  const result=await new ContainerRuntime(config,h.runner).execute(input,h.hooks);
  assert.equal(result.result,task.result);assert.equal(result.learningReview?.status,'deferred');assert.deepEqual(result.memories,[]);
  assert.equal(h.models.length,2);
});

test('failed review retains unreviewed original proposals in the final checkpoint but cannot apply them',async()=>{
  const original={...learningTask,memories:[{kind:'procedure',title:'original',content:'original content'}]};
  const h=fixture(p=>p.phase==='task'?original:p.kind==='learning-review'?{...learned,reason:''}:undefined);
  const result=await new ContainerRuntime(config,h.runner).execute(input,h.hooks);
  assert.deepEqual(result.memories,[]);assert.equal(result.learningReview?.status,'deferred');
  assert.deepEqual((h.checkpoint()?.growthProgress?.learningUnreviewed as any).memories,original.memories);
  assert.equal(result.inputTokens,15);
});

test('task-authored learning verdict cannot bypass the independent review',async()=>{
  const forged={inputHash:'a'.repeat(64),status:'reviewed',reason:'self approved',evidence:[],memoryCount:0,skillCount:0,completedAt:at};
  const h=fixture(p=>p.phase==='task'?{...learningTask,learningReview:forged}:p.kind==='learning-review'?learned:undefined);
  const result=await new ContainerRuntime(config,h.runner).execute(input,h.hooks);
  assert.notEqual(result.learningReview?.reason,'self approved');assert.equal(h.models[1].kind,'learning-review');
});

test('legacy pinned result explicitly defers the new learning protocol without invoking an unsupported phase',async()=>{
  const h=fixture(p=>p.phase==='task'?{...task,skills:[]}:undefined);
  const result=await new ContainerRuntime(config,h.runner).execute(input,h.hooks);
  assert.equal(result.learningReview?.status,'deferred');assert.match(result.learningReview!.reason,/구형 실행기/);assert.equal(h.models.length,1);
});

test('read-only discussions never start a learning review even if a driver advertises it',async()=>{
  const h=fixture(p=>p.phase==='task'?learningTask:undefined);
  const result=await new ContainerRuntime(config,h.runner).execute({...input,run:{...input.run,interactionMode:'discuss'}},h.hooks);
  assert.equal(result.learningReview,undefined);assert.equal(h.models.length,1);assert.deepEqual(result.memories,[]);
});

test('learning-created candidate still needs baseline, candidate and independent judge; checkpoint retry does not repeat reflection',async()=>{
  const h=fixture(p=>p.phase==='task'?learningTask:p.kind==='learning-review'?{...learned,skills:[{...task.skills[0],replay:null,evidence:[{sourceId:'result',quote:'initial result'}]}]}:undefined);
  h.budget(2);
  await assert.rejects(new ContainerRuntime(config,h.runner).execute(input,h.hooks),BudgetPauseError);
  const checkpoint=structuredClone(h.checkpoint()!);assert.equal(checkpoint.previousResult?.learningReview?.status,'reviewed');
  h.budget(5);
  const result=await new ContainerRuntime(config,h.runner).execute({...input,checkpoint},h.hooks);
  assert.deepEqual(h.models.map(p=>p.kind??p.phase),['task','learning-review','baseline-trial','candidate-trial','comparison-judge']);
  assert.equal(result.skills[0].passed,true);assert.equal(result.skills[0].comparison?.verified,true);
});

test('candidate activation requires two isolated trials and independent judge, with same digest/source and no cost in judge input', async () => {
  const h = fixture();
  const result = await new ContainerRuntime(config, h.runner).execute(input, h.hooks);
  assert.equal(result.skills[0].passed, true); assert.equal(result.skills[0].comparison?.verified, true);
  assert.deepEqual(h.models.map(model => model.kind ?? model.phase), ['task', 'baseline-trial', 'candidate-trial', 'comparison-judge']);
  assert.equal(result.inputTokens, 35); assert.equal(result.outputTokens, 14);
  const trials = h.calls.filter(call => call.payload?.phase === 'trial');
  assert.equal(trials.length, 2);
  assert.notEqual(trials[0].payload.workspaceRunId, trials[1].payload.workspaceRunId);
  for (const trial of trials) { assert.ok(trial.args.includes(imageId)); assert.equal(trial.payload.input.run.prompt, input.run.prompt); assert.equal(trial.payload.interactiveCollaboration, false); }
  assert.equal(trials[0].payload.input.skills.length, 0); assert.equal(trials[1].payload.input.skills[0].content, skill.content);
  const judge = h.models.find(model => model.phase === 'evaluate');
  assert.equal(/inputTokens|outputTokens|durationMs|cachedInputTokens/.test(JSON.stringify(judge.comparison)), false);
  assert.equal(h.reserved(), 0); assert.deepEqual([...h.volumes.keys()], [workspaceVolume(config, input.run.id)]);
  assert.equal(h.attempts.size, 4);
});
test('budget pause preserves completed task and baseline trial; resumption starts only candidate and judge', async () => {
  const h = fixture(); h.budget(2);
  await assert.rejects(new ContainerRuntime(config, h.runner).execute(input, h.hooks), error => (error as BudgetPauseError).code === 'MODEL_BUDGET_PAUSED');
  const checkpoint = h.checkpoint()!;
  assert.equal(checkpoint.phase, 'evaluate'); assert.ok(checkpoint.growthProgress);
  assert.equal(h.models.length, 2); assert.equal(h.reserved(), 0);
  h.budget(4);
  const result = await new ContainerRuntime(config, h.runner).execute({ ...input, checkpoint }, h.hooks);
  assert.equal(result.skills[0].passed, true);
  assert.deepEqual(h.models.map(model => model.kind ?? model.phase), ['task', 'baseline-trial', 'candidate-trial', 'comparison-judge']);
});
test('repair candidate generation is preserved when comparison pauses and is not generated again', async () => {
  const h = fixture(); h.budget(1);
  const repairing: ExecutionInput = { ...input, growth: { mode: 'repair', skillId: skill.id, baseline: null, candidate: skill, originalPrompt: input.run.prompt, feedback: { failures: ['missing requirement'], usefulChanges: ['valid procedure'] } } };
  await assert.rejects(new ContainerRuntime(config, h.runner).execute(repairing, h.hooks), error => (error as BudgetPauseError).code === 'MODEL_BUDGET_PAUSED');
  h.budget(4);
  const result = await new ContainerRuntime(config, h.runner).execute({ ...repairing, checkpoint: h.checkpoint() }, h.hooks);
  assert.equal(result.skills[0].content, 'repaired technique'); assert.equal(result.skills[0].passed, true);
  assert.deepEqual(h.models.map(model => model.kind ?? model.phase), ['repair', 'baseline-trial', 'candidate-trial', 'comparison-judge']);
});
test('web or team dependent comparisons stay inconclusive without pretending an altered environment is equivalent', async () => {
  for (const unsafe of [{ ...input, agent: { ...input.agent, allowWeb: true } }, { ...input, collaboration: { tools: [], context: {} } }]) {
    const h = fixture();
    const result = await new ContainerRuntime(config, h.runner).execute({ ...unsafe, growth: { mode: 'review', skillId: skill.id, baseline: null, candidate: skill, originalPrompt: input.run.prompt } }, h.hooks);
    assert.equal(result.growthReview?.verified, false); assert.equal(result.growthReview?.verdict, 'inconclusive'); assert.equal(h.models.length, 0);
  }
});

const replayProposal: GrowthReplayProposal = { applicability: 'local', prompt: 'Check the supplied source and return a corrected local artifact.',
  criteria: ['The required control has a label.', 'Invalid input has a visible error.'], artifactIds: ['artifact-1'] };
function replayInput(): ExecutionInput {
  const prompt = 'Fix and publish the site, open a PR, and ask the teammate for review.';
  return { ...input, agent: { ...input.agent, allowWeb: true, repositoryIds: ['repository-1'] },
    run: { ...input.run, prompt }, repositoryTransport: 'github-app-v1',
    collaboration: { tools: [{ name: 'github_publish', description: 'publish', inputSchema: {} }], context: { instruction: 'publish again' } },
    growthReplay: captureGrowthReplayInput({ version: 1, sourceRunId: input.run.id, taskPrompt: prompt,
      artifacts: [{ id: 'artifact-1', version: 7, name: 'form.html', content: '<input required>', mediaType: 'text/html' }] }),
  };
}
test('GitHub and team skills use one immutable local test with fresh workspaces and no external tools', async () => {
  const external = replayInput();
  const h = fixture(payload => payload.phase === 'task' ? { ...task, skills: [{ ...task.skills[0], replay: replayProposal }] }
    : payload.phase === 'evaluate' ? { verdict: 'improved', replayApplicable: true, reason: 'Corrected required control and invalid-input handling.', evidence: ['Both captured outputs inspected.'], usefulChanges: ['label and error handling'], failures: [], inputTokens: 1, outputTokens: 1 } : undefined);
  const result = await new ContainerRuntime(config, h.runner).execute(external, { ...h.hooks, onTool: async () => { throw new Error('External action repeated'); } });
  assert.equal(result.skills[0].passed, true);
  const expected = resolveGrowthReplay(external.growthReplay!, replayProposal, external.run.prompt);
  assert.equal(result.skills[0].comparison!.fingerprint.replayHash, expected.replayHash);
  assert.deepEqual(result.skills[0].replay, replayProposal);
  for (const trial of h.models.filter(model => model.phase === 'trial')) {
    assert.equal(trial.input.run.prompt, expected.prompt); assert.notEqual(trial.input.run.prompt, external.run.prompt);
    assert.equal(trial.input.agent.allowWeb, false); assert.deepEqual(trial.input.agent.repositoryIds, []);
    assert.equal(trial.input.collaboration, undefined); assert.equal(trial.input.repositoryTransport, undefined);
    assert.equal(trial.input.environment, undefined); assert.deepEqual(trial.input.connections, []);
    assert.equal(trial.interactiveCollaboration, false); assert.equal(trial.input.run.workspaceSourceRunId, null);
    assert.equal(h.calls.find(call => call.payload?.operation === 'prepare' && call.payload.runId === trial.workspaceRunId)!.payload.sourceRunId, null);
  }
  assert.equal(h.models.find(model => model.phase === 'evaluate').comparison.replay.sourceHash, external.growthReplay!.sourceHash);
});
test('unavailable or altered replay stays inconclusive without starting any trial', async () => {
  for (const scenario of ['missing', 'external', 'unknown-artifact', 'tampered', 'wrong-run', 'steered']) {
    const external = replayInput();
    let replay: GrowthReplayProposal | undefined = structuredClone(replayProposal);
    if (scenario === 'missing') replay = undefined;
    if (scenario === 'external') replay!.applicability = 'external_required';
    if (scenario === 'unknown-artifact') replay!.artifactIds = ['not-captured'];
    if (scenario === 'tampered') external.growthReplay!.artifacts[0].content = 'changed';
    if (scenario === 'wrong-run') external.growthReplay = captureGrowthReplayInput({ ...external.growthReplay!, sourceRunId: 'another-run' });
    const h = fixture(payload => payload.phase === 'task' ? { ...task, skills: [{ ...task.skills[0], replay }] } : undefined);
    const result = await new ContainerRuntime(config, h.runner).execute(external, { ...h.hooks, getSteering: async () => scenario === 'steered' ? ['changed requirement'] : [] });
    assert.equal(result.skills[0].passed, false, scenario); assert.equal(result.skills[0].comparison!.verified, false, scenario);
    assert.deepEqual(h.models.map(model => model.phase), ['task'], scenario);
  }
});
test('replay relevance must be independently confirmed and paused trials resume from the same snapshot', async () => {
  const external = replayInput();
  for (const applicable of [undefined, false]) {
    const h = fixture(payload => payload.phase === 'task' ? { ...task, skills: [{ ...task.skills[0], replay: replayProposal }] }
      : payload.phase === 'evaluate' ? { verdict: 'improved', replayApplicable: applicable, reason: 'Better answer', evidence: ['Compared outputs'], usefulChanges: [], failures: [], inputTokens: 1, outputTokens: 1 } : undefined);
    const result = await new ContainerRuntime(config, h.runner).execute(external, h.hooks);
    assert.equal(result.skills[0].passed, false); assert.equal(result.skills[0].comparison!.verdict, 'inconclusive');
  }
  const h = fixture(payload => payload.phase === 'task' ? { ...task, skills: [{ ...task.skills[0], replay: replayProposal }] }
    : payload.phase === 'evaluate' ? { verdict: 'improved', replayApplicable: true, reason: 'Relevant improvement', evidence: ['Compared outputs'], usefulChanges: [], failures: [], inputTokens: 1, outputTokens: 1 } : undefined);
  h.budget(2);
  await assert.rejects(new ContainerRuntime(config, h.runner).execute(external, h.hooks), error => (error as BudgetPauseError).code === 'MODEL_BUDGET_PAUSED');
  h.budget(4);
  const result = await new ContainerRuntime(config, h.runner).execute({ ...external, checkpoint: h.checkpoint() }, h.hooks);
  assert.equal(result.skills[0].passed, true);
  assert.deepEqual(h.models.map(model => model.kind ?? model.phase), ['task', 'baseline-trial', 'candidate-trial', 'comparison-judge']);
});

test('objective evaluation retains its structured assessment with one read-only phase and rejects live capabilities', async () => {
  const objectiveEvaluation: NonNullable<ExecutionInput['objectiveEvaluation']> = { objectiveId: 'objective-1', objectiveVersion: 1,
    inputHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64), title: 'Accessible form', purpose: 'Complete the form', constraints: 'Existing access only',
    conditions: [{ id: 'labels', text: 'Inputs have labels', requiresUserConfirmation: false }], evidence: [], priorTasks: [] };
  const objectiveAssessment = { inputHash: objectiveEvaluation.inputHash, reason: 'Verification evidence is absent',
    conditions: [{ conditionId: 'labels', status: 'unmet' as const, reason: 'Inspect the artifact', evidenceIds: [] }],
    followUps: [{ conditionIds: ['labels'], title: 'Verify labels', description: 'Check the current source and record evidence' }] };
  const assessing: ExecutionInput = { ...input, run: { ...input.run, interactionMode: 'discuss' }, objectiveEvaluation };
  const h = fixture(() => ({ ...task, objectiveAssessment }));
  const result = await new ContainerRuntime(config, h.runner).execute(assessing, h.hooks);
  assert.deepEqual(result.objectiveAssessment, objectiveAssessment); assert.deepEqual(result.skills, []); assert.deepEqual(result.memories, []);
  assert.deepEqual(h.checkpoint()!.previousResult!.objectiveAssessment, objectiveAssessment);
  assert.deepEqual(h.models.map(model => model.phase), ['task']);
  for (const unsafe of [
    { ...assessing, agent: { ...input.agent, allowWeb: true } },
    { ...assessing, agent: { ...input.agent, repositoryIds: ['repo'] } },
    { ...assessing, collaboration: { tools: [], context: {} } },
    { ...assessing, run: { ...input.run, interactionMode: 'task' as const } },
  ]) {
    const rejected = fixture();
    await assert.rejects(new ContainerRuntime(config, rejected.runner).execute(unsafe, rejected.hooks), /읽기 전용/);
    assert.equal(rejected.models.length, 0);
  }
});
test('malformed judge, blank evidence, identical outputs and author self-pass never authorize activation', async () => {
  for (const scenario of ['bad-schema', 'blank', 'same-output']) {
    const h = fixture(payload => {
      if (scenario === 'same-output' && payload.phase === 'trial') return { ...task, result: 'same result', skills: [] };
      if (payload.phase === 'evaluate' && scenario === 'bad-schema') return { passed: true, evidence: 'author says so', inputTokens: 4, outputTokens: 2 };
      if (payload.phase === 'evaluate' && scenario === 'blank') return { verdict: 'improved', reason: 'claim', evidence: [' '], usefulChanges: [], failures: [], inputTokens: 4, outputTokens: 2 };
    });
    const result = await new ContainerRuntime(config, h.runner).execute(input, h.hooks);
    assert.equal(result.skills[0].passed, false); assert.equal(result.skills[0].comparison?.verified, false); assert.equal(h.reserved(), 0);
  }
});

test('failed judge preserves the task and completed trials without activating a candidate', async () => {
  const h = fixture(payload => { if (payload.phase === 'evaluate') throw new Error('evaluation unavailable'); });
  const result = await new ContainerRuntime(config, h.runner).execute(input, h.hooks);
  assert.equal(result.result, task.result); assert.equal(result.skills[0].passed, false);
  assert.match(result.skills[0].evaluation, /evaluation unavailable/);
  assert.equal(result.skills[0].comparison?.baseline.completed, true); assert.equal(result.skills[0].comparison?.candidate.completed, true);
  assert.equal([...h.attempts.values()].at(-1)?.status, 'failed'); assert.equal(h.reserved(), 0);
});

test('judge reason persistence limit is enforced and long failures are bounded', async () => {
  for (const size of [20_000, 20_001, 30_000]) {
    const h = fixture(payload => {
      if (payload.phase !== 'evaluate') return;
      if (size === 30_000) throw new Error('e'.repeat(size));
      return { verdict: 'improved', reason: 'r'.repeat(size), evidence: ['output comparison'], usefulChanges: [], failures: [], inputTokens: 0, outputTokens: 0 };
    });
    const result = await new ContainerRuntime(config, h.runner).execute(input, h.hooks);
    assert.equal(result.skills[0].passed, size === 20_000); assert.ok(result.skills[0].evaluation.length <= 20_000);
  }
});

test('accepted steering becomes the fixed common comparison prompt', async () => {
  const h = fixture();
  const steering = ['Include the new requirement'];
  await new ContainerRuntime(config, h.runner).execute(input, { ...h.hooks, getSteering: async () => steering });
  const expected = `${input.run.prompt}\n\n사용자의 추가 지시:\n${JSON.stringify(steering)}`;
  for (const trial of h.models.filter(model => model.phase === 'trial')) assert.equal(trial.input.run.prompt, expected);
  assert.equal(h.models.find(model => model.phase === 'evaluate').comparison.prompt, expected);
});

test('trials inherit the original pre-task source and memory, with storage reservation before either copy', async () => {
  const h = fixture(), sourceRunId = 'original-source';
  const sourceVolume = workspaceVolume(config, sourceRunId);
  h.volumes.set(sourceVolume, { app: 'agent-company', 'agent-company.workspace': config.workspaceKey!, 'agent-company.run': sourceRunId });
  const original: ExecutionInput = { ...input, run: { ...input.run, workspaceSourceRunId: sourceRunId },
    memories: [{ id: 'memory-a', agentId: input.agent.id, kind: 'fact', title: 'before task', content: 'original memory', sourceRunId, createdAt: at, updatedAt: at }] };
  const result = await new ContainerRuntime(config, h.runner).execute(original, h.hooks);
  assert.equal(result.skills[0].passed, true, result.skills[0].evaluation);
  const trialIds = h.models.filter(model => model.phase === 'trial').map(model => model.workspaceRunId);
  for (const id of trialIds) assert.equal(h.calls.find(call => call.payload?.operation === 'prepare' && call.payload.runId === id)?.payload.sourceRunId, sourceRunId);
  for (const trial of h.models.filter(model => model.phase === 'trial')) assert.deepEqual(trial.input.memories, original.memories);
  assert.ok(h.volumes.has(sourceVolume)); assert.ok(h.volumes.has(workspaceVolume(config, input.run.id)));
});

test('storage budget pause preserves completed task before any trial model is started', async () => {
  const h = fixture();
  await assert.rejects(new ContainerRuntime(config, h.runner).execute(input, { ...h.hooks,
    reserveWorkspaceCopy: async () => { throw Object.assign(new Error('storage budget'), { statusCode: 507 }); } }), /storage budget/);
  assert.equal(h.checkpoint()?.phase, 'evaluate'); assert.deepEqual(h.models.map(model => model.phase), ['task']);
});

test('trial cleanup failure preserves baseline progress and its reservation until cleanup allows the remaining comparison', async () => {
  const h = fixture(); let failRemoval = true;
  const runner: Command = async (file, args, options) => {
    if (args[0] === 'volume' && args[1] === 'rm' && failRemoval) return { code: 1, stdout: '', stderr: 'temporary engine error' };
    return h.runner(file, args, options);
  };
  const driver = new ContainerRuntime(config, runner);
  await assert.rejects(driver.execute(input, h.hooks), { code: 'RUNTIME_CLEANUP_PENDING' });
  const checkpoint = h.checkpoint()!;
  assert.equal(checkpoint.phase, 'evaluate'); assert.equal(h.reserved(), 1);
  assert.deepEqual(h.models.map(model => model.kind ?? model.phase), ['task', 'baseline-trial']);
  const volumeCount = h.volumes.size;
  await assert.rejects(driver.confirmDeploymentIdle(), /임시 비교 작업공간 정리 1건 \[pending_trial_copies\]/);
  assert.equal(h.reserved(), 1); assert.equal(h.volumes.size, volumeCount);
  await assert.rejects(driver.execute({ ...input, checkpoint }, h.hooks), { code: 'RUNTIME_CLEANUP_PENDING' });
  assert.equal(h.models.length, 2);
  await driver.settle('unrelated-run'); assert.equal(h.reserved(), 1);
  failRemoval = false; await driver.settle(input.run.id);
  assert.equal(h.reserved(), 0); assert.deepEqual([...h.volumes.keys()], [workspaceVolume(config, input.run.id)]);
  const result = await driver.execute({ ...input, checkpoint }, h.hooks);
  assert.equal(result.skills[0].passed, true);
  assert.deepEqual(h.models.map(model => model.kind ?? model.phase), ['task', 'baseline-trial', 'candidate-trial', 'comparison-judge']);
});

test('worker cleanup failure pauses comparison and resumes the saved task or baseline without repeating models', async () => {
  for (const phase of ['task', 'baseline-trial']) {
    const h = fixture(); let failRemoval = true;
    const runner: Command = async (file, args, options) => {
      if (args[0] === 'rm' && args[2] === `ac-run-a-${phase}` && failRemoval) return { code: 1, stdout: '', stderr: 'temporary engine error' };
      return h.runner(file, args, options);
    };
    const driver = new ContainerRuntime(config, runner);
    await assert.rejects(driver.execute(input, h.hooks), { code: 'RUNTIME_CLEANUP_PENDING' });
    const checkpoint = h.checkpoint()!;
    assert.equal(checkpoint.phase, 'evaluate'); assert.equal(checkpoint.previousResult?.result, task.result);
    assert.equal(h.models.length, phase === 'task' ? 1 : 2);
    failRemoval = false; await driver.settle(input.run.id);
    const result = await driver.execute({ ...input, checkpoint }, h.hooks);
    assert.equal(result.skills[0].passed, true); assert.equal(h.reserved(), 0);
    assert.deepEqual(h.models.map(model => model.kind ?? model.phase), ['task', 'baseline-trial', 'candidate-trial', 'comparison-judge']);
  }
});

test('startup removes only explicitly owned idle trial volumes and preserves ordinary Run volumes', async () => {
  const h = fixture(), trialId = 'orphan-trial', sourceId = 'original-source';
  const labels = (id: string) => ({ app: 'agent-company', 'agent-company.workspace': config.workspaceKey!, 'agent-company.run': id });
  h.volumes.set(workspaceVolume(config, sourceId), labels(sourceId));
  h.volumes.set(workspaceVolume(config, input.run.id), labels(input.run.id));
  h.volumes.set(workspaceVolume(config, trialId), { ...labels(trialId), 'agent-company.workspace-role': 'trial', 'agent-company.temporary-for': input.run.id });
  await new ContainerRuntime(config, h.runner).recover();
  assert.equal(h.models.length, 0);
  assert.deepEqual([...h.volumes.keys()].sort(), [workspaceVolume(config, sourceId), workspaceVolume(config, input.run.id)].sort());
  assert.deepEqual(h.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'rm').map(call => call.args), [['volume', 'rm', workspaceVolume(config, trialId)]]);
});

test('temporary recovery refuses mounted volumes and incorrect owner labels without deleting them', async () => {
  for (const invalid of ['mounted', 'foreign', 'parent-is-self']) {
    const h = fixture(), trialId = 'orphan-trial', name = workspaceVolume(config, trialId);
    h.volumes.set(name, { app: 'agent-company', 'agent-company.workspace': invalid === 'foreign' ? 'other-workspace' : config.workspaceKey!, 'agent-company.run': trialId,
      'agent-company.workspace-role': 'trial', 'agent-company.temporary-for': invalid === 'parent-is-self' ? trialId : input.run.id });
    const runner: Command = async (file, args, options) => args[0] === 'ps' && args.some(arg => arg.startsWith('volume=')) && invalid === 'mounted'
      ? { code: 0, stdout: 'still-active-container', stderr: '' } : h.runner(file, args, options);
    await assert.rejects(new ContainerRuntime(config, runner).recover());
    assert.ok(h.volumes.has(name)); assert.equal(h.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'rm').length, 0);
  }
});

test('killed candidate or judge propagates interruption and resumes without repeating completed trials', async () => {
  for (const interruptedKind of ['candidate-trial', 'comparison-judge']) {
    const h = fixture(); let killed = false;
    const runner: Command = async (file, args, options = {}) => {
      const payload = args[0] === 'run' && options.input ? JSON.parse(options.input) : undefined;
      if (payload?.kind === interruptedKind && !killed) {
        killed = true; h.models.push(payload);
        return { code: 137, stdout: '', stderr: 'Killed' };
      }
      return h.runner(file, args, options);
    };
    const driver = new ContainerRuntime(config, runner);
    await assert.rejects(driver.execute(input, h.hooks), error => (error as { code?: string }).code === 'WORKER_INTERRUPTED');
    const checkpoint = h.checkpoint()!;
    assert.equal(checkpoint.phase, 'evaluate'); assert.equal(await driver.canResume({ ...input, checkpoint }), true);
    assert.equal(h.reserved(), 0);
    const result = await new ContainerRuntime(config, runner).execute({ ...input, checkpoint }, h.hooks);
    assert.equal(result.skills[0].passed, true);
    const kinds = h.models.map(payload => payload.kind ?? payload.phase);
    assert.equal(kinds.filter(kind => kind === 'task').length, 1);
    assert.equal(kinds.filter(kind => kind === 'baseline-trial').length, 1);
    assert.equal(kinds.filter(kind => kind === 'candidate-trial').length, interruptedKind === 'candidate-trial' ? 2 : 1);
    assert.equal(kinds.filter(kind => kind === 'comparison-judge').length, interruptedKind === 'comparison-judge' ? 2 : 1);
  }
});

test('first interrupted review or repair model already has a safe resumable growth checkpoint', async () => {
  for (const mode of ['review', 'repair'] as const) {
    const h = fixture(); let killed = false;
    const runner: Command = async (file, args, options = {}) => {
      const payload = args[0] === 'run' && options.input ? JSON.parse(options.input) : undefined;
      if (payload?.phase && !killed) { killed = true; h.models.push(payload); return { code: 143, stdout: '', stderr: 'Terminated' }; }
      return h.runner(file, args, options);
    };
    const growthInput: ExecutionInput = { ...input, growth: { mode, skillId: skill.id, baseline: null, candidate: skill, originalPrompt: input.run.prompt } };
    const driver = new ContainerRuntime(config, runner);
    await assert.rejects(driver.execute(growthInput, h.hooks), error => (error as { code?: string }).code === 'WORKER_INTERRUPTED');
    const checkpoint = h.checkpoint()!;
    assert.equal(checkpoint.phase, 'evaluate'); assert.equal(await driver.canResume({ ...growthInput, checkpoint }), true);
    const result = await new ContainerRuntime(config, runner).execute({ ...growthInput, checkpoint }, h.hooks);
    assert.equal(result.growthReview?.verdict, 'improved');
    assert.equal(h.models.some(payload => payload.phase === 'task'), false);
    assert.equal(h.reserved(), 0);
  }
});

test('task kill after a session checkpoint preserves that session and partial usage for guarded resume', async () => {
  const h = fixture(), sessionId = '12345678-1234-1234-1234-123456789abc'; let killed = false;
  const runner: Command = async (file, args, options = {}) => {
    if (args.includes('--check-session')) { assert.equal(args.at(-1), sessionId); return { code: 0, stdout: '', stderr: '' }; }
    const payload = args[0] === 'run' && options.input ? JSON.parse(options.input) : undefined;
    if (payload?.phase === 'task' && !killed) {
      killed = true; h.models.push(payload);
      await options.onLine?.(JSON.stringify({ type: 'checkpoint', checkpoint: { phase: 'task', sessionId } }));
      await options.onLine?.(JSON.stringify({ type: 'telemetry', usage: { status: 'partial', inputTokens: 12, outputTokens: 3, cachedInputTokens: null, reasoningOutputTokens: null }, observations: [], observationsTruncated: false }));
      return { code: 137, stdout: '', stderr: 'Killed' };
    }
    if (payload?.phase === 'task') assert.equal(payload.input.checkpoint.sessionId, sessionId);
    return h.runner(file, args, options);
  };
  const driver = new ContainerRuntime(config, runner);
  await assert.rejects(driver.execute(input, h.hooks), error => (error as { code?: string }).code === 'WORKER_INTERRUPTED');
  const checkpoint = h.checkpoint()!;
  assert.equal(checkpoint.phase, 'task'); assert.equal(checkpoint.sessionId, sessionId);
  const failed = [...h.attempts.values()][0]; assert.equal(failed.status, 'failed'); assert.equal(failed.usage.status, 'partial'); assert.equal(failed.usage.inputTokens, 12);
  assert.equal(await driver.canResume({ ...input, checkpoint }), true);
  const result = await new ContainerRuntime(config, runner).execute({ ...input, checkpoint }, h.hooks);
  assert.equal(result.result, task.result); assert.equal(h.reserved(), 0);
  assert.ok(h.volumes.has(workspaceVolume(config, input.run.id)));
});

test('cancellation during a trial preserves progress but cannot be turned into completion or start a judge', async () => {
  const h = fixture(), controller = new AbortController();
  const runner: Command = async (file, args, options = {}) => {
    const payload = args[0] === 'run' && options.input ? JSON.parse(options.input) : undefined;
    if (payload?.kind === 'candidate-trial') { h.models.push(payload); controller.abort(); return { code: 137, stdout: '', stderr: 'Killed' }; }
    return h.runner(file, args, options);
  };
  await assert.rejects(new ContainerRuntime(config, runner).execute(input, { ...h.hooks, signal: controller.signal }));
  assert.equal(h.checkpoint()?.phase, 'evaluate');
  assert.equal([...h.attempts.values()].at(-1)?.status, 'cancelled');
  assert.equal(h.models.some(payload => payload.phase === 'evaluate'), false);
  assert.equal(h.reserved(), 0);
});
