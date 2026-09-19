import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Skill } from '../shared/types.ts';
import type { ComparisonEvidence, GrowthVerdict, SkillRevision } from '../shared/growth.ts';
import {
  applyGrowthAssessment, ensureSkillRevision, forkSkillRevisions, registerSkillCandidate,
  skillRevisionHash, updateRepairJob, type GrowthContext, type GrowthDomainState,
} from '../server/growth.ts';

const context = (): GrowthContext => ({ now: '2026-09-06T12:00:00.000Z', newId: randomUUID });
function fixture(withSkill = true) {
  const agentId = randomUUID(), skillId = randomUUID(), ctx = context();
  const state: GrowthDomainState = { skills: [], skillRevisions: [], growthReviews: [], repairJobs: [] };
  const skill: Skill = { id: skillId, agentId, name: '整理', description: 'Reusable procedure', content: 'original procedure',
    version: 1, status: 'active', evaluation: 'manual', sourceRunId: null, createdAt: ctx.now, updatedAt: ctx.now };
  let baseline: SkillRevision | null = null;
  if (withSkill) { state.skills.push(skill); baseline = ensureSkillRevision(state, skill, ctx); }
  return { state, skill, baseline, agentId, skillId, ctx };
}
function candidate(f: ReturnType<typeof fixture>, content = 'candidate procedure', purpose: 'candidate' | 'repair' = 'candidate',
  baseline = f.baseline) {
  return registerSkillCandidate(f.state, { agentId: f.agentId, skillId: f.skillId, name: f.skill.name,
    description: f.skill.description, content, baselineRevisionId: baseline?.id ?? null, sourceRunId: randomUUID(), purpose }, f.ctx);
}
function evidence(baseline: SkillRevision | null, next: SkillRevision, verdict: GrowthVerdict,
  overrides: Partial<ComparisonEvidence> = {}): ComparisonEvidence {
  return {
    fingerprint: { promptHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), model: 'fixture-model', image: 'fixture-image',
      baselineSkillHash: baseline ? skillRevisionHash(baseline) : null, candidateSkillHash: skillRevisionHash(next) },
    baseline: { attemptId: randomUUID(), resultHash: 'c'.repeat(64), completed: true },
    candidate: { attemptId: randomUUID(), resultHash: 'd'.repeat(64), completed: true },
    judgeAttemptId: randomUUID(), verdict, reason: `Independent result: ${verdict}`,
    evidence: ['Comparable completed task outputs were checked.'], usefulChanges: [], failures: [], verified: true,
    ...overrides,
  };
}
function assess(f: ReturnType<typeof fixture>, next: SkillRevision, comparison: ComparisonEvidence | null,
  purpose: 'candidate' | 'regression' | 'repair' = 'candidate', baseline = f.baseline) {
  return applyGrowthAssessment(f.state, { agentId: f.agentId, skillId: f.skillId, baselineRevisionId: baseline?.id ?? null,
    candidateRevisionId: next.id, sourceRunId: randomUUID(), purpose, comparison }, f.ctx);
}

test('revisions preserve immutable prior content and failed candidate versions are never reused', () => {
  const f = fixture(); const original = structuredClone(f.baseline);
  assert.equal(ensureSkillRevision(f.state, f.skill, f.ctx).id, f.baseline!.id);
  const first = candidate(f), second = candidate(f, 'second candidate');
  assert.equal(first.version, 2); assert.equal(second.version, 3);
  assert.equal(f.skill.activeRevisionId, f.baseline!.id);
  assert.deepEqual(f.state.skillRevisions[0], original);
});

test('only verified independent improvement activates a candidate, including a first skill', () => {
  for (const existing of [true, false]) {
    const f = fixture(existing), next = candidate(f);
    const review = assess(f, next, evidence(f.baseline, next, 'improved'));
    assert.equal(review.decision, 'activated'); assert.equal(review.verdict, 'improved');
    assert.equal(f.state.skills[0].activeRevisionId, next.id);
    assert.equal(f.state.skills[0].content, next.content);
    assert.equal(f.state.repairJobs.length, 0);
    if (f.baseline) assert.equal(f.state.skillRevisions[0].content, 'original procedure');
  }
});

