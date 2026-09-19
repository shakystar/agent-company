import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Run, Workspace } from '../shared/types.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';
import { BudgetProjectSelect, BudgetTeamSelect, ModelBudgetEditor, ModelBudgetSummary, ModelBudgetView, RunBudgetNotice,
  budgetProjects, budgetTeams, budgetTeamSelection, budgetResetLabel, modelBudgetDraft, parseModelBudgetDraft } from '../src/ModelBudgetView.tsx';
import { ConversationRun, ConversationWorkspace } from '../src/ConversationView.tsx';
import { AgentDetail } from '../src/AgentDetail.tsx';
import { MessageForm, TaskCard, TaskForm } from '../src/CollaborationView.tsx';
import type { PeerMessage, TeamTask } from '../shared/collaboration.ts';

const date = '2026-09-07T03:00:00.000Z';
const agent: Agent = { id: 'agent', name: 'Writer', description: '', persona: '', model: 'fixture', status: 'idle', color: '#72836b', generation: 0,
  parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const run: Run = { id: 'run', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Internal task wrapper', status: 'waiting',
  result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], kind: 'task', createdAt: date, startedAt: date, completedAt: null,
  budgetProjectId: 'project', budgetRootRunId: 'root', modelBudgetPaused: true, conversationId: 'conversation', conversationMessageId: 'message' };
const budget: OperationalBudgetStatus = { enabled: true, date: '2026-09-07', timezone: 'Asia/Seoul', resetAt: '2026-09-07T15:00:00.000Z', revision: 2,
  dailyLimit: 100, used: 11, remaining: 89, projectDailyLimits: { project: 5 },
  projects: [{ projectId: 'project', limit: 5, used: 5, remaining: 0 }, { projectId: 'other', limit: null, used: 2, remaining: null }],
  waiting: [{ runId: run.id, projectId: 'project', rootRunId: 'root', blockedBy: 'project', reason: 'Project daily cap reached', resetAt: '2026-09-07T15:00:00.000Z' }] };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], skills: [], runs: [run], memories: [], snapshots: [], activities: [],
  teams: [{ id: 'team', name: 'Team', memberIds: [agent.id], workflow: '', description: '', version: 1, createdAt: date, updatedAt: date }],
  projects: [{ id: 'project', name: 'Article', teamIds: ['team'], description: '', version: 1, createdAt: date, updatedAt: date },
    { id: 'other', name: 'Other project', teamIds: [], description: '', version: 1, createdAt: date, updatedAt: date }],
  approvals: [], connections: [], runtime: { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: 'no model' },
  conversationMessages: [{ id: 'message', conversationId: 'conversation', content: 'Actual user task', senderAgentId: null, mode: 'task', replyToId: null,
    sourceRunId: null, idempotencyKey: 'key', deliveries: [], createdAt: date }], modelBudget: budget, ...extra });
const allScopesBudget: OperationalBudgetStatus = { ...budget, dailyLimit: 500, remaining: 489, teamDailyLimits: { team: 12 }, agentDailyLimits: { agent: 8 },
  teams: [{ teamId: 'team', limit: 12, used: 7, remaining: 5 }], agents: [{ agentId: 'agent', limit: 8, used: 6, remaining: 2 }],
  legacyUnattributed: { team: 3, agent: 2 } };

test('budget drafts preserve independent values and send a revision-checked partial settings shape', () => {
  const draft = modelBudgetDraft(budget);
  assert.deepEqual(draft, { expectedRevision: 2, dailyLimit: '100', projectDailyLimits: { project: '5' } });
  draft.dailyLimit = '120'; draft.projectDailyLimits.project = '';
  assert.deepEqual(parseModelBudgetDraft(draft), { expectedRevision: 2, dailyLimit: 120, projectDailyLimits: { project: null } });
  assert.equal(budget.dailyLimit, 100); assert.equal(budget.projectDailyLimits.project, 5);
  draft.dailyLimit = '0'; draft.projectDailyLimits.project = '0';
  assert.deepEqual(parseModelBudgetDraft(draft), { expectedRevision: 2, dailyLimit: 0, projectDailyLimits: { project: 0 } });
});

