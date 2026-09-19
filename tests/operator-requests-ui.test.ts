import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Workspace } from '../shared/types.ts';
import type { OperatorRequest } from '../shared/operator-requests.ts';
import type { PeerMessage } from '../shared/collaboration.ts';
import { appLocation } from '../src/App.tsx';
import { OperatorRequestActionForm, OperatorRequestContentForm, OperatorRequestDetail, OperatorRequestsView, operatorRequestHref, operatorRequestLocation, operatorRequestOpen } from '../src/OperatorRequestsView.tsx';
import { MessageCard } from '../src/CollaborationView.tsx';
import { EnvironmentView } from '../src/EnvironmentView.tsx';

const date = '2026-09-11T12:00:00.000Z';
const agent: Agent = { id: 'sales', name: '영업 담당', description: '', persona: '', color: '#72836b', model: 'fixture', status: 'idle', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const item: OperatorRequest = { id: 'request', requesterAgentId: agent.id, sourceRunId: null, idempotencyKey: 'one', creationHash: 'a'.repeat(64), sourceKey: null,
  scope: { type: 'team', id: 'sales-team' }, links: { taskId: 'task', objectiveId: 'objective' }, category: 'connector', title: '업무 공간 연결', reason: '문의 기준을 공유합니다.', requestedAction: '업무 페이지 연결', requestedScope: '한 업무 페이지 읽기', verificationCriteria: '요청자가 해당 페이지를 읽습니다.', version: 1, contentVersion: 1,
  decision: { status: 'pending', contentVersion: 1, reason: '', actor: null, at: date }, processing: { status: 'idle', detail: '', actor: null, at: date }, verification: null, resumeReceipts: [], resumeBlockReason: null, history: [], createdAt: date, updatedAt: date };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], teams: [{ id: 'sales-team', name: '영업팀', description: '', workflow: '', memberIds: [agent.id], version: 1, createdAt: date, updatedAt: date }], runs: [], memories: [], skills: [], snapshots: [], approvals: [], activities: [], connections: [], operatorRequests: [item], runtime: { mode: 'docker', simulation: true, available: false, authenticated: false, image: 'fixture', model: 'fixture', message: 'No model calls', version: null }, ...extra });
const refresh = async () => {};
const detail = (value = item) => renderToStaticMarkup(createElement(OperatorRequestDetail, { item: value, workspace: workspace(), refresh, onSelect: () => {} }));
const form = (operation: 'decide' | 'progress' | 'verify' | 'withdraw' | 'consult', value = item, state = workspace()) => renderToStaticMarkup(createElement(OperatorRequestActionForm, { operation, item: value, workspace: state, onClose: () => {}, onSaved: refresh, refresh }));

test('request routes deep link safely and legacy workspaces have a truthful empty inbox', () => {
  assert.deepEqual(appLocation('#requests'), { view: 'requests', conversationId: null });
  assert.deepEqual(appLocation(operatorRequestHref('a b')), { view: 'requests', conversationId: null });
  assert.deepEqual(operatorRequestLocation('#requests/a%20b'), { id: 'a b' });
  assert.equal(operatorRequestLocation('#requests/%invalid'), null);
  assert.equal(operatorRequestLocation('#requests/a/extra'), null);
  const html = renderToStaticMarkup(createElement(OperatorRequestsView, { workspace: workspace({ operatorRequests: undefined }), refresh, onSelect: () => {} }));
  assert.match(html, /대표 요청이 없습니다/); assert.match(html, /미처리 0건/); assert.doesNotMatch(html, /연결 완료/);
});

test('approval alone stays in the unresolved badge until this content version passes verification', () => {
  const approved = { ...item, decision: { ...item.decision, status: 'approved' as const } };
  assert.equal(operatorRequestOpen(item), true); assert.equal(operatorRequestOpen(approved), true);
  assert.equal(operatorRequestOpen({ ...approved, processing: { ...item.processing, status: 'verified' } }), true);
  const verified: OperatorRequest = { ...approved, processing: { ...item.processing, status: 'verified' }, verification: { id: 'proof', contentVersion: 1, method: 'manual', passed: true, evidence: 'Checked', detail: 'Checked', actor: { kind: 'operator' }, verifiedAt: date } };
  assert.equal(operatorRequestOpen(verified), false);
  assert.equal(operatorRequestOpen({ ...verified, contentVersion: 2 }), true);
  assert.equal(operatorRequestOpen({ ...verified, verification: { ...verified.verification!, passed: false } }), true);
  assert.equal(operatorRequestOpen({ ...item, decision: { ...item.decision, status: 'rejected' } }), false);
  assert.equal(operatorRequestOpen({ ...item, decision: { ...item.decision, status: 'withdrawn' } }), false);
});

test('detail separates requester, context, concrete action, decision and actual processing', () => {
  const html = detail();
  for (const label of ['영업 담당', '영업팀', '관련 목적', '관련 과제', '필요한 대표 조치', '대상·권한 범위', '해결 확인 기준', '대표 결정', '실제 처리', '요청자에게 질문']) assert.match(html, new RegExp(label));
  assert.match(html, /승인은 연결·권한 변경이나 처리 완료를 뜻하지 않습니다/);
  assert.doesNotMatch(html, />처리 결과 검증</);
  const approved = detail({ ...item, decision: { ...item.decision, status: 'approved' } });
  assert.match(approved, />처리 상태 기록</); assert.match(approved, /disabled="">처리 결과 검증</);
  assert.match(approved, /상태를 검증 대기로 전환/);
  const ready = detail({ ...item, decision: { ...item.decision, status: 'approved' }, processing: { ...item.processing, status: 'verification_pending' } });
  assert.doesNotMatch(ready, /disabled="">처리 결과 검증</);
  const withdrawn = detail({ ...item, decision: { ...item.decision, status: 'withdrawn' } });
  assert.doesNotMatch(withdrawn, />승인·보완·거절<|>내용 수정<|>요청 철회</);
});