test('equivalent and inconclusive findings retain the current skill and do not schedule model repairs', () => {
  for (const verdict of ['equivalent', 'inconclusive'] as const) {
    const f = fixture(), next = candidate(f);
    const review = assess(f, next, evidence(f.baseline, next, verdict, { usefulChanges: ['Possible reusable idea'], failures: ['No demonstrated improvement'] }));
    assert.equal(review.decision, 'kept'); assert.equal(review.verdict, verdict);
    assert.equal(f.skill.activeRevisionId, f.baseline!.id);
    assert.deepEqual(review.usefulChanges, ['Possible reusable idea']);
    assert.deepEqual(review.failures, ['No demonstrated improvement']);
    assert.equal(f.state.repairJobs.length, 0);
    assert.ok(f.state.skillRevisions.includes(next));
  }
});

test('self-reports, missing attempts, content mismatch and incomplete improvement remain inconclusive', () => {
  const changes: Array<(value: ComparisonEvidence) => void> = [
    value => { value.verified = false; },
    value => { value.judgeAttemptId = value.candidate.attemptId; },
    value => { value.baseline.attemptId = ''; },
    value => { value.fingerprint.candidateSkillHash = 'e'.repeat(64); },
    value => { value.fingerprint.baselineSkillHash = null; },
    value => { value.fingerprint.inputHash = 'unknown'; },
    value => { value.evidence = []; },
    value => { value.candidate.completed = false; },
  ];
  for (const change of changes) {
    const f = fixture(), next = candidate(f), proof = evidence(f.baseline, next, 'improved'); change(proof);
    const review = assess(f, next, proof);
    assert.equal(review.decision, 'kept'); assert.equal(review.verdict, 'inconclusive');
    assert.equal(f.skill.activeRevisionId, f.baseline!.id); assert.equal(f.state.repairJobs.length, 0);
  }
  const f = fixture(), next = candidate(f);
  assert.equal(assess(f, next, null).decision, 'kept');
});

test('local replay activation requires a valid input fingerprint and independent applicability decision', () => {
  for (const scenario of ['valid', 'missing-applicability', 'external-required', 'invalid-hash']) {
    const f = fixture(), next = candidate(f), proof = evidence(f.baseline, next, 'improved');
    proof.fingerprint.replayHash = scenario === 'invalid-hash' ? 'invalid' : 'e'.repeat(64);
    proof.replay = { applicability: scenario === 'external-required' ? 'external_required' : 'local',
      prompt: 'Check the local document', criteria: ['The requirement is fulfilled'], artifactIds: [] };
    if (scenario !== 'missing-applicability') proof.replayApplicable = true;
    const review = assess(f, next, proof);
    assert.equal(review.decision, scenario === 'valid' ? 'activated' : 'kept');
    assert.equal(review.verdict, scenario === 'valid' ? 'improved' : 'inconclusive');
  }
});

test('verified regressions restore only the same active skill and preserve memory, files and all history', () => {
  const f = fixture(), next = candidate(f);
  const preserved = { memories: [{ content: 'new memory' }], files: [{ path: 'user-result.bin' }], teams: [{ name: 'peers' }] };
  Object.assign(f.state, structuredClone(preserved));
  assess(f, next, evidence(f.baseline, next, 'improved'));
  const revisions = structuredClone(f.state.skillRevisions);
  const review = assess(f, next, evidence(f.baseline, next, 'regressed', { usefulChanges: ['Useful substep'], failures: ['Completion regression'] }), 'regression');
  assert.equal(review.decision, 'rolled_back'); assert.equal(f.skill.activeRevisionId, f.baseline!.id);
  assert.equal(f.skill.content, 'original procedure'); assert.equal(f.state.growthReviews.length, 2);
  assert.deepEqual(f.state.skillRevisions, revisions);
  for (const [key, value] of Object.entries(preserved)) assert.deepEqual(Reflect.get(f.state, key), value);
  assert.equal(f.state.repairJobs[0].status, 'queued');
  assert.deepEqual(f.state.repairJobs[0].preservedUsefulChanges, ['Useful substep']);
  assert.deepEqual(f.state.repairJobs[0].failures, ['Completion regression']);
});

test('a newly introduced regressing skill is deactivated without deleting its candidate or review', () => {
  const f = fixture(false), next = candidate(f);
  assess(f, next, evidence(null, next, 'improved'));
  const review = assess(f, next, evidence(null, next, 'regressed'), 'regression');
  assert.equal(review.decision, 'rolled_back'); assert.equal(f.state.skills[0].status, 'rejected');
  assert.equal(f.state.skills.some(item => item.status === 'active'), false);
  assert.equal(f.state.skillRevisions.length, 1); assert.equal(f.state.growthReviews.length, 2);
  assert.equal(f.state.repairJobs[0].baselineRevisionId, null);
  assert.equal(f.state.repairJobs[0].status, 'queued');
});