test('invalid budget input is rejected without clearing or changing the user draft', () => {
  for (const invalid of ['', '-1', '1.1', '1e3', 'NaN', '1000001', 'Infinity']) {
    const draft = modelBudgetDraft(budget); draft.dailyLimit = invalid; const original = structuredClone(draft);
    assert.throws(() => parseModelBudgetDraft(draft), /0부터 1,000,000까지의 정수/); assert.deepEqual(draft, original);
  }
  const draft = modelBudgetDraft(budget); draft.projectDailyLimits.project = '-2';
  assert.throws(() => parseModelBudgetDraft(draft), /프로젝트 일일 상한/); assert.equal(draft.projectDailyLimits.project, '-2');
  draft.projectDailyLimits.project = '1000000'; assert.equal(parseModelBudgetDraft(draft).projectDailyLimits.project, 1_000_000);
});

test('model budget display separates global cap, optional project cap and actual used counts', () => {
  const html = renderToStaticMarkup(createElement(ModelBudgetView, { workspace: workspace(), refresh: async () => {} }));
  assert.match(html, /100<small>회/); assert.match(html, /11<small>회/); assert.match(html, /89<small>회/);
  assert.match(html, /Article/); assert.match(html, /Other project/); assert.match(html, /별도 제한 없음/); assert.match(html, /전체 잔여 한도 내/);
  assert.match(html, /예약량이 아닙니다/); assert.match(html, /품질 점수로 사용하지 않습니다/); assert.match(html, /프로젝트 없는 개인 작업도 전체 사용량에 포함/);
  assert.match(html, /프로젝트 한도 소진/); assert.match(html, /Actual user task/); assert.doesNotMatch(html, /Internal task wrapper/);
  assert.match(html, /#conversation\/conversation/); assert.match(html, /일시정지·취소는 자동 해제하지 않습니다/);
});

test('missing budget status is not presented as zero usage or an unlimited runtime', () => {
  const state = workspace({ modelBudget: undefined });
  const html = renderToStaticMarkup(createElement(ModelBudgetView, { workspace: state, refresh: async () => {} }));
  assert.match(html, /운영 한도 정보를 확인하지 못했습니다/); assert.match(html, /확인되지 않은 사용량/);
  assert.doesNotMatch(html, /오늘 모델 시작<|전체 일일 상한</);
  assert.equal(renderToStaticMarkup(createElement(ModelBudgetSummary, { workspace: state })), '');
});

test('summary advertises global remaining capacity without treating a project block as global exhaustion', () => {
  const html = renderToStaticMarkup(createElement(ModelBudgetSummary, { workspace: workspace() }));
  assert.match(html, /11 \/ 100회/); assert.match(html, /잔여 89회/); assert.match(html, /예산 대기 1건/); assert.match(html, /href="#settings"/);
  assert.doesNotMatch(html, /전체 한도 소진/);
});

test('a stale editor preserves the submitted values and blocks blind revision overwrites', () => {
  const draft = { expectedRevision: 1, dailyLimit: 'unfinished', projectDailyLimits: { project: '27' } };
  const html = renderToStaticMarkup(createElement(ModelBudgetEditor, { workspace: workspace(), status: budget, initialDraft: draft, onSaved: async () => {}, onClose: () => {} }));
  assert.match(html, /value="unfinished"/); assert.match(html, /value="27"/); assert.match(html, /다른 설정 변경이 먼저 저장됐습니다/);
  assert.match(html, /초안 교체·최신 설정 가져오기/); assert.match(html, /type="submit" disabled=""/);
  assert.equal(draft.dailyLimit, 'unfinished'); assert.match(html, /프로젝트 입력을 비우면 별도 제한을 해제/);
});

test('refresh reconstructs the saved budget draft and failure message instead of replacing them with polled settings', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const draft = { expectedRevision: 1, dailyLimit: 'unfinished', projectDailyLimits: { project: '27' } };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: { getItem: () => JSON.stringify({ draft, error: 'Previous save was rejected' }) } } });
    const html = renderToStaticMarkup(createElement(ModelBudgetView, { workspace: workspace(), refresh: async () => {} }));
    assert.match(html, /value="unfinished"/); assert.match(html, /value="27"/); assert.match(html, /Previous save was rejected/);
    assert.match(html, /다른 설정 변경이 먼저 저장됐습니다/); assert.match(html, /초안 취소/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('project selectors allow only currently connected scope projects and lock direct project rooms', () => {
  const state = workspace();
  assert.deepEqual(budgetProjects(state, { type: 'agent', id: agent.id }).map(project => project.id), ['project']);
  assert.deepEqual(budgetProjects(state, { type: 'team', id: 'team' }).map(project => project.id), ['project']);
  assert.deepEqual(budgetProjects(state, { type: 'project', id: 'other' }).map(project => project.id), ['other']);
  const personal = renderToStaticMarkup(createElement(BudgetProjectSelect, { workspace: state, scope: { type: 'agent', id: agent.id }, value: 'project', onChange: () => {} }));
  assert.match(personal, /value="project" selected=""/); assert.match(personal, /프로젝트 없는 작업/); assert.doesNotMatch(personal, /Other project/);
  const locked = renderToStaticMarkup(createElement(BudgetProjectSelect, { workspace: state, scope: { type: 'project', id: 'project' }, value: '', onChange: () => {} }));
  assert.match(locked, /Article/); assert.match(locked, /이 프로젝트로 고정됩니다/); assert.doesNotMatch(locked, /<select|개인 작업/);
});

test('new personal conversations expose explicit budget attribution without changing existing conversations', () => {
  const html = renderToStaticMarkup(createElement(ConversationWorkspace, { workspace: workspace({ conversations: [] }), scope: { type: 'agent', id: agent.id },
    refresh: async () => {}, onSelectAgent: () => {} }));
  assert.match(html, /예산 귀속/); assert.match(html, /Article/); assert.match(html, /후속 협업·성장·재시도/);
  const attribution = html.slice(html.indexOf('<span>예산 귀속</span>')).split('</label>')[0];
  assert.doesNotMatch(attribution, /Other project/);
});

test('run budget notices retain project lineage and distinguish operational from previous campaign blocks', () => {
  const html = renderToStaticMarkup(createElement(RunBudgetNotice, { workspace: workspace(), run }));
  assert.match(html, /예산 귀속 · Article/); assert.match(html, /프로젝트 일일 한도 소진/); assert.match(html, /Project daily cap reached/); assert.match(html, /모델 한도 확인·변경/);
  const legacy = renderToStaticMarkup(createElement(RunBudgetNotice, { workspace: workspace({ modelBudget: undefined }), run: { ...run, budgetProjectId: undefined, error: 'Campaign cap reached' } }));
  assert.match(legacy, /이전 작업 · 미기록/); assert.match(legacy, /Campaign cap reached/); assert.doesNotMatch(legacy, /자동 재개합니다/);
  assert.match(budgetResetLabel(budget.resetAt), /9월 8일.*00:00/);
});

test('terminal budget waiters retain attribution without stale wait notices or resume controls in either workroom', () => {
  for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
    for (const pauseRequestedAt of [undefined, date]) {
      const item: Run = { ...run, status, completedAt: date, pauseRequestedAt,
        modelBudgetBlock: { source: 'operational', blockedBy: 'project', projectId: 'project', date: budget.date,
          resetAt: budget.resetAt, reason: 'Historical cap reached' } };
      const state = workspace({ runs: [item] });
      const original = structuredClone(state);
      const notice = renderToStaticMarkup(createElement(RunBudgetNotice, { workspace: state, run: item }));
      assert.equal(notice, '<div class="run-budget-notice"><span>예산 귀속 · Article · 팀 귀속 미기록 · 실행 에이전트 Writer</span></div>');
      const views = [renderToStaticMarkup(createElement(ConversationRun, { workspace: state, run: item, refresh: async () => {} })),
        renderToStaticMarkup(createElement(AgentDetail, { workspace: state, agent, onBack: () => {}, onSelect: () => {}, refresh: async () => {} }))];
      for (const html of views) {
        assert.match(html, /예산 귀속 · Article/);
        assert.doesNotMatch(html, /자동 재개|예산 대기 재개|모델 실행 예산이 부족하여 대기|일시정지 요청됨|>작업 재개<|>작업 취소</);
        assert.doesNotMatch(html, /Project daily cap reached|Historical cap reached/);
      }
      assert.deepEqual(state, original);
    }
  }
});

