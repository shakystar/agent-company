import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import type { Agent, ExecutionCheckpoint, Memory, Run, Skill, Workspace } from '../shared/types.ts';
import type { GrowthReview } from '../shared/growth.ts';
import type { ModelAttempt } from '../shared/telemetry.ts';
import { campaign } from './lifecycle-campaign.ts';
import { LifecycleClient } from './lifecycle-client.ts';
import { baselineSkill, candidateFixture, introductionCases, regressionCases, introductionPrompt, regressionPrompt, clarifiedRegressionPrompt,
  assertObservedOutput, assertExpectedOutput, assertFixtureCandidate, assertObservedCommandProof, type LifecycleCase } from './lifecycle-growth-cases.ts';

// Real-model controlled growth verification. No manual promotion, forced judge,
// state replacement, or new budget is used when a case fails or is rerun.
const context = await campaign(), directory = join(context.directory, 'growth');
const client = new LifecycleClient('growth');
assert.ok(process.argv.slice(2).every(value => ['--retry-introduction', '--retry-concern'].includes(value)) && process.argv.length <= 3);
const retryIntroduction = process.argv[2] === '--retry-introduction';
const retryConcern = process.argv[2] === '--retry-concern';
const progressPath = join(directory, 'progress.json');
interface Progress {
  agentId?: string; skillId?: string; memory?: Memory; originalRevisionId?: string;
  introductionRunId?: string; regressionRunId?: string; introductionProof?: unknown; regressionProof?: unknown;
  introductionReview?: GrowthReview; sourceFilesAfterTask?: string | null; completed?: boolean;
  priorIntroductionRunIds?: string[]; retryIntroductionOf?: string; retryIntroductionRunId?: string;
  priorRegressionRunIds?: string[]; retryConcernOf?: string; retryConcernRunId?: string;
}
let progress: Progress;
try { progress = JSON.parse(await readFile(progressPath, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; progress = {}; }
const save = async () => atomicJson(progressPath, progress);
const namedAgent = 'Lifecycle controlled growth 20260906';
const state = () => client.api<Workspace>('/api/workspace');
let lastStatus = '', lastLogged = 0;
async function settled(runId: string): Promise<Workspace> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const workspace = await state(), run = workspace.runs.find(item => item.id === runId);
    assert.ok(run, 'The original task must remain present');
    const related = workspace.runs.filter(item => item.agentId === run.agentId);
    const paused = related.find(item => item.modelBudgetPaused);
    if (paused) throw new Error(`Model budget exhausted; run ${paused.id} and checkpoint are preserved`);
    const failed = related.find(item => ['failed', 'cancelled'].includes(item.status));
    if (failed) throw new Error(`Run ${failed.id} ${failed.status}: ${failed.error}`);
    const status = related.map(item => `${item.kind ?? 'task'}:${item.status}`).join(',');
    if (status !== lastStatus || Date.now() - lastLogged > 30_000) {
      console.log(JSON.stringify({ stage: 'growth', status, modelStarts: (await context.budget.read()).starts.length, limit: 20 }));
      lastStatus = status; lastLogged = Date.now();
    }
    if (run.status === 'succeeded' && related.every(item => item.status === 'succeeded')
      && workspace.agents.find(item => item.id === run.agentId)?.status === 'idle'
      && !workspace.repairJobs?.some(item => item.agentId === run.agentId && ['queued', 'running'].includes(item.status))) return workspace;
    await delay(1000);
  }
  throw new Error('Growth verification observation timed out; progress is retained');
}
async function importInput(path: string, cases: readonly LifecycleCase[]) {
  const { files } = await client.api<{ files: { path: string }[] }>(`/api/files?scopeType=agent&scopeId=${progress.agentId}`);
  if (!files.some(item => item.path === path)) await client.api('/api/files/import', {
    scope: { type: 'agent', id: progress.agentId }, path, mediaType: 'application/json', base64: Buffer.from(JSON.stringify(cases)).toString('base64'),
  });
}
function artifactProof(run: Run, cases: readonly LifecycleCase[]) {
  const artifact = run.artifacts.find(item => item.name === 'proof.json');
  assert.ok(artifact, 'Real task must retain its observed proof artifact');
  const proof: unknown = JSON.parse(artifact.content); assertObservedOutput(proof, cases); return proof;
}
async function actualProof(cases: readonly LifecycleCase[]) {
  const result = await client.api<{ text: string }>(`/api/agents/${progress.agentId}/files?path=proof.json&read=true`);
  const proof: unknown = JSON.parse(result.text); assertObservedOutput(proof, cases); return proof;
}
async function trialProof(review: GrowthReview, cases: readonly LifecycleCase[], scores: [number, number]) {
  assert.ok(review.comparison?.verified, 'Independent comparison must be controller verified');
  const checkpoint: ExecutionCheckpoint = JSON.parse(await readFile(join(directory, 'checkpoints', `${review.sourceRunId}.trials.json`), 'utf8'));
  const comparison = Object.values(checkpoint.growthProgress ?? {}).find(value => {
    const candidate = value as { trials?: unknown[] }; return candidate.trials?.length === 2;
  }) as { trials: Array<{ result: { artifacts: Array<{ name: string; content: string }> }; attempt: ModelAttempt }> } | undefined;
  assert.ok(comparison, 'Both real trial results must have been captured before final checkpoint cleanup');
  const proofs = comparison.trials.map((trial, index) => {
    assert.equal(trial.attempt.id, index ? review.comparison!.candidate.attemptId : review.comparison!.baseline.attemptId);
    const artifact = trial.result.artifacts.find(item => item.name === 'proof.json'); assert.ok(artifact);
    const proof: unknown = JSON.parse(artifact.content); assertObservedOutput(proof, cases);
    assertObservedCommandProof(trial.attempt.observations, proof, cases);
    assert.equal(proof.passed, scores[index]); return proof;
  });
  return proofs;
}
let errorMessage: string | null = null;
let trialEvidence: Record<string, unknown> = {};
try {
  await client.start();
  let workspace = await state();
  let agent = workspace.agents.find(item => item.id === progress.agentId || item.name === namedAgent);
  agent ??= await client.api<Agent>('/api/agents', { name: namedAgent, model: context.config.model, allowWeb: false,
    persona: 'Execute local controlled reference-converter tests accurately. Preserve actual observations and report mismatches. Do not change tools, permissions, or network access.' });
  progress.agentId = agent.id; await save();
  workspace = await state();
  // Reconcile acknowledged API writes if the observer died before saving its IDs.
  progress.introductionRunId ??= workspace.runs.find(item => item.agentId === agent.id
    && item.prompt === introductionPrompt.replaceAll('input.json', 'introduction-input.json'))?.id;
  progress.regressionRunId ??= workspace.runs.find(item => item.agentId === agent.id
    && item.prompt === regressionPrompt.replaceAll('input.json', 'regression-input.json'))?.id;
  let skill = workspace.skills.find(item => item.agentId === agent.id && item.name === baselineSkill.name);
  skill ??= await client.api<Skill>(`/api/agents/${agent.id}/skills`, baselineSkill);
  progress.skillId ??= skill.id; progress.originalRevisionId ??= skill.activeRevisionId;
  progress.memory ??= workspace.memories.find(item => item.agentId === agent.id && item.title === 'Lifecycle preservation sentinel')
    ?? await client.api<Memory>(`/api/agents/${agent.id}/memories`, { kind: 'fact', title: 'Lifecycle preservation sentinel', content: 'Preserve this memory unchanged across skill rollback and repair.' });
  await save();
  if (retryIntroduction && !progress.retryIntroductionOf && !progress.retryIntroductionRunId) {
    assert.ok(!progress.completed && !progress.regressionRunId && progress.introductionRunId);
    const previous = workspace.growthReviews?.find(item => item.sourceRunId === progress.introductionRunId);
    assert.ok(previous && !previous.comparison?.verified && previous.verdict === 'inconclusive'
      && !previous.comparison?.judgeAttemptId, 'Do not rerun a real quality verdict to manufacture a pass');
    const ledger = await context.budget.read();
    const starts = ledger.starts.filter(item => item.runId === progress.introductionRunId);
    const attempts = workspace.modelAttempts!.filter(item => item.runId === progress.introductionRunId);
    assert.deepEqual(starts.map(item => item.kind), ['task', 'baseline-trial']);
    assert.deepEqual(attempts.map(item => item.kind), ['task', 'baseline-trial']);
    assert.ok(attempts.every(item => item.status === 'succeeded'));
    assert.ok(!starts.some(item => item.phase === 'evaluate') && !attempts.some(item => item.phase === 'evaluate'));
    assert.equal(previous.comparison?.reason, '작업공간 소유권을 확인하지 못했습니다.', 'Only the reproduced inventory race permits this retry');
    assert.equal(skill.activeRevisionId, progress.originalRevisionId, 'The baseline must remain unchanged');
    assert.ok(20 - ledger.starts.length >= 12, 'Retain progress if the complete growth case cannot fit');
    const oldReport = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    const archivePath = join(directory, `report-${progress.introductionRunId}.json`);
    try { await writeFile(archivePath, JSON.stringify(oldReport), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const archived = JSON.parse(await readFile(archivePath, 'utf8'));
    assert.equal(archived.progress.introductionRunId, progress.introductionRunId, 'Preserve the original report, never replace an existing archive');
    progress.priorIntroductionRunIds = [...(progress.priorIntroductionRunIds ?? []), progress.introductionRunId];
    progress.retryIntroductionOf = progress.introductionRunId; await save();
  }
  if (progress.retryIntroductionOf) {
    const prompt = introductionPrompt.replaceAll('input.json', 'introduction-input.json');
    workspace = await state();
    const existing = workspace.runs.find(item => item.agentId === agent.id && item.prompt === prompt
      && !progress.priorIntroductionRunIds?.includes(item.id));
    const replacement = existing ?? await client.api<Run>(`/api/agents/${agent.id}/runs`, { prompt });
    progress.introductionRunId = replacement.id; progress.introductionReview = undefined; progress.introductionProof = undefined;
    progress.retryIntroductionRunId = replacement.id;
    progress.retryIntroductionOf = undefined; await save();
  }
  if (retryConcern && !progress.retryConcernOf && !progress.retryConcernRunId) {
    assert.ok(!progress.completed && progress.regressionRunId);
    const previousRun = workspace.runs.find(item => item.id === progress.regressionRunId)!;
    assert.equal(previousRun.status, 'succeeded');
    assert.equal(artifactProof(previousRun, regressionCases).passed, 2);
    const ledger = await context.budget.read();
    const starts = ledger.starts.filter(item => item.runId === previousRun.id);
    const attempts = workspace.modelAttempts!.filter(item => item.runId === previousRun.id);
    assert.deepEqual(starts.map(item => item.kind), ['task']);
    assert.deepEqual(attempts.map(item => [item.kind, item.status]), [['task', 'succeeded']]);
    assert.equal(workspace.runs.some(item => item.agentId === agent.id && ['review', 'repair'].includes(item.kind ?? '')), false);
    assert.equal(skill.activeRevisionId, progress.introductionReview?.candidateRevisionId);
    const diagnostic = JSON.parse(await readFile(join(directory, 'concern-diagnostic.json'), 'utf8'));
    assert.equal(diagnostic.runId, previousRun.id); assert.deepEqual(diagnostic.persistedConcerns, []);
    assert.ok(diagnostic.finals.length && diagnostic.finals.every((item: { skillConcerns: unknown[] }) => item.skillConcerns.length === 0));
    assert.ok(20 - ledger.starts.length >= 8, 'Retain progress if the remaining concern/review/repair cannot fit');
    const archivePath = join(directory, `report-${previousRun.id}.json`);
    try { await writeFile(archivePath, await readFile(join(directory, 'report.json')), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assert.equal(JSON.parse(await readFile(archivePath, 'utf8')).progress.regressionRunId, previousRun.id);
    progress.priorRegressionRunIds = [...(progress.priorRegressionRunIds ?? []), previousRun.id];
    progress.retryConcernOf = previousRun.id; await save();
  }
  if (progress.retryConcernOf) {
    const prompt = clarifiedRegressionPrompt.replaceAll('input.json', 'regression-input.json');
    workspace = await state();
    const existing = workspace.runs.find(item => item.agentId === agent.id && item.prompt === prompt);
    const clarified = existing ?? await client.api<Run>(`/api/agents/${agent.id}/runs`, { prompt });
    progress.regressionRunId = clarified.id; progress.retryConcernRunId = clarified.id; progress.regressionProof = undefined;
    progress.retryConcernOf = undefined; await save();
  }
  if (!progress.introductionRunId) {
    await importInput('introduction-input.json', introductionCases);
    const prompt = introductionPrompt.replaceAll('input.json', 'introduction-input.json');
    workspace = await state();
    const existing = workspace.runs.find(item => item.agentId === agent.id && item.prompt === prompt);
    progress.introductionRunId = existing?.id ?? (await client.api<Run>(`/api/agents/${agent.id}/runs`, { prompt })).id;
    await save();
  }
  workspace = await settled(progress.introductionRunId);
  const introduction = workspace.runs.find(item => item.id === progress.introductionRunId)!;
  progress.introductionProof ??= artifactProof(introduction, introductionCases);
  progress.introductionReview ??= workspace.growthReviews?.find(item => item.sourceRunId === introduction.id && item.purpose === 'candidate');
  assert.ok(progress.introductionReview, 'The real author must propose the supplied controlled candidate');
  const supplied = workspace.skillRevisions?.find(item => item.id === progress.introductionReview!.candidateRevisionId);
  assertFixtureCandidate(supplied);
  assert.deepEqual({ name: supplied!.name, description: supplied!.description, content: supplied!.content }, candidateFixture);
  if (!progress.regressionRunId) assert.deepEqual(await actualProof(introductionCases), progress.introductionProof);
  await save();
  trialEvidence.introduction = await trialProof(progress.introductionReview, introductionCases, [0, 3]);
  assert.equal(progress.introductionReview.verdict, 'improved', 'Actual judge did not find improvement; no verdict will be forced');
  assert.equal(progress.introductionReview.decision, 'activated', 'Supplied candidate was not automatically activated');
  if (!progress.regressionRunId) {
    await importInput('regression-input.json', regressionCases);
    const prompt = regressionPrompt.replaceAll('input.json', 'regression-input.json');
    workspace = await state();
    const existing = workspace.runs.find(item => item.agentId === agent.id && item.prompt === prompt);
    progress.regressionRunId = existing?.id ?? (await client.api<Run>(`/api/agents/${agent.id}/runs`, { prompt })).id;
    await save();
  }
  workspace = await settled(progress.regressionRunId);
  const regression = workspace.runs.find(item => item.id === progress.regressionRunId)!;
  progress.regressionProof = artifactProof(regression, regressionCases);
  assert.equal((progress.regressionProof as { passed: number }).passed, 2);
  assert.deepEqual(await actualProof(regressionCases), progress.regressionProof, 'Review and repair must preserve the actual task output');
  for (const [path, cases] of [['introduction-input.json', introductionCases], ['regression-input.json', regressionCases]] as const) {
    const inputFile: { text: string } = await client.api(`/api/agents/${agent.id}/files?path=${path}&read=true`);
    assert.deepEqual(JSON.parse(inputFile.text), cases, 'Growth must preserve both original input files');
  }
  assert.equal(workspace.agents.find(item => item.id === agent.id)!.workspaceRunId, regression.id, 'Growth-only runs must not replace task files');
  assert.deepEqual(workspace.memories.find(item => item.id === progress.memory!.id), progress.memory);
  const reviews = workspace.growthReviews!.filter(item => item.agentId === agent.id);
  const rollback = reviews.find(item => item.purpose === 'regression' && item.decision === 'rolled_back');
  assert.ok(rollback, 'Real regression review did not cause automatic rollback');
  assert.equal(rollback.baselineRevisionId, progress.originalRevisionId);
  trialEvidence.regression = await trialProof(rollback, regressionCases, [5, 2]);
  const repaired = reviews.find(item => item.purpose === 'repair' && item.decision === 'activated');
  assert.ok(repaired, 'A repaired skill was not automatically re-applied; existing verdicts remain unchanged');
  const proof = await trialProof(repaired, regressionCases, [5, 6]);
  assertExpectedOutput(proof[1], regressionCases); trialEvidence.repair = proof;
  const active = workspace.skills.find(item => item.id === progress.skillId)!;
  assert.equal(active.activeRevisionId, repaired.candidateRevisionId);
  const history = workspace.skillRevisions!.filter(item => item.skillId === progress.skillId);
  assert.ok(history.some(item => item.id === progress.originalRevisionId && item.content === baselineSkill.content));
  assert.ok(history.some(item => item.id === progress.introductionReview!.candidateRevisionId && item.content === candidateFixture.content));
  assert.ok(history.some(item => item.id === repaired.candidateRevisionId && item.origin === 'repair'));
  const repairRun = workspace.runs.find(item => item.id === repaired.sourceRunId)!;
  const resolvedJob = workspace.repairJobs!.find(item => item.id === repairRun.growthJobId);
  assert.ok(resolvedJob && resolvedJob.status === 'resolved');
  assert.equal(resolvedJob.sourceReviewId, repaired.id);
  assert.equal(resolvedJob.sourceRunId, regression.id);
  assert.equal(resolvedJob.baselineRevisionId, progress.originalRevisionId);
  progress.completed = true; await save();
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error); process.exitCode = 1; console.error(errorMessage);
} finally {
  await client.stop();
  const store = await WorkspaceStore.open(join(directory, 'data', 'db'));
  try {
    const persisted = await store.read(), ledger = await context.budget.read();
    await campaign(); // Recheck that the old ledger has not been reset or consumed.
    const agent = persisted.agents.find(item => item.id === progress.agentId);
    if (progress.completed) assert.equal(agent?.workspaceRunId, progress.regressionRunId);
    const report = { status: errorMessage ? 'incomplete' : 'passed', error: errorMessage, completedAt: new Date().toISOString(),
      controlledCandidateAndRegressionFixture: true, naturalLearningQualityClaim: false, manualPromotion: false, forcedVerdict: false,
      modelStarts: ledger.starts.length, limit: 20, previousCampaignUnchanged: true, databaseReopened: true,
      progress, trialEvidence, agent, memories: persisted.memories, skills: persisted.skills, skillRevisions: persisted.skillRevisions,
      reviews: persisted.growthReviews, repairJobs: persisted.repairJobs, runs: persisted.runs, modelAttempts: persisted.modelAttempts };
    await atomicJson(join(directory, 'report.json'), report);
    console.log(JSON.stringify({ status: report.status, modelStarts: report.modelStarts, limit: 20, report: join(directory, 'report.json') }));
  } finally { await store.close(); }
}