test('candidate-stage regression alone never rolls back an active skill and needs verified useful changes to schedule repair', () => {
  for (const usefulChanges of [[], ['Retain this improvement']]) {
    const f = fixture(), next = candidate(f);
    const review = assess(f, next, evidence(f.baseline, next, 'regressed', { usefulChanges }));
    assert.equal(review.decision, 'kept'); assert.equal(f.skill.activeRevisionId, f.baseline!.id);
    assert.equal(f.state.repairJobs.length, usefulChanges.length ? 1 : 0);
  }
});

test('stale activation or rollback cannot overwrite a later independent revision or queue stale repair', () => {
  const f = fixture(), first = candidate(f), second = candidate(f, 'another procedure');
  assess(f, second, evidence(f.baseline, second, 'improved'));
  assert.equal(assess(f, first, evidence(f.baseline, first, 'improved')).decision, 'kept');
  assert.equal(assess(f, first, evidence(f.baseline, first, 'regressed'), 'regression').decision, 'kept');
  assert.equal(f.skill.activeRevisionId, second.id); assert.equal(f.state.repairJobs.length, 0);
  f.skill.content = 'manual content changed before its new revision was recorded';
  assert.equal(assess(f, second, evidence(f.baseline, second, 'regressed'), 'regression').decision, 'kept');
  assert.equal(f.skill.content, 'manual content changed before its new revision was recorded');
});

test('cross-agent and non-parent baseline assessments fail without modifying either skill', () => {
  const f = fixture(), other = fixture(), next = candidate(f);
  f.state.skills.push(other.skill); f.state.skillRevisions.push(...other.state.skillRevisions);
  const before = structuredClone(f.state);
  assert.throws(() => applyGrowthAssessment(f.state, { agentId: other.agentId, skillId: f.skillId,
    baselineRevisionId: f.baseline!.id, candidateRevisionId: next.id, sourceRunId: randomUUID(), purpose: 'candidate',
    comparison: evidence(f.baseline, next, 'improved') }, f.ctx), { statusCode: 409 });
  const unrelated = candidate(f, 'another parent');
  assert.throws(() => assess(f, next, evidence(unrelated, next, 'improved'), 'candidate', unrelated), { statusCode: 409 });
  assert.deepEqual(f.state.skills, before.skills); assert.equal(f.state.growthReviews.length, 0);
});

test('two unproductive repair attempts hold only repair while preserving all candidates and feedback', () => {
  const f = fixture(), originalCandidate = candidate(f);
  assess(f, originalCandidate, evidence(f.baseline, originalCandidate, 'improved'));
  assess(f, originalCandidate, evidence(f.baseline, originalCandidate, 'regressed', { usefulChanges: ['Keep a sound substep'], failures: ['Bad branch'] }), 'regression');
  const job = f.state.repairJobs[0];
  for (let i = 0; i < 2; i++) {
    updateRepairJob(f.state, job.id, { status: 'running', reason: 'Independent repair', updatedAt: f.ctx.now, runId: randomUUID() });
    const next = candidate(f, `repair attempt ${i}`, 'repair');
    assess(f, next, evidence(f.baseline, next, 'equivalent', { failures: [`Unresolved ${i}`] }), 'repair');
  }
  assert.equal(job.attempts, 2); assert.equal(job.noProgressCount, 2); assert.equal(job.status, 'held');
  assert.match(job.reason, /재수정만 보류/); assert.equal(f.skill.status, 'active');
  assert.equal(f.skill.activeRevisionId, f.baseline!.id);
  assert.deepEqual(job.preservedUsefulChanges, ['Keep a sound substep']);
  assert.deepEqual(job.failures, ['Bad branch', 'Unresolved 0', 'Unresolved 1']);
  assert.equal(f.state.skillRevisions.length, 4); assert.equal(f.state.growthReviews.length, 4);
});