test('explicit and pending user pauses override historical budget waits without implying automatic midnight resume', () => {
  for (const status of ['paused', 'waiting'] as const) {
    const item: Run = { ...run, status, pauseRequestedAt: date, pausedAt: status === 'paused' ? date : null };
    const state = workspace({ runs: [item] });
    const views = [renderToStaticMarkup(createElement(ConversationRun, { workspace: state, run: item, refresh: async () => {} })),
      renderToStaticMarkup(createElement(AgentDetail, { workspace: state, agent, onBack: () => {}, onSelect: () => {}, refresh: async () => {} }))];
    for (const html of views) {
      assert.match(html, /예산 귀속 · Article/);
      assert.doesNotMatch(html, /자동 재개|예산 대기 재개|모델 실행 예산이 부족하여 대기/);
      assert.match(html, /작업 취소/);
      if (status === 'paused') {
        assert.match(html, /직접 재개하기 전에는 이어가지 않습니다/);
        assert.match(html, /작업 재개/);
      } else {
        assert.match(html, /일시정지 요청됨/);
        assert.doesNotMatch(html, />작업 재개</);
      }
    }
  }
});

test('current budget waiters still expose automatic replenishment and manual retry in both workrooms', () => {
  const state = workspace();
  const views = [renderToStaticMarkup(createElement(ConversationRun, { workspace: state, run, refresh: async () => {} })),
    renderToStaticMarkup(createElement(AgentDetail, { workspace: state, agent, onBack: () => {}, onSelect: () => {}, refresh: async () => {} }))];
  for (const html of views) {
    assert.match(html, /프로젝트 일일 한도 소진/);
    assert.match(html, /자동 재개합니다/);
    assert.match(html, /예산 대기 재개/);
    assert.match(html, /모델 한도 확인·변경/);
  }
});

