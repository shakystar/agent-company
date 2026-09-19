import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Run, Team, Workspace } from '../shared/types.ts';
import type { TeamTask } from '../shared/collaboration.ts';
import { TeamForm, TeamsView, TeamTaskDiscoveryStatus } from '../src/WorkspaceViews.tsx';
import { TaskCard, teamTaskRun } from '../src/CollaborationView.tsx';

const date = '2026-09-07T14:00:00.000Z';
const agent: Agent = { id: 'agent', name: 'Maker', description: '', persona: 'Build within the task', color: '#72836b', model: 'fixture', status: 'idle',
  generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const team: Team = { id: 'team', name: 'Studio', description: 'Purpose remains saved', workflow: '# Shared outcome', memberIds: [agent.id], version: 1, createdAt: date, updatedAt: date };
const run: Run = { id: 'claimed-run', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Actual task', status: 'running', result: '', error: null,
  inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: date, startedAt: date, completedAt: null, conversationId: 'conversation' };
const task: TeamTask = { id: 'task', scope: { type: 'team', id: team.id }, title: 'Shared task', description: 'Done when verified', status: 'claimed',
  assigneeAgentId: agent.id, createdByAgentId: null, version: 2, outcome: '', artifactIds: [], createdAt: date, updatedAt: date, completedAt: null };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], teams: [team], runs: [run], skills: [], memories: [], snapshots: [], activities: [], approvals: [], connections: [],
  runtime: { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: 'No model calls' }, ...extra });
const discoveryCheckbox = (html: string) => html.match(/<input[^>]*aria-describedby="[^"]*"[^>]*>/)?.[0] ?? '';

test('new and legacy teams default task discovery off without changing other team fields', () => {
  for (const value of [undefined, team, { ...team, autoDiscoverTasks: false }]) {
    const html = renderToStaticMarkup(createElement(TeamForm, { team: value, agents: [agent], onClose: () => {}, onSaved: async () => {} }));
    const checkbox = discoveryCheckbox(html);
    assert.match(checkbox, /type="checkbox"/); assert.doesNotMatch(checkbox, /checked=""/);
    assert.match(html, /열린 과제 자동 탐색/);
    assert.match(html, /유휴 팀원이 새 과제를 확인하고 자청 여부를 판단합니다/);
    assert.match(html, /끄면 새 탐색만 멈추며 진행 중 작업·동료 메시지는 별도입니다/);
    if (value) { assert.match(html, /value="Studio"/); assert.match(html, /Purpose remains saved/); assert.match(html, /# Shared outcome/); }
  }
});

test('editing an enabled team preserves its checked value and labels it as discovery rather than whole-team control', () => {
  const enabled = { ...team, autoDiscoverTasks: true };
  const html = renderToStaticMarkup(createElement(TeamForm, { team: enabled, agents: [agent], onClose: () => {}, onSaved: async () => {} }));
  assert.match(discoveryCheckbox(html), /checked=""/);
  assert.match(html, /팀 편집/); assert.doesNotMatch(html, /전체 자율|전체 작업 중지|목표 엔진/);
  assert.equal(enabled.autoDiscoverTasks, true); assert.deepEqual(enabled.memberIds, [agent.id]);
});

test('the selected team exposes saved discovery state while preserving team collaboration controls', () => {
  for (const enabled of [undefined, false, true]) {
    const item = { ...team, autoDiscoverTasks: enabled };
    const status = renderToStaticMarkup(createElement(TeamTaskDiscoveryStatus, { team: item }));
    assert.match(status, /aria-label="열린 과제 자동 탐색 상태"/);
    assert.match(status, enabled ? />켜짐</ : />꺼짐</);
    const html = renderToStaticMarkup(createElement(TeamsView, { workspace: workspace({ teams: [item] }), refresh: async () => {}, onSelect: () => {} }));
    assert.match(html, enabled ? />켜짐</ : />꺼짐</);
    assert.match(html, /공동 작업판/); assert.match(html, /대화형 작업실/); assert.match(html, /워크플로우/);
  }
});

test('task execution links prefer the explicitly claimed run and never substitute a different run for a missing claim', () => {
  const older = { ...run, id: 'old-run', teamTaskId: task.id, createdAt: '2026-09-07T12:00:00.000Z' };
  const newer = { ...run, id: 'new-run', teamTaskId: task.id, createdAt: '2026-09-07T15:00:00.000Z' };
  const runs = [older, newer, run];
  assert.equal(teamTaskRun({ ...task, claimedRunId: run.id }, runs)?.id, run.id);
  assert.equal(teamTaskRun(task, runs)?.id, newer.id);
  assert.equal(teamTaskRun({ ...task, claimedRunId: 'missing' }, runs), undefined);
  assert.deepEqual(runs.map(item => item.id), [older.id, newer.id, run.id]);
  const render = (item: TeamTask, entries = runs) => renderToStaticMarkup(createElement(TaskCard, {
    task: item, scope: item.scope, members: [agent], workspace: workspace({ runs: entries }), refresh: async () => {}, onSelect: () => {},
  }));
  const html = render({ ...task, claimedRunId: run.id });
  assert.match(html, /href="#conversation\/conversation"/); assert.match(html, /title="claimed-run"/); assert.match(html, /연결 작업 대화/);
  const missing = render({ ...task, claimedRunId: 'missing' });
  assert.match(missing, /연결 실행을 확인하지 못했습니다/); assert.doesNotMatch(missing, /연결 작업 대화/);
  const direct = render({ ...task, claimedRunId: run.id }, [{ ...run, conversationId: undefined }]);
  assert.match(direct, /실행 에이전트 보기/); assert.doesNotMatch(direct, /#conversation/);
});