test('verified new partial progress resets only the repair streak and a verified improvement resolves the job', () => {
  const f = fixture(), bad = candidate(f);
  assess(f, bad, evidence(f.baseline, bad, 'improved'));
  assess(f, bad, evidence(f.baseline, bad, 'regressed'), 'regression');
  const job = f.state.repairJobs[0];
  const originalTaskRunId = job.sourceRunId;
  const first = candidate(f, 'first retry', 'repair');
  assess(f, first, evidence(f.baseline, first, 'inconclusive'), 'repair'); assert.equal(job.noProgressCount, 1);
  const second = candidate(f, 'independent partial progress', 'repair');
  assess(f, second, evidence(f.baseline, second, 'regressed', { usefulChanges: ['Verified useful change'] }), 'repair');
  assert.equal(job.noProgressCount, 0); assert.equal(job.status, 'queued');
  const third = candidate(f, 'complete improvement', 'repair');
  assess(f, third, evidence(f.baseline, third, 'improved'), 'repair');
  assert.equal(job.status, 'resolved'); assert.equal(f.skill.activeRevisionId, third.id);
  assert.equal(job.attempts, 3); assert.equal(job.noProgressCount, 0);
  assert.equal(job.sourceRunId, originalTaskRunId);
  assert.throws(() => updateRepairJob(f.state, job.id, { status: 'running', reason: 'replay', updatedAt: f.ctx.now }), { statusCode: 409 });
});

test('unverified feedback or unchanged candidate content cannot reset a no-progress streak', () => {
  const f = fixture(), bad = candidate(f);
  assess(f, bad, evidence(f.baseline, bad, 'improved')); assess(f, bad, evidence(f.baseline, bad, 'regressed'), 'regression');
  const job = f.state.repairJobs[0];
  const first = candidate(f, 'new unverified body', 'repair');
  assess(f, first, evidence(f.baseline, first, 'improved', { verified: false, usefulChanges: ['Author says better'] }), 'repair');
  const second = candidate(f, first.content, 'repair');
  assess(f, second, evidence(f.baseline, second, 'equivalent', { usefulChanges: ['Renamed same claim'] }), 'repair');
  assert.equal(job.noProgressCount, 2); assert.equal(job.status, 'held');
});

test('replaying an identical completed assessment never duplicates reviews or repair attempts', () => {
  const f = fixture(), bad = candidate(f);
  assess(f, bad, evidence(f.baseline, bad, 'improved')); assess(f, bad, evidence(f.baseline, bad, 'regressed'), 'regression');
  const next = candidate(f, 'repeat-safe repair', 'repair');
  const input = { agentId: f.agentId, skillId: f.skillId, baselineRevisionId: f.baseline!.id, candidateRevisionId: next.id,
    sourceRunId: randomUUID(), purpose: 'repair' as const, comparison: evidence(f.baseline, next, 'equivalent') };
  const first = applyGrowthAssessment(f.state, input, f.ctx);
  assert.equal(applyGrowthAssessment(f.state, input, f.ctx).id, first.id);
  assert.equal(f.state.growthReviews.length, 3); assert.equal(f.state.repairJobs[0].attempts, 1);
});

test('snapshot cloning remaps lineage IDs and permits independent later improvements without touching source history', () => {
  const f = fixture(), improved = candidate(f);
  assess(f, improved, evidence(f.baseline, improved, 'improved'));
  const sourceSnapshot = structuredClone(f.skill), originalSkill = structuredClone(f.skill);
  const originalRevisions = structuredClone(f.state.skillRevisions), originalReviews = structuredClone(f.state.growthReviews);
  const target: Skill = { ...structuredClone(sourceSnapshot), id: randomUUID(), agentId: randomUUID() };
  f.state.skills.push(target);
  forkSkillRevisions(f.state, { sourceAgentId: f.agentId, targetAgentId: target.agentId, skills: [{ source: sourceSnapshot, target }] }, f.ctx);
  const inherited = f.state.skillRevisions.find(item => item.id === target.activeRevisionId)!;
  assert.notEqual(inherited.id, improved.id); assert.equal(inherited.content, improved.content);
  assert.notEqual(inherited.parentRevisionId, f.baseline!.id);
  assert.equal(inherited.inheritedFrom!.revisionId, improved.id);
  const next = registerSkillCandidate(f.state, { agentId: target.agentId, skillId: target.id, baselineRevisionId: inherited.id,
    sourceRunId: randomUUID(), name: target.name, description: target.description, content: 'clone-only improvement', purpose: 'candidate' }, f.ctx);
  const review = applyGrowthAssessment(f.state, { agentId: target.agentId, skillId: target.id, baselineRevisionId: inherited.id,
    candidateRevisionId: next.id, sourceRunId: randomUUID(), purpose: 'candidate', comparison: evidence(inherited, next, 'improved') }, f.ctx);
  assert.equal(review.decision, 'activated'); assert.equal(target.content, 'clone-only improvement');
  assert.deepEqual(f.skill, originalSkill); assert.deepEqual(sourceSnapshot, originalSkill);
  assert.deepEqual(f.state.skillRevisions.filter(item => item.agentId === f.agentId), originalRevisions);
  assert.deepEqual(f.state.growthReviews.filter(item => item.agentId === f.agentId), originalReviews);
  assert.equal(f.state.repairJobs.length, 0);
});