test('new team tasks and direct messages offer attribution while attributed tasks and replies remain fixed', () => {
  const scope = { type: 'team' as const, id: 'team' };
  const props = { scope, workspace: workspace(), onClose: () => {}, onSaved: async () => {} };
  const taskForm = renderToStaticMarkup(createElement(TaskForm, props));
  assert.match(taskForm, /예산 귀속/); assert.match(taskForm, /Article/);
  const messageForm = renderToStaticMarkup(createElement(MessageForm, { ...props, members: [agent] }));
  assert.match(messageForm, /예산 귀속/); assert.match(messageForm, /Article/);
  const reply: PeerMessage = { id: 'reply', scope, threadId: 'thread', senderAgentId: agent.id, recipientAgentId: null, content: 'Reply here',
    taskId: null, replyToId: null, artifactIds: [], idempotencyKey: 'key', status: 'pending', createdAt: date, deliveredAt: null, completedAt: null, budgetProjectId: 'project', budgetTeamId: 'team' };
  const replyForm = renderToStaticMarkup(createElement(MessageForm, { ...props, members: [agent], reply }));
  assert.match(replyForm, /원래 메시지의 예산 귀속을 이어갑니다/); assert.match(replyForm, /팀 귀속 · Team/); assert.doesNotMatch(replyForm, /팀 예산 귀속|프로젝트 없는 작업 · 전체/);
  const task: TeamTask = { id: 'task', scope, title: 'Task', description: '', status: 'open', assigneeAgentId: null, createdByAgentId: null, version: 1,
    outcome: '', artifactIds: [], createdAt: date, updatedAt: date, completedAt: null, budgetProjectId: 'project', budgetTeamId: 'team' };
  const taskCard = renderToStaticMarkup(createElement(TaskCard, { scope, task, workspace: workspace(), members: [agent], refresh: async () => {}, onSelect: () => {} }));
  assert.match(taskCard, /예산 귀속 · Article · 원래 과제를 이어갑니다/); assert.match(taskCard, /팀 귀속 · Team · 원래 과제를 이어갑니다/);
  assert.doesNotMatch(taskCard, /팀 예산 귀속|프로젝트 없는 작업 · 전체/);
});

