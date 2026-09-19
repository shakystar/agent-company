import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Run, Skill, Workspace } from '../shared/types.ts';
import type { GrowthReview, RepairJob, SkillRevision } from '../shared/growth.ts';
import type { ModelAttempt } from '../shared/telemetry.ts';
import { UsageView, observedDuration, observedNumber, attemptLabel } from '../src/UsageView.tsx';
import { GrowthView, SkillCatalog } from '../src/GrowthView.tsx';
import { AgentDetail } from '../src/AgentDetail.tsx';
import { LearningReviewView } from '../src/LearningReviewView.tsx';

const date = '2026-09-06T12:00:00.000Z';
const agent: Agent = { id: 'agent', name: 'Agent', description: '', persona: 'Test', model: 'fixture', status: 'idle',
  color: '#72836b', generation: 0, parentId: null, parentSnapshotId: null, version: 1,
  allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const skill: Skill = { id: 'skill', agentId: agent.id, name: 'A skill', description: 'Description', content: 'shadow content',
  version: 1, status: 'active', activeRevisionId: 'baseline', evaluation: 'Existing evidence', sourceRunId: null, createdAt: date, updatedAt: date };
const baseline: SkillRevision = { id: 'baseline', agentId: agent.id, skillId: skill.id, name: skill.name, description: skill.description,
  content: 'Current baseline content', version: 1, parentRevisionId: null, sourceRunId: null, origin: 'manual', createdAt: date };
const candidate: SkillRevision = { ...baseline, id: 'candidate', content: 'Preserved candidate content', version: 2,
  parentRevisionId: baseline.id, sourceRunId: 'run', origin: 'candidate' };
const attempt: ModelAttempt = { id: 'attempt', runId: 'run', model: 'fixture', phase: 'evaluate', kind: 'judge', reason: 'Compare quality',
  status: 'failed', startedAt: date, completedAt: date, durationMs: null,
  usage: { status: 'unknown', inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
  observations: [], observationsTruncated: false, error: '<script>not executable</script>' };
const review: GrowthReview = { id: 'review', agentId: agent.id, skillId: skill.id, baselineRevisionId: baseline.id,
  candidateRevisionId: candidate.id, sourceRunId: 'run', purpose: 'regression', verdict: 'regressed', decision: 'rolled_back',
  reason: 'Completion regressed', comparison: null, usefulChanges: ['Keep useful formatting'], failures: ['Missing required output'], createdAt: date };
const repair: RepairJob = { id: 'repair', agentId: agent.id, skillId: skill.id, baselineRevisionId: baseline.id,
  candidateRevisionId: candidate.id, sourceReviewId: review.id, sourceRunId: 'run', status: 'held', attempts: 2,
  noProgressCount: 2, preservedUsefulChanges: review.usefulChanges, failures: review.failures,
  reason: 'No progress repeated', createdAt: date, updatedAt: date };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], skills: [skill], runs: [], memories: [], snapshots: [],
  activities: [], teams: [], approvals: [], connections: [], runtime: { mode: 'docker', available: false, authenticated: false,
    image: 'fixture', model: 'fixture', version: null, message: 'no model' }, skillRevisions: [baseline, candidate],
  growthReviews: [review], repairJobs: [repair], modelAttempts: [], ...extra });

