import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Run, Workspace } from '../shared/types.ts';
import type { Conversation, ConversationDelivery, ConversationMessage } from '../shared/conversations.ts';
import { ConversationMessageCard, ConversationRun, ConversationView, ConversationWorkspace, conversationHref,
  conversationLocation, conversationMembers, conversationRuns, conversationRunTitle, conversationSubmission, deliveryLabel, parseConversationDraft } from '../src/ConversationView.tsx';
import { AgentDetail, activeRun } from '../src/AgentDetail.tsx';
import { CollaborationPanel } from '../src/CollaborationView.tsx';
import { appLocation, RuntimeNotice } from '../src/App.tsx';

const date = '2026-09-06T12:00:00.000Z';
const agent: Agent = { id: 'agent', name: 'Writer', description: '', persona: 'Private persona', model: 'fixture', status: 'idle',
  color: '#72836b', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const peer = { ...agent, id: 'peer', name: 'Reviewer' };
const outsider = { ...agent, id: 'outside', name: 'Unrelated agent' };
const room: Conversation = { id: 'conversation', scope: { type: 'team', id: 'team' }, title: 'Actual team work',
  participantAgentIds: [agent.id, peer.id], createdAt: date, updatedAt: date };
const delivery: ConversationDelivery = { agentId: agent.id, runId: 'run', steeringIndex: 0, status: 'pending' };
const message: ConversationMessage = { id: 'message', conversationId: room.id, senderAgentId: peer.id, content: 'Peer needs the draft',
  mode: 'task', replyToId: null, sourceRunId: 'run', idempotencyKey: 'key', deliveries: [delivery], createdAt: date };
const run: Run = { id: 'run', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Current task', status: 'running',
  result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], kind: 'task', createdAt: date, startedAt: date, completedAt: null };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent, peer, outsider], skills: [], runs: [run], memories: [], snapshots: [],
  activities: [], teams: [{ id: 'team', name: 'Writing team', description: '', memberIds: [agent.id, peer.id], workflow: '', version: 1, createdAt: date, updatedAt: date }],
  approvals: [], connections: [], runtime: { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: 'no model' },
  conversations: [room], conversationMessages: [message], ...extra });
const common = { refresh: async () => {}, onSelectAgent: () => {} };

test('simulation runtime is visibly distinguished by capability flag, never by model name', () => {
  const runtime = workspace().runtime;
  const simulated = renderToStaticMarkup(createElement(RuntimeNotice, { runtime: { ...runtime, simulation: true, model: 'any-model' } }));
  assert.match(simulated, /role="status"/); assert.match(simulated, /화면 검증용 · 실제 모델을 호출하지 않습니다/);
  assert.equal(renderToStaticMarkup(createElement(RuntimeNotice, { runtime })), '');
  assert.equal(renderToStaticMarkup(createElement(RuntimeNotice, { runtime: { ...runtime, simulation: false } })), '');
});

test('conversation locations are stable addressable IDs and ignore message anchors and invalid path syntax', () => {
  assert.equal(conversationHref('46d63c96-e054-4323-a50d-1f1f0075ca58'), '#conversation/46d63c96-e054-4323-a50d-1f1f0075ca58');
  assert.deepEqual(conversationLocation('#conversation/46d63c96-e054-4323-a50d-1f1f0075ca58'), { id: '46d63c96-e054-4323-a50d-1f1f0075ca58' });
  assert.deepEqual(conversationLocation('#conversations'), { id: null });
  for (const invalid of ['#conversation/', '#conversation/../admin', '#message-id', '#agents', '#conversation/<script>']) assert.equal(conversationLocation(invalid), null);
});

test('initial load and hash navigation share menu routing while local message anchors never change the view', () => {
  for (const view of ['agents', 'teams', 'projects', 'activity', 'settings'] as const) {
    assert.deepEqual(appLocation(`#${view}`), { view, conversationId: null });
  }
  assert.deepEqual(appLocation('#conversations'), { view: 'conversations', conversationId: null });
  assert.deepEqual(appLocation('#conversation/46d63c96-e054-4323-a50d-1f1f0075ca58'), { view: 'conversations', conversationId: '46d63c96-e054-4323-a50d-1f1f0075ca58' });
  for (const hash of ['#message-123', '#conversation-run-123', '#main-content', '#unknown', '']) assert.equal(appLocation(hash), null);
});

