import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserCapture } from '../shared/browser.ts';
import type { Conversation, ConversationMessage } from '../shared/conversations.ts';
import type { Agent, Run, Workspace } from '../shared/types.ts';
import { BrowserEvidence, browserCaptureDownloadHref, browserCaptureImageHref, conversationBrowserCaptures } from '../src/BrowserEvidence.tsx';
import { ConversationView } from '../src/ConversationView.tsx';

const date = '2026-09-08T02:00:00.000Z';
const agent: Agent = { id: 'agent', name: '실제 검토자', description: '', persona: 'Private persona', color: '#72836b', model: 'fixture',
  status: 'idle', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const room: Conversation = { id: 'conversation', scope: { type: 'agent', id: agent.id }, title: '실제 작업 대화',
  participantAgentIds: [agent.id], createdAt: date, updatedAt: date };
const run: Run = { id: 'actual-run', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Render the actual task',
  status: 'succeeded', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [],
  createdAt: date, startedAt: date, completedAt: date, conversationId: room.id };
const capture: BrowserCapture = { id: 'capture', runId: run.id, agentId: agent.id, conversationId: room.id, createdAt: date,
  bytes: 10241, sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1280, height: 720,
  url: 'http://127.0.0.1:4173/preview', sourceHash: 'b'.repeat(64), scope: room.scope };
const message: ConversationMessage = { id: 'message', conversationId: room.id, senderAgentId: null, content: 'Inspect the real page',
  mode: 'task', replyToId: null, sourceRunId: null, idempotencyKey: 'key', deliveries: [], createdAt: date };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], teams: [], runs: [run], skills: [], memories: [],
  snapshots: [], activities: [], approvals: [], connections: [], conversations: [room], conversationMessages: [], browserCaptures: [capture],
  runtime: { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: 'No model calls' }, ...extra });

test('capture filtering uses actual run ownership and rejects conflicting or missing conversation links', () => {
  const foreignRun = { ...run, id: 'foreign-run', conversationId: 'foreign-room' };
  const state = workspace({ runs: [run, foreignRun], browserCaptures: [capture,
    { ...capture, id: 'foreign-conversation', conversationId: 'foreign-room' },
    { ...capture, id: 'foreign-run', runId: foreignRun.id },
    { ...capture, id: 'unknown-run', runId: 'missing' },
    { ...capture, id: 'foreign-agent', agentId: 'other-agent' },
    { ...capture, id: 'no-capture-conversation', conversationId: null },
  ] });
  assert.deepEqual(conversationBrowserCaptures(state, room.id).map(item => item.id), ['capture', 'no-capture-conversation']);
  assert.deepEqual(conversationBrowserCaptures(state, 'absent'), []);
});

test('legacy runs are included only through this conversation source or delivery and never override a conflicting run conversation', () => {
  const sourceRun = { ...run, id: 'source-run', conversationId: undefined };
  const deliveryRun = { ...run, id: 'delivery-run', conversationId: undefined };
  const conflictRun = { ...run, id: 'conflict-run', conversationId: 'foreign-room' };
  const orphanRun = { ...run, id: 'orphan-run', conversationId: undefined };
  const runs = [sourceRun, deliveryRun, conflictRun, orphanRun];
  const state = workspace({ runs,
    conversationMessages: [{ ...message, sourceRunId: sourceRun.id,
      deliveries: [{ agentId: agent.id, runId: deliveryRun.id, steeringIndex: 0, status: 'answered' },
        { agentId: agent.id, runId: conflictRun.id, steeringIndex: 0, status: 'answered' }] }],
    browserCaptures: runs.map(item => ({ ...capture, id: item.id, runId: item.id, conversationId: null })),
  });
  assert.deepEqual(conversationBrowserCaptures(state, room.id).map(item => item.runId), ['delivery-run', 'source-run']);
});

