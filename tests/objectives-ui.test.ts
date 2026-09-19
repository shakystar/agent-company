import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Memory, Run, Workspace } from '../shared/types.ts';
import type { Objective, ObjectiveEvaluation } from '../shared/objectives.ts';
import type { TeamTask } from '../shared/collaboration.ts';
import { appLocation } from '../src/App.tsx';
import { currentObjectiveEvaluation, ObjectiveConfirmation, ObjectiveDetail, ObjectiveEvidenceList, ObjectiveForm, ObjectiveGrowth, ObjectivesView } from '../src/ObjectivesView.tsx';

const date = '2026-09-11T12:00:00.000Z';
const agent: Agent = { id: 'agent', name: 'Maker', description: '', persona: 'Work within scope', color: '#72836b', model: 'fixture', status: 'idle',
  generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const objective: Objective = { id: 'objective', idempotencyKey: 'create-once', teamId: 'team', scope: { type: 'team', id: 'team' }, title: '검증된 인도',
  purpose: '합의한 완료 조건을 확인합니다.', constraints: '승인한 저장소만 사용합니다.', conditions: [
    { id: 'tested', text: '예약 검사가 통과합니다.', requiresUserConfirmation: false },
    { id: 'accepted', text: '사용자가 화면을 확인합니다.', requiresUserConfirmation: true },
  ], confirmations: [], status: 'active', version: 2, blockedReason: null, lastInputHash: 'a'.repeat(64), lastEvaluationId: 'evaluation', createdAt: date, updatedAt: date };
const evaluation: ObjectiveEvaluation = { id: 'evaluation', objectiveId: objective.id, objectiveVersion: 1, inputHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64), runId: 'evaluation-run',
  status: 'applied', assessment: { inputHash: 'a'.repeat(64), reason: '검사를 보충하고 화면 확인을 기다립니다.', conditions: [
    { conditionId: 'tested', status: 'unmet', reason: '저장 실패 검사가 없습니다.', evidenceIds: ['artifact:artifact:1'] },
    { conditionId: 'accepted', status: 'needs_user', reason: '사용자 확인이 없습니다.', evidenceIds: [] },
  ], followUps: [{ conditionIds: ['tested'], title: '실패 경로 검사', description: '저장 실패와 재시도를 확인합니다.' }] }, taskIds: ['task'], reason: '검사를 보충합니다.',
  createdAt: date, completedAt: date, evidence: [{ id: 'artifact:artifact:1', kind: 'artifact', sourceId: 'artifact', version: 1, title: 'qa/frozen.md', sha256: 'c'.repeat(64) }] };
const run: Run = { id: 'run', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Check failure behavior', status: 'succeeded', result: 'checked', error: null,
  inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: date, startedAt: date, completedAt: date, conversationId: 'conversation', teamTaskId: 'task' };
const task: TeamTask = { id: 'task', scope: objective.scope, title: '실패 경로 검사', description: '저장 실패와 재시도를 확인합니다.', status: 'done',
  assigneeAgentId: agent.id, claimedRunId: run.id, createdByAgentId: null, version: 3, outcome: 'Failure behavior checked', artifactIds: [], createdAt: date, updatedAt: date, completedAt: date };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], teams: [{ id: 'team', name: 'Studio', description: '', workflow: '', memberIds: [agent.id],
  version: 1, createdAt: date, updatedAt: date }], runs: [run], skills: [], memories: [], snapshots: [], activities: [], approvals: [], connections: [],
  runtime: { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: 'No model calls' },
  objectives: [objective], objectiveEvaluations: [evaluation], teamTasks: [task], ...extra });
const detail = (item: Objective = objective, state = workspace()) => renderToStaticMarkup(createElement(ObjectiveDetail, {
  objective: item, workspace: state, refresh: async () => {}, onSelect: () => {}, onEdit: () => {},
}));