test('current scope members are deduplicated across project teams and exclude unrelated agents', () => {
  const state = workspace();
  state.projects = [{ id: 'project', name: 'Project', description: '', teamIds: ['team', 'team2'], version: 1, createdAt: date, updatedAt: date }];
  state.teams.push({ ...state.teams[0], id: 'team2', memberIds: [peer.id] });
  assert.deepEqual(conversationMembers(state, { type: 'agent', id: agent.id }).map(item => item.id), [agent.id]);
  assert.deepEqual(conversationMembers(state, { type: 'project', id: 'project' }).map(item => item.id), [agent.id, peer.id]);
  assert.deepEqual(conversationMembers(state, { type: 'team', id: 'missing' }), []);
});

test('draft parsing and submission preserve source text while matching strict optional-field contract', () => {
  const draft = { content: '  Keep my unsent draft  ', mode: 'discuss' as const, recipientAgentId: peer.id, replyToId: message.id };
  const original = structuredClone(draft);
  assert.deepEqual(conversationSubmission(draft), { content: 'Keep my unsent draft', mode: 'discuss', recipientAgentId: peer.id, replyToId: message.id });
  assert.deepEqual(draft, original);
  assert.deepEqual(conversationSubmission({ ...draft, recipientAgentId: '', replyToId: '' }), { content: 'Keep my unsent draft', mode: 'discuss' });
  assert.deepEqual(parseConversationDraft(null), { content: '', mode: 'auto', recipientAgentId: '', replyToId: '' });
  assert.equal(parseConversationDraft({ content: 'x'.repeat(25_000), mode: 'unknown' }).content.length, 20_000);
  assert.equal(parseConversationDraft({ content: 'unchanged', mode: 'unknown' }).mode, 'auto');
});

test('messages identify the actual sender and reply chain without injecting model text as markup', () => {
  const html = renderToStaticMarkup(createElement(ConversationMessageCard, { workspace: workspace(),
    message: { ...message, content: '<script>private text</script>', replyToId: 'user', sourcePeerMessageId: 'legacy' },
    messages: [{ ...message, id: 'user', senderAgentId: null, content: 'Please revise' }], onReply: () => {} }));
  assert.match(html, /Reviewer/); assert.match(html, /실제 에이전트/); assert.match(html, /사용자: Please revise/);
  assert.match(html, /기존 동료 대화 연결/); assert.match(html, /연결 실행/); assert.match(html, /전달 대기/);
  assert.match(html, /&lt;script&gt;private text&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /id="message-message"/);
});

test('delivery labels keep receipt, application and task response separate', () => {
  assert.equal(deliveryLabel(delivery), '전달 대기');
  assert.equal(deliveryLabel({ ...delivery, status: 'delivered' }), '입력 전달됨');
  assert.equal(deliveryLabel({ ...delivery, status: 'applied' }), '반영됨');
  assert.equal(deliveryLabel({ ...delivery, status: 'answered' }), '응답 완료');
  assert.equal(deliveryLabel({ ...delivery, status: 'cancelled' }), '전달 취소');
});