test('all-scope drafts preserve live global limits and independent nullable team and agent caps', () => {
  const draft = modelBudgetDraft(allScopesBudget);
  assert.equal(draft.dailyLimit, '500');
  assert.deepEqual(draft.teamDailyLimits, { team: '12' }); assert.deepEqual(draft.agentDailyLimits, { agent: '8' });
  draft.teamDailyLimits!.team = ''; draft.agentDailyLimits!.agent = '0';
  assert.deepEqual(parseModelBudgetDraft(draft), { expectedRevision: 2, dailyLimit: 500, projectDailyLimits: { project: 5 }, teamDailyLimits: { team: null }, agentDailyLimits: { agent: 0 } });
  for (const key of ['teamDailyLimits', 'agentDailyLimits'] as const) {
    const invalid = modelBudgetDraft(allScopesBudget); invalid[key]!.invalid = '1000001'; const before = structuredClone(invalid);
    assert.throws(() => parseModelBudgetDraft(invalid), /0부터 1,000,000까지의 정수/); assert.deepEqual(invalid, before);
  }
  assert.equal(allScopesBudget.teamDailyLimits?.team, 12); assert.equal(allScopesBudget.agentDailyLimits?.agent, 8);
});

test('team and agent tables expose separate caps and already-included legacy unattributed usage without summing scopes', () => {
  const state = workspace({ modelBudget: allScopesBudget });
  const html = renderToStaticMarkup(createElement(ModelBudgetView, { workspace: state, refresh: async () => {} }));
  assert.match(html, /500<small>회/); assert.match(html, /팀별 오늘 사용량/); assert.match(html, /에이전트별 오늘 사용량/);
  assert.match(html, /Team<\/th><td>12회<\/td><td>7회<\/td><td>5회/);
  assert.match(html, /Writer<\/th><td>8회<\/td><td>6회<\/td><td>2회/);
  assert.match(html, /팀 귀속 미기록 3회가 모든 팀의 사용량에 보수적으로 포함/);
  assert.match(html, /에이전트 귀속 미기록 2회가 모든 에이전트의 사용량에 보수적으로 포함/);
  assert.match(html, /확정 귀속 사용량이 아니며/); assert.match(html, /범위별 사용량은 서로 겹치므로 합산하지 않습니다/);
  const legacy = renderToStaticMarkup(createElement(ModelBudgetView, { workspace: workspace(), refresh: async () => {} }));
  assert.match(legacy, /팀별 한도·사용량은 현재 서버에서 확인되지 않았습니다/);
  assert.match(legacy, /에이전트별 한도·사용량은 현재 서버에서 확인되지 않았습니다/);
  assert.doesNotMatch(legacy, /귀속 미기록 0회/);
});