test('objective route and empty legacy workspace expose purpose registration without fabricating progress', () => {
  assert.deepEqual(appLocation('#objectives'), { view: 'objectives', conversationId: null });
  const html = renderToStaticMarkup(createElement(ObjectivesView, { workspace: workspace({ objectives: undefined, objectiveEvaluations: undefined }), refresh: async () => {}, onSelect: () => {} }));
  assert.match(html, /등록한 목적이 없습니다/); assert.match(html, /목적 등록/); assert.doesNotMatch(html, /목적 완료 · 대기/);
});

test('current conditions follow the applied evaluation pointer, never a later failed or queued assessment', () => {
  const failed = { ...evaluation, id: 'failed', status: 'failed' as const, createdAt: '2026-09-12T12:00:00.000Z' };
  assert.equal(currentObjectiveEvaluation(objective, [failed, evaluation]), evaluation);
  assert.equal(currentObjectiveEvaluation({ ...objective, lastEvaluationId: null }, [evaluation]), undefined);
  assert.equal(currentObjectiveEvaluation({ ...objective, lastEvaluationId: failed.id }, [failed, evaluation]), undefined);
  assert.equal(currentObjectiveEvaluation(objective, [{ ...evaluation, objectiveId: 'other' }]), undefined);
  const html = detail(objective, workspace({ objectiveEvaluations: [failed, evaluation] }));
  assert.match(html, /저장 실패 검사가 없습니다/); assert.match(html, /사용자 확인 대기/); assert.match(html, /평가 실패/);
});

test('lifecycle controls preserve paused editing, completed reevaluation, and cancelled terminal state', () => {
  const active = detail(); assert.match(active, />일시 정지</); assert.match(active, />다시 평가</); assert.match(active, />목적 중단</); assert.doesNotMatch(active, />목적 편집</);
  const paused = detail({ ...objective, status: 'paused' }); assert.match(paused, />다시 진행</); assert.match(paused, />목적 편집</); assert.doesNotMatch(paused, />다시 평가</);
  const completed = detail({ ...objective, status: 'completed' }); assert.match(completed, /목적 완료 · 대기/); assert.match(completed, />다시 평가</); assert.doesNotMatch(completed, />목적 중단</);
  const cancelled = detail({ ...objective, status: 'cancelled' }); assert.match(cancelled, /중단됨/); assert.doesNotMatch(cancelled, />다시 진행<|>다시 평가<|>목적 편집<|>이 조건 확인 기록</);
});

test('registration requires result and conditions, limits project scope to the selected team, and defaults user confirmation off', () => {
  const projects = [{ id: 'ours', name: 'Authorized project', description: '', teamIds: ['team'], version: 1, createdAt: date, updatedAt: date },
    { id: 'other', name: 'Other team project', description: '', teamIds: ['other-team'], version: 1, createdAt: date, updatedAt: date }];
  const html = renderToStaticMarkup(createElement(ObjectiveForm, { workspace: workspace({ projects }), onClose: () => {}, onSaved: async () => {} }));
  assert.match(html, /Authorized project/); assert.doesNotMatch(html, /Other team project/);
  assert.match(html, /required=""[^>]*maxLength="200"/); assert.match(html, /완료 시 사용자 확인 필수/);
  assert.doesNotMatch(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '', /checked/);
  assert.match(html, /type="submit" disabled="">목적 등록·평가 시작/); assert.match(html, /모델 사용량에 포함/);
  const editing = renderToStaticMarkup(createElement(ObjectiveForm, { objective: { ...objective, status: 'paused' }, workspace: workspace({ projects }), onClose: () => {}, onSaved: async () => {} }));
  assert.match(editing, /checked=""/); assert.match(editing, /value="검증된 인도"/); assert.match(editing, /입력을 보존하고 충돌/);
});