test('legacy snapshot cloning does not modify the selected snapshot or use another agent revision', () => {
  const f = fixture(false), source = structuredClone(f.skill), original = structuredClone(source);
  const target = { ...structuredClone(source), id: randomUUID(), agentId: randomUUID() };
  forkSkillRevisions(f.state, { sourceAgentId: source.agentId, targetAgentId: target.agentId, skills: [{ source, target }] }, f.ctx);
  assert.deepEqual(source, original); assert.ok(target.activeRevisionId);
  assert.ok(f.state.skillRevisions.find(item => item.id === target.activeRevisionId && item.agentId === target.agentId));
});

test('skill content binding includes name and description and repair policy is independently configurable', () => {
  const f = fixture();
  assert.notEqual(skillRevisionHash(f.skill), skillRevisionHash({ ...f.skill, name: 'renamed' }));
  assert.notEqual(skillRevisionHash(f.skill), skillRevisionHash({ ...f.skill, description: 'changed selection rules' }));
  const bad = candidate(f); assess(f, bad, evidence(f.baseline, bad, 'improved'));
  assess(f, bad, evidence(f.baseline, bad, 'regressed'), 'regression');
  const next = candidate(f, 'bounded repair', 'repair');
  applyGrowthAssessment(f.state, { agentId: f.agentId, skillId: f.skillId, baselineRevisionId: f.baseline!.id,
    candidateRevisionId: next.id, sourceRunId: randomUUID(), purpose: 'repair', comparison: evidence(f.baseline, next, 'equivalent') }, f.ctx,
  { noProgressLimit: 1 });
  assert.equal(f.state.repairJobs[0].status, 'held');
});

test('later candidates preserve a cancelled held repair instead of restarting or replacing it', () => {
  const f = fixture(), bad = candidate(f);
  assess(f, bad, evidence(f.baseline, bad, 'improved'));
  assess(f, bad, evidence(f.baseline, bad, 'regressed'), 'regression');
  const job = f.state.repairJobs[0];
  updateRepairJob(f.state, job.id, { status: 'held', reason: '사용자가 재수정을 취소했습니다.', updatedAt: f.ctx.now });
  const held = structuredClone(job);
  const later = candidate(f, 'Different ordinary-task candidate');
  const review = assess(f, later, evidence(f.baseline, later, 'regressed', { usefulChanges: ['New but insufficient useful change'] }));
  assert.equal(review.decision, 'kept'); assert.deepEqual(job, held);
  assert.equal(f.state.repairJobs.length, 1, 'an ordinary candidate cannot create a replacement for a held repair');
  assert.ok(f.state.skillRevisions.includes(later));
  assert.ok(f.state.growthReviews.includes(review));
  const improved = candidate(f, 'Independent subsequent improvement');
  assert.equal(assess(f, improved, evidence(f.baseline, improved, 'improved')).decision, 'activated');
  assert.deepEqual(job, held, 'an unrelated later success must retain the cancelled job and its reason');
});

test('a held no-progress streak cannot be reset by late repair feedback or a fresh candidate', () => {
  const f = fixture(), bad = candidate(f);
  assess(f, bad, evidence(f.baseline, bad, 'improved'));
  assess(f, bad, evidence(f.baseline, bad, 'regressed'), 'regression');
  for (let i = 0; i < 2; i++) {
    const retry = candidate(f, `Unproductive retry ${i}`, 'repair');
    assess(f, retry, evidence(f.baseline, retry, 'equivalent'), 'repair');
  }
  const job = f.state.repairJobs[0], held = structuredClone(job);
  assert.equal(job.status, 'held'); assert.equal(job.noProgressCount, 2);
  for (const purpose of ['repair', 'candidate'] as const) {
    const next = candidate(f, `New proposal after hold ${purpose}`, purpose);
    assess(f, next, evidence(f.baseline, next, 'regressed', { usefulChanges: ['Claimed new partial progress'] }), purpose);
  }
  assert.deepEqual(job, held); assert.equal(f.state.repairJobs.length, 1);
});