test('captures use immutable newest-first ordering and support workspaces without browser evidence', () => {
  const captures = [capture, { ...capture, id: 'newer', createdAt: '2026-09-08T03:00:00.000Z' }];
  const state = workspace({ browserCaptures: captures });
  assert.deepEqual(conversationBrowserCaptures(state, room.id).map(item => item.id), ['newer', 'capture']);
  assert.deepEqual(captures.map(item => item.id), ['capture', 'newer']);
  assert.deepEqual(conversationBrowserCaptures(workspace({ browserCaptures: undefined }), room.id), []);
});

test('gallery renders stored image endpoints, ownership, viewport, source provenance and downloads without treating capture as success', () => {
  const html = renderToStaticMarkup(createElement(BrowserEvidence, { workspace: workspace(), conversationId: room.id }));
  assert.match(html, /<details class="browser-evidence" aria-label="대화의 브라우저 캡처">/);
  assert.match(html, /src="\/api\/browser\/captures\/capture\/image"/);
  assert.match(html, /href="\/api\/browser\/captures\/capture\/download" download=""/);
  assert.match(html, /width="1280" height="720" loading="lazy" decoding="async"/);
  assert.match(html, /alt="실제 검토자의 브라우저 캡처/);
  assert.match(html, /1280 × 720 · 11 KiB · PNG/);
  assert.match(html, /dateTime="2026-09-08T02:00:00.000Z"/);
  assert.match(html, /title="actual-run"/); assert.match(html, /소스 bbbbbbbbbbbb/); assert.match(html, /이미지 aaaaaaaaaaaa/);
  assert.match(html, /원본 보기/); assert.match(html, /캡처 자체는 검사 통과나 결과물 완성을 뜻하지 않습니다/);
  assert.doesNotMatch(html, /검사 성공|검사 통과<|원격 제어|<iframe|src="http/);
});

test('untrusted capture metadata is escaped and cannot supply image or download origins', () => {
  const unsafe = { ...capture, id: '../other?x=1', url: '<script>alert(1)</script>', sourceHash: '<img src=x>', sha256: '<script>' };
  const html = renderToStaticMarkup(createElement(BrowserEvidence, { workspace: workspace({ browserCaptures: [unsafe] }), conversationId: room.id }));
  assert.equal(browserCaptureImageHref(unsafe.id), '/api/browser/captures/..%2Fother%3Fx%3D1/image');
  assert.equal(browserCaptureDownloadHref(unsafe.id), '/api/browser/captures/..%2Fother%3Fx%3D1/download');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>|<img src=x>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test('empty evidence is explicitly absent and recent thumbnails are bounded while stored count remains visible', () => {
  const empty = renderToStaticMarkup(createElement(BrowserEvidence, { workspace: workspace({ browserCaptures: [] }), conversationId: room.id }));
  assert.match(empty, /0개/); assert.match(empty, /이 대화의 실행에 연결된 캡처가 없습니다/); assert.doesNotMatch(empty, /<img/);
  const captures = Array.from({ length: 15 }, (_, index) => ({ ...capture, id: `capture-${index}` }));
  const html = renderToStaticMarkup(createElement(BrowserEvidence, { workspace: workspace({ browserCaptures: captures }), conversationId: room.id }));
  assert.equal((html.match(/<img /g) ?? []).length, 12); assert.match(html, /15개/); assert.match(html, /최근 12개를 표시합니다/);
});

test('the conversation embeds an initially collapsed evidence section after the composer without changing the timeline', () => {
  const render = (state: Workspace) => renderToStaticMarkup(createElement(ConversationView, { conversation: room, workspace: state,
    refresh: async () => {}, onSelectAgent: () => {} }));
  const initial = render(workspace());
  const refreshed = render(workspace({ browserCaptures: [capture, { ...capture, id: 'another' }] }));
  for (const html of [initial, refreshed]) {
    assert.match(html, /aria-label="실제 작업 대화 기록"/); assert.match(html, /placeholder="논의에 참여하거나 다음 작업을 전달합니다."/);
    assert.ok(html.indexOf('class="conversation-composer"') < html.indexOf('class="browser-evidence"'));
    assert.doesNotMatch(html, /<details class="browser-evidence"[^>]*open/);
  }
});