test('usage UI distinguishes missing observations from actual zero and does not treat cache as extra total', () => {
  assert.equal(attemptLabel({ phase: 'trial', kind: 'baseline-trial' }), '기준 비교');
  assert.equal(attemptLabel({ phase: 'trial', kind: 'candidate-trial' }), '후보 비교');
  assert.equal(attemptLabel({ phase: 'trial', kind: 'fixture-trial' }), '비교 실행');
  assert.equal(attemptLabel({ phase: 'task', kind: 'baseline-trial' }), '작업');
  assert.equal(observedNumber(null), '미확인'); assert.equal(observedNumber(0), '0');
  assert.equal(observedDuration(null), '미확인'); assert.equal(observedDuration(0), '0 ms');
  assert.equal(observedDuration(119_999), '2분 0초');
  const html = renderToStaticMarkup(createElement(UsageView, { attempts: [attempt] }));
  assert.match(html, /미확인/); assert.match(html, /호출 실패/); assert.doesNotMatch(html, /입력 0|출력 0/);
  assert.match(html, /성장 판정에 사용하지 않습니다/); assert.match(html, /총량으로 계산하지 않습니다/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  const partial = renderToStaticMarkup(createElement(UsageView, { attempts: [{ ...attempt, status: 'succeeded', durationMs: 0,
    usage: { ...attempt.usage, status: 'partial', inputTokens: 0, outputTokens: 5 } }] }));
  assert.match(partial, /부분 보고/); assert.match(partial, /입력 0/); assert.match(partial, /출력 5/); assert.match(partial, /0 ms/);
});

test('legacy aggregates are separately qualified and an old zero remains unknown', () => {
  const html = renderToStaticMarkup(createElement(UsageView, { attempts: [], legacy: { inputTokens: 123, outputTokens: 0 } }));
  assert.match(html, /이전 집계값/); assert.match(html, /입력 123/); assert.match(html, /출력 미확인/);
  assert.match(html, /완전성을 확인할 수 없습니다/);
});

test('growth UI separates rollback, preserved candidates, held repair and missing comparison evidence', () => {
  const html = renderToStaticMarkup(createElement(GrowthView, { agent, workspace: workspace() }));
  assert.match(html, /정상 버전 복귀/); assert.match(html, /회귀/); assert.match(html, /수정만 보류/);
  assert.match(html, /정상 버전 복귀 근거 · 아래 판정은 회귀한 후보에 대한 기록입니다/);
  assert.match(html, /다른 작업을 중지하는 상태가 아닙니다/);
  assert.match(html, /Current baseline content/); assert.match(html, /Preserved candidate content/);
  assert.match(html, /독립 비교 실행 근거가 기록되지 않았습니다/); assert.doesNotMatch(html, /검증된 비교 실행 기록/);
  assert.match(html, /Keep useful formatting/); assert.match(html, /Missing required output/);
});

test('skill catalog follows the active revision and empty growth does not assert improvement', () => {
  const html = renderToStaticMarkup(createElement(SkillCatalog, { skills: [skill], revisions: [baseline, candidate], busy: true,
    onAdd: () => {}, onShowGrowth: () => {} }));
  assert.match(html, /Current baseline content/); assert.doesNotMatch(html, /shadow content/); assert.doesNotMatch(html, /Preserved candidate content/);
  assert.match(html, /disabled/);
  const empty = renderToStaticMarkup(createElement(GrowthView, { agent, workspace: workspace({ skills: [], skillRevisions: [], growthReviews: [], repairJobs: [] }) }));
  assert.match(empty, /완료·품질 비교 기록이 없습니다/); assert.match(empty, /성능 개선을 확인한 것으로 표시하지 않습니다/);
});

test('fixed comparison runs retain cancellation without exposing task steering', () => {
  const run: Run = { id: 'run', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Fixed comparison',
    status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [],
    createdAt: date, startedAt: date, completedAt: null };
  const render = (kind: Run['kind']) => renderToStaticMarkup(createElement(AgentDetail, { agent,
    workspace: workspace({ runs: [{ ...run, kind }] }), onBack: () => {}, onSelect: () => {}, refresh: async () => {} }));
  for (const kind of ['review', 'repair'] as const) {
    const html = render(kind);
    assert.match(html, /비교 중에는 과제와 입력 조건을 고정합니다/);
    assert.match(html, /작업 취소/); assert.doesNotMatch(html, /id="steering"/);
  }
  assert.match(render('task'), /id="steering"/);
});

const learningRun: Run = { id: 'learning-run', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Reusable work',
  status: 'succeeded', result: 'Result', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [],
  createdAt: date, startedAt: date, completedAt: date,
  learningReview: { inputHash: 'input', status: 'reviewed', reason: '기존 기억과 중복되어 추가 제안하지 않았습니다.',
    evidence: [{ sourceId: 'result', quote: '<script>Repeated result</script>' }], memoryCount: 0, skillCount: 0, completedAt: date } };

test('learning review distinguishes reviewed zero proposals, deferred and missing records', () => {
  const render = (run: Run) => renderToStaticMarkup(createElement(LearningReviewView, { run }));
  const reviewed = render(learningRun);
  assert.match(reviewed, /검토 완료/);
  assert.match(reviewed, /기존 기억과 중복되어 추가 제안하지 않았습니다/);
  assert.match(reviewed, /기억 제안 0개 · 스킬 후보 제안 0개/);
  assert.match(reviewed, /&lt;script&gt;Repeated result&lt;\/script&gt;/);
  assert.doesNotMatch(reviewed, /<script>|미검토|검토 보류|최종 반영 대기/);
  const deferred = render({ ...learningRun, learningReview: { ...learningRun.learningReview!, status: 'deferred', reason: '검토 호출에 실패했습니다.' } });
  assert.match(deferred, /검토 보류/); assert.match(deferred, /검토 호출에 실패했습니다/);
  assert.doesNotMatch(deferred, /검토 완료|미검토/);
  const missing = render({ ...learningRun, learningReview: undefined });
  assert.match(missing, /미검토/); assert.match(missing, /제안할 내용이 없다고 판정된 상태와 구분합니다/);
  assert.doesNotMatch(missing, /검토 보류|기억 제안 0개/);
});

test('waiting review proposals are not presented as activated skills or finalized memories', () => {
  const html = renderToStaticMarkup(createElement(LearningReviewView, { run: { ...learningRun, status: 'waiting', completedAt: null,
    learningReview: { ...learningRun.learningReview!, memoryCount: 1, skillCount: 2 } } }));
  assert.match(html, /최종 반영 대기/);
  assert.match(html, /기억 제안 1개 · 스킬 후보 제안 2개/);
  assert.match(html, /저장된 기억과 적용 중 스킬 수는 별도로 확인합니다/);
  assert.doesNotMatch(html, /스킬 2개 적용|기억 1개 저장/);
});

test('growth learning reviews are agent-scoped, latest-first and count unreviewed task runs', () => {
  const later = { ...learningRun, id: 'later', prompt: 'Latest task', learningReview: { ...learningRun.learningReview!, completedAt: '2026-09-07T12:00:00.000Z' } };
  const html = renderToStaticMarkup(createElement(GrowthView, { agent, workspace: workspace({ runs: [learningRun, later,
    { ...learningRun, id: 'other', agentId: 'another-agent', prompt: 'Other agent secret' },
    { ...learningRun, id: 'unreviewed', learningReview: undefined },
    { ...learningRun, id: 'comparison', kind: 'review', learningReview: undefined },
    { ...learningRun, id: 'consultation', consultationOfRunId: learningRun.id, learningReview: undefined },
    { ...learningRun, id: 'discussion', interactionMode: 'discuss', learningReview: undefined },
    { ...learningRun, id: 'routing', interactionMode: 'auto', learningReview: undefined },
    { ...learningRun, id: 'objective', objectiveEvaluationId: 'objective-assessment', learningReview: undefined }] }) }));
  assert.match(html, /미검토 1건/);
  assert.ok(html.indexOf('Latest task') < html.indexOf('Reusable work'));
  assert.doesNotMatch(html, /Other agent secret/);
});

test('run detail exposes a learning review even when no memory or skill was created', () => {
  const html = renderToStaticMarkup(createElement(AgentDetail, { agent, workspace: workspace({ runs: [learningRun], memories: [], skills: [] }),
    onBack: () => {}, onSelect: () => {}, refresh: async () => {} }));
  assert.match(html, /학습 검토/); assert.match(html, /기억 제안 0개 · 스킬 후보 제안 0개/);
  assert.match(html, /기존 기억과 중복되어 추가 제안하지 않았습니다/);
});