test('decision defaults to requesting information and requires an explicit reason', () => {
  const html = form('decide');
  assert.match(html, /value="needs_information" selected=""/); assert.match(html, /대표 · 사용자 명의/);
  assert.match(html, /<textarea required=""/); assert.match(html, /type="submit"[^>]*disabled=""/);
  assert.match(form('withdraw'), /관련 과제 취소나 이미 부여된 접근 권한 회수는 별도/);
});

test('verification targets only existing connected resources and never provides a passed selector', () => {
  const connections: Workspace['connections'] = [{ id: 'connected', repository: 'studio/site', access: 'read', createdAt: date, github: { status: 'connected', repositoryId: 1, defaultBranch: 'main', generation: 'g', verifiedAt: date } }, { id: 'disconnected', repository: 'old/site', access: 'write', createdAt: date, github: { status: 'disconnected', repositoryId: 2, defaultBranch: 'main', generation: 'g', verifiedAt: date } }];
  const html = form('verify', item, workspace({ connections }));
  assert.match(html, /studio\/site/); assert.doesNotMatch(html, /old\/site/); assert.match(html, /검증 근거/);
  assert.doesNotMatch(html, /name="passed"|검증 통과로 지정/); assert.match(html, /type="submit"[^>]*disabled=""/);
  const empty = form('verify'); assert.match(empty, /선택할 대상이 없습니다/);
});

test('manual confirmation is explicitly human evidence and initially cannot be submitted', () => {
  const html = form('verify', { ...item, category: 'budget' });
  assert.match(html, /운영자가 직접 확인한 사실/); assert.match(html, /자동 연결 검사 결과와 구분/);
  assert.match(html, /직접 확인했습니다/); assert.doesNotMatch(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '', /checked/);
  assert.match(html, /type="submit"[^>]*disabled=""[^>]*>운영자 확인 기록/);
});

test('revision preserves the current draft and tells the operator approval and verification expire', () => {
  const html = renderToStaticMarkup(createElement(OperatorRequestContentForm, { item, workspace: workspace(), onClose: () => {}, onSaved: async () => {}, refresh }));
  assert.match(html, /value="업무 공간 연결"/); assert.match(html, /기존 승인·검증은 무효화/);
  assert.match(html, /한 업무 페이지 읽기/); assert.match(html, /새 본문 버전 저장/);
});

test('history identifies human confirmation and escapes request text', () => {
  const html = detail({ ...item, title: '<script>bad()</script>', history: [{ id: 'history', kind: 'decision', version: 2, contentVersion: 1, actor: { kind: 'operator' }, at: date, decision: { ...item.decision, status: 'approved', reason: 'Only this scope', actor: { kind: 'operator' } } }], verification: { id: 'proof', contentVersion: 1, method: 'manual', passed: true, evidence: 'Manual evidence', detail: 'Directly observed', actor: { kind: 'operator' }, verifiedAt: date } });
  assert.match(html, /운영자 확인 · 통과/); assert.match(html, /대표 · 사용자/); assert.match(html, /Only this scope/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});

test('only messages from agents to the operator offer promotion and existing request links replace creation', () => {
  const message: PeerMessage = { id: 'message', idempotencyKey: 'message-once', scope: { type: 'team', id: 'sales-team' }, senderAgentId: agent.id, recipientAgentId: null, content: 'Connect our workspace', threadId: 'thread', replyToId: null, taskId: null, artifactIds: [], status: 'pending', createdAt: date, deliveredAt: null, completedAt: null };
  const render = (value = message, state = workspace()) => renderToStaticMarkup(createElement(MessageCard, { message: value, workspace: state, scope: value.scope, refresh, onSelect: () => {}, onReply: () => {}, onThread: () => {} }));
  assert.match(render(), /대표 요청으로 등록/);
  assert.doesNotMatch(render({ ...message, recipientAgentId: 'peer' }), /대표 요청으로 등록/);
  assert.doesNotMatch(render({ ...message, senderAgentId: null }), /대표 요청으로 등록/);
  const linked = render(message, workspace({ operatorRequests: [{ ...item, links: { messageId: message.id } }] }));
  assert.match(linked, /href="#requests\/request"/); assert.doesNotMatch(linked, /대표 요청으로 등록/);
});

test('blocked access environment links to its existing request without promising granted access', () => {
  const html = renderToStaticMarkup(createElement(EnvironmentView, { agent, workspace: workspace({ operatorRequests: [{ ...item, links: { environmentRevisionId: 'environment' } }], environmentRevisions: [{ id: 'environment', agentId: agent.id, sourceRunId: null, buildRunId: null, baseRevisionId: null, reason: 'External access', spec: { packages: [], servers: [] }, requestedAccess: ['Read our workspace'], status: 'blocked', error: null, createdAt: date, completedAt: null }] }), busy: false, refresh }));
  assert.match(html, /href="#requests\/request"/); assert.match(html, /승인만으로 계정 연결이나 권한이 추가되지는 않습니다/);
});

test('request consultation explains user authorship and preserves the original work wait conditions', () => {
  const html = form('consult'); assert.match(html, /대표 · 사용자 명의/); assert.match(html, /읽기 전용 상담/);
  assert.match(html, /기존 작업의 대기 조건을 유지/); assert.match(html, /질문 내용/);
});