test('all-scope saved drafts and failures survive refresh and keep revision conflict protection', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const draft = { expectedRevision: 1, dailyLimit: '510', projectDailyLimits: { project: '27' }, teamDailyLimits: { team: 'unfinished-team' }, agentDailyLimits: { agent: 'unfinished-agent' } };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: { getItem: () => JSON.stringify({ draft, error: 'Team cap save was rejected' }) } } });
    const html = renderToStaticMarkup(createElement(ModelBudgetView, { workspace: workspace({ modelBudget: allScopesBudget }), refresh: async () => {} }));
    for (const value of ['510', '27', 'unfinished-team', 'unfinished-agent']) assert.match(html, new RegExp(`value="${value}"`));
    assert.match(html, /Team cap save was rejected/); assert.match(html, /다른 설정 변경이 먼저 저장됐습니다/);
    assert.match(html, /type="submit" disabled=""/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('older project-only drafts acquire current additional cap values without clearing user input', () => {
  const draft = { expectedRevision: 1, dailyLimit: 'unfinished', projectDailyLimits: { project: '27' } };
  const html = renderToStaticMarkup(createElement(ModelBudgetEditor, { workspace: workspace(), status: allScopesBudget, initialDraft: draft, onSaved: async () => {}, onClose: () => {} }));
  assert.match(html, /value="unfinished"/); assert.match(html, /value="27"/); assert.match(html, /value="12"/); assert.match(html, /value="8"/);
  assert.match(html, /팀별 선택 상한/); assert.match(html, /에이전트별 선택 상한/); assert.match(html, /type="submit" disabled=""/);
  assert.deepEqual(draft, { expectedRevision: 1, dailyLimit: 'unfinished', projectDailyLimits: { project: '27' } });
});

test('team selection pins one origin team, requires multi-team choice and intersects selected project memberships', () => {
  const state = workspace(); const personal = { type: 'agent' as const, id: agent.id };
  assert.equal(budgetTeamSelection(state, personal, null, ''), 'team');
  assert.equal(budgetTeamSelection(state, { type: 'team', id: 'team' }, null, 'none'), 'team');
  const multi = workspace({ teams: [...state.teams, { ...state.teams[0], id: 'second', name: 'Second' }],
    projects: [{ ...state.projects![0], teamIds: ['team', 'second'] }, state.projects![1]] });
  assert.deepEqual(budgetTeams(multi, personal, 'project').map(team => team.id), ['team', 'second']);
  assert.equal(budgetTeamSelection(multi, personal, 'project', ''), undefined);
  assert.equal(budgetTeamSelection(multi, personal, 'project', 'second'), 'second');
  assert.equal(budgetTeamSelection(multi, personal, 'project', 'none'), undefined);
  assert.equal(budgetTeamSelection(multi, personal, null, 'none'), null);
  assert.equal(budgetTeamSelection(multi, personal, null, 'outside'), undefined);
  assert.equal(budgetTeamSelection(state, personal, 'other', ''), undefined);
  assert.equal(budgetTeamSelection(state, { type: 'agent', id: 'outsider' }, null, ''), null);
  const locked = renderToStaticMarkup(createElement(BudgetTeamSelect, { workspace: state, scope: personal, projectId: 'project', value: '', onChange: () => {} }));
  assert.match(locked, /팀 귀속 · Team · 원래 과제의 한 팀으로 고정/); assert.doesNotMatch(locked, /<select/);
  const choose = renderToStaticMarkup(createElement(BudgetTeamSelect, { workspace: multi, scope: personal, projectId: 'project', value: 'second', onChange: () => {} }));
  assert.match(choose, /value="second" selected=""/); assert.match(choose, /중복 차감하지 않으며/); assert.doesNotMatch(choose, /value="none"/);
});

test('single-team personal rooms allow explicit no-team work while team rooms and project work remain fixed', () => {
  const state = workspace(); const scope = { type: 'agent' as const, id: agent.id };
  const render = (projectId: string | null, value: string) => renderToStaticMarkup(createElement(BudgetTeamSelect, {
    workspace: state, scope, projectId, value, onChange: () => {},
  }));
  const initial = render(null, '');
  assert.match(initial, /value="team" selected=""/); assert.match(initial, /value="none">팀 없는 개인 작업/);
  const personal = render(null, 'none');
  assert.match(personal, /value="none" selected=""/); assert.equal(budgetTeamSelection(state, scope, null, 'none'), null);
  const project = render('project', '');
  assert.match(project, /원래 과제의 한 팀으로 고정/); assert.doesNotMatch(project, /<select|value="none"/);
  const team = renderToStaticMarkup(createElement(BudgetTeamSelect, { workspace: state, scope: { type: 'team', id: 'team' }, projectId: null, value: '', onChange: () => {} }));
  assert.match(team, /원래 과제의 한 팀으로 고정/); assert.doesNotMatch(team, /<select|value="none"/);
  const room = renderToStaticMarkup(createElement(ConversationWorkspace, { workspace: state, scope, refresh: async () => {}, onSelectAgent: () => {} }));
  assert.match(room, /value="none">팀 없는 개인 작업/);
});

test('project task and message forms require an origin team while historical replies and rooted tasks stay locked', () => {
  const state = workspace();
  const multi = workspace({ teams: [...state.teams, { ...state.teams[0], id: 'second', name: 'Second' }], projects: [{ ...state.projects![0], teamIds: ['team', 'second'] }] });
  const scope = { type: 'project' as const, id: 'project' };
  const props = { scope, workspace: multi, onClose: () => {}, onSaved: async () => {} };
  for (const html of [renderToStaticMarkup(createElement(TaskForm, props)), renderToStaticMarkup(createElement(MessageForm, { ...props, members: [agent] })),
    renderToStaticMarkup(createElement(ConversationWorkspace, { workspace: multi, scope, refresh: async () => {}, onSelectAgent: () => {} }))]) {
    assert.match(html, /팀 예산 귀속/); assert.match(html, /현재 연결된 팀 선택이 필요합니다/); assert.match(html, /type="submit"[^>]*disabled=""/);
  }
  const task: TeamTask = { id: 'task', scope, title: 'Historical task', description: '', status: 'open', assigneeAgentId: null, createdByAgentId: null,
    version: 1, outcome: '', artifactIds: [], createdAt: date, updatedAt: date, completedAt: null, budgetRootRunId: 'original' };
  const rooted = renderToStaticMarkup(createElement(TaskCard, { scope, task, workspace: multi, members: [agent], refresh: async () => {}, onSelect: () => {} }));
  assert.match(rooted, /팀 귀속 미기록 · 원래 과제를 이어갑니다/); assert.doesNotMatch(rooted, /팀 예산 귀속|팀 없는 개인 작업/);
});

test('team and agent blockers identify the exhausted scope without reviving terminal or user-paused runs', () => {
  for (const blockedBy of ['team', 'agent'] as const) {
    const label = blockedBy === 'team' ? '팀' : '에이전트';
    const status: OperationalBudgetStatus = { ...allScopesBudget, waiting: [{ ...budget.waiting[0], blockedBy, teamId: 'team', agentId: agent.id }] };
    const current = { ...run, budgetTeamId: 'team' };
    const notice = renderToStaticMarkup(createElement(RunBudgetNotice, { workspace: workspace({ modelBudget: status }), run: current }));
    assert.match(notice, new RegExp(`${label} 일일 한도 소진`)); assert.match(notice, /실행 에이전트 Writer/); assert.match(notice, /자동 재개합니다/);
    for (const state of ['paused', 'succeeded', 'failed', 'cancelled'] as const) {
      const item: Run = { ...current, status: state, pauseRequestedAt: date };
      const frozen = renderToStaticMarkup(createElement(RunBudgetNotice, { workspace: workspace({ modelBudget: status }), run: item }));
      assert.match(frozen, /예산 귀속 · Article · Team/); assert.doesNotMatch(frozen, /한도 소진|자동 재개|확인·변경/);
      const summary = renderToStaticMarkup(createElement(ModelBudgetView, { workspace: workspace({ modelBudget: status, runs: [item] }), refresh: async () => {} }));
      assert.doesNotMatch(summary, /새 한도에서 자동 재개/);
    }
  }
});