test('linked runs are deduplicated and foreign runs never appear in a conversation', () => {
  const state = workspace({ runs: [run, { ...run, id: 'foreign', prompt: 'Private other task' }] });
  assert.deepEqual(conversationRuns(state, [message, { ...message, id: 'reply' }]).map(item => item.id), ['run']);
  const html = renderToStaticMarkup(createElement(ConversationView, { conversation: room, workspace: state, ...common }));
  assert.match(html, /Current task/); assert.doesNotMatch(html, /Private other task|Private persona|Unrelated agent/);
  assert.match(html, /받는 사람/); assert.match(html, /공동 논의/); assert.match(html, /상담만/); assert.match(html, /작업 지시/);
  assert.match(html, /다음 처리 경계/); assert.match(html, /#conversation\/conversation/);
});

test('conversation run titles use the linked user message and keep full delivery input in collapsed details', () => {
  const linked = { ...run, conversationId: room.id, conversationMessageId: message.id, prompt: 'INTERNAL DELIVERY WRAPPER uuid metadata' };
  const state = workspace();
  assert.equal(conversationRunTitle(linked, state), message.content);
  assert.equal(conversationRunTitle({ ...linked, conversationMessageId: 'missing' }, state), linked.prompt);
  assert.equal(conversationRunTitle({ ...linked, conversationId: 'foreign' }, state), linked.prompt);
  const html = renderToStaticMarkup(createElement(ConversationRun, { run: linked, workspace: state, refresh: async () => {} }));
  const header = html.slice(0, html.indexOf('</summary>'));
  assert.match(header, /Peer needs the draft/); assert.doesNotMatch(header, /INTERNAL DELIVERY WRAPPER/);
  assert.match(html, /<details class="conversation-events"><summary>실행 입력 상세<\/summary>/);
  assert.match(html, /INTERNAL DELIVERY WRAPPER uuid metadata/);
});

test('scope-filtered room lists and missing deep links do not silently show another conversation', () => {
  const state = workspace({ conversations: [room, { ...room, id: 'private', title: 'Private other conversation', scope: { type: 'agent', id: outsider.id } }] });
  const html = renderToStaticMarkup(createElement(ConversationWorkspace, { workspace: state, scope: room.scope, ...common }));
  assert.match(html, /Actual team work/); assert.doesNotMatch(html, /Private other conversation/);
  const missing = renderToStaticMarkup(createElement(ConversationWorkspace, { workspace: state, conversationId: 'missing', ...common }));
  assert.match(missing, /대화를 찾지 못했습니다/); assert.doesNotMatch(missing, /Peer needs the draft/);
});

test('pause-requested, paused and cancelled run controls distinguish persistence from automatic resume', () => {
  const render = (item: Run) => renderToStaticMarkup(createElement(ConversationRun, { run: item, workspace: workspace(), refresh: async () => {} }));
  const pending = render({ ...run, pauseRequestedAt: date });
  assert.match(pending, /일시정지 요청됨/); assert.match(pending, /안전한 처리 경계/); assert.match(pending, /일시정지 대기/);
  const paused = render({ ...run, status: 'paused', pausedAt: date });
  assert.match(paused, /직접 재개하기 전에는 이어가지 않습니다/); assert.match(paused, /작업 재개/); assert.match(paused, /작업 취소/);
  assert.doesNotMatch(paused, /예산 대기 재개/); assert.equal(activeRun({ ...run, status: 'paused' }), true);
  const cancelled = render({ ...run, status: 'cancelled', error: 'Stopped explicitly' });
  assert.match(cancelled, /Stopped explicitly/); assert.doesNotMatch(cancelled, /작업 재개|작업 취소|일시정지/);
});

test('completed results expose artifact content and failure traces in the same conversation', () => {
  const html = renderToStaticMarkup(createElement(ConversationRun, { workspace: workspace(), refresh: async () => {}, run: {
    ...run, status: 'succeeded', result: 'Saved outcome', artifacts: [{ id: 'file', name: 'result.txt', content: '<b>literal result</b>', mediaType: 'text/plain' }] } }));
  assert.match(html, /Saved outcome/); assert.match(html, /result.txt/); assert.match(html, /다운로드/);
  assert.match(html, /&lt;b&gt;literal result&lt;\/b&gt;/); assert.doesNotMatch(html, /<b>literal/);
  assert.doesNotMatch(html, /작업 취소|작업 재개/);
});

test('individual and collaborative entry screens contain the same persistent workroom', () => {
  const personal = renderToStaticMarkup(createElement(AgentDetail, { agent, workspace: workspace(), onBack: () => {}, onSelect: () => {}, refresh: async () => {} }));
  assert.match(personal, /대화 만들기/); assert.match(personal, /모든 실행 기록/); assert.doesNotMatch(personal, /NEXT ASSIGNMENT/);
  const team = renderToStaticMarkup(createElement(CollaborationPanel, { scope: room.scope as { type: 'team'; id: string }, workspace: workspace(), onSelect: () => {}, refresh: async () => {} }));
  assert.match(team, /대화형 작업실/); assert.match(team, /Actual team work/); assert.match(team, /공동 작업판/);
});