test('human confirmation stays explicit and requires a written observation before submission', () => {
  const html = renderToStaticMarkup(createElement(ObjectiveConfirmation, { objectiveId: objective.id,
    condition: { conditionId: 'accepted', text: '사용자가 화면을 확인합니다.', version: objective.version }, onClose: () => {}, onSaved: async () => {} }));
  assert.match(html, /직접 확인한 내용/); assert.match(html, /<textarea required=""/); assert.match(html, /type="submit" disabled=""/);
  const confirmed = detail({ ...objective, confirmations: [{ conditionId: 'accepted', note: '직접 예약을 완료했습니다.', createdAt: date }] });
  assert.match(confirmed, /직접 예약을 완료했습니다/); assert.match(confirmed, /확인 기록/); assert.doesNotMatch(confirmed, />이 조건 확인 기록</);
  assert.match(confirmed, /사용자 확인 대기/); // A user note does not rewrite the saved model assessment in the UI.
});

test('evidence metadata remains frozen and absent provenance never falls back to a current source', () => {
  const html = renderToStaticMarkup(createElement(ObjectiveEvidenceList, { evaluation, ids: ['artifact:artifact:1', 'missing'] }));
  assert.match(html, /qa\/frozen.md · 공유 자료 · v1/); assert.match(html, /평가 당시 고정본/); assert.match(html, new RegExp('c'.repeat(64)));
  assert.match(html, /평가에 사용한 원문 보기/); assert.match(html, /근거 원문 미확인/); assert.match(html, /현재 자료로 대체하지 않습니다/);
  assert.match(html, /JSON 문자열 해시/); assert.doesNotMatch(html, /원문 SHA-256/);
  const raw = renderToStaticMarkup(createElement(ObjectiveEvidenceList, { evaluation: { ...evaluation,
    evidence: [{ ...evaluation.evidence[0], hashEncoding: 'utf8' }] }, ids: ['artifact:artifact:1'] }));
  assert.match(raw, /원문 SHA-256/); assert.doesNotMatch(raw, /JSON 문자열 해시/);
  const unsafe = renderToStaticMarkup(createElement(ObjectiveEvidenceList, { evaluation: { ...evaluation, evidence: [{ ...evaluation.evidence[0], title: '<script>bad()</script>' }] }, ids: ['artifact:artifact:1'] }));
  assert.doesNotMatch(unsafe, /<script>/); assert.match(unsafe, /&lt;script&gt;/);
});

test('follow-up results link to the claimed execution while opt-out and blockers remain visible', () => {
  const html = detail({ ...objective, blockedReason: '팀 모델 한도 대기' });
  assert.match(html, /팀 모델 한도 대기/); assert.match(html, /열린 과제 자동 탐색이 꺼져 있습니다/);
  assert.match(html, /Failure behavior checked/); assert.match(html, /href="#conversation\/conversation"/);
  const enabled = detail(objective, workspace({ teams: workspace().teams.map(team => ({ ...team, autoDiscoverTasks: true })) }));
  assert.doesNotMatch(enabled, /열린 과제 자동 탐색이 꺼져 있습니다/);
});

test('purpose growth counts only connected task input memories and does not assert reuse or improvement', () => {
  const memory: Memory = { id: 'remembered', agentId: agent.id, kind: 'procedure', title: 'Stored failure check', content: 'Check exceptions', sourceRunId: 'earlier-run', createdAt: date, updatedAt: date };
  const state = workspace({ memories: [memory, { ...memory, id: 'new', title: 'New observation', sourceRunId: run.id }, { ...memory, id: 'other', title: 'Unrelated private memory', sourceRunId: 'other-run' }],
    snapshots: [{ id: 'snapshot', agentId: agent.id, label: 'Task input', agentVersion: 1, agent, memories: [memory], skills: [], sourceRunId: null, createdAt: date }] });
  const html = renderToStaticMarkup(createElement(ObjectiveGrowth, { workspace: state, tasks: [task], onSelect: () => {} }));
  assert.match(html, /작업에 제공한 기존 기억 <strong>1/); assert.match(html, /작업에서 남긴 기억 <strong>1/); assert.match(html, /스킬 비교 판정 <strong>0/);
  assert.match(html, /Stored failure check/); assert.match(html, /New observation/); assert.doesNotMatch(html, /Unrelated private memory/);
  assert.match(html, /기억 제공 기록은 실제 활용이나 품질 개선의 판정과 구분/); assert.match(html, /연결된 품질 비교 판정이 없습니다/);
});
