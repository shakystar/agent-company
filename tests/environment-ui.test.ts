import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Run, Snapshot, Workspace } from '../shared/types.ts';
import type { EnvironmentRevision } from '../shared/environment.ts';
import { EnvironmentView, EnvironmentProposalForm, environmentDraft, parseEnvironmentDraft } from '../src/EnvironmentView.tsx';
import { AgentDetail } from '../src/AgentDetail.tsx';
import { RestoreForm } from '../src/AgentForms.tsx';

const date = '2026-09-06T12:00:00.000Z';
const agent: Agent = { id: 'agent', name: 'Agent', description: '', persona: 'Test', model: 'fixture', status: 'idle',
  color: '#72836b', generation: 0, parentId: null, parentSnapshotId: null, version: 1,
  allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const revision: EnvironmentRevision = { id: 'ready-revision', agentId: agent.id, baseRevisionId: null,
  sourceRunId: null, buildRunId: 'build', reason: 'Local data processing',
  spec: { packages: [{ name: '@fixture/tool', version: '1.2.3' }], servers: [{ name: 'local', package: '@fixture/tool', bin: 'fixture-mcp',
    args: [], probe: { tool: 'convert', arguments: { input: 'fixture' } } }] }, requestedAccess: [], status: 'ready',
  report: { imageId: 'sha256:fixture', contentHash: 'content-hash', lockfileHash: 'lock-hash', packages: [{ name: '@fixture/tool', version: '1.2.3' }],
    tools: [{ server: 'local', name: 'convert', description: 'Local conversion', inputSchema: { type: 'object' } }],
    checks: [{ name: 'MCP probe', passed: true, detail: 'Actual tool response' }], createdAt: date },
  error: null, createdAt: date, completedAt: date };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], skills: [], runs: [], memories: [], snapshots: [],
  activities: [], teams: [], approvals: [], connections: [], runtime: { mode: 'docker', available: false, authenticated: false,
    image: 'fixture', model: 'fixture', version: null, message: 'no model' }, environmentRevisions: [revision], ...extra });
const render = (revisions: EnvironmentRevision[], selected: string | null = null, busy = false) => renderToStaticMarkup(createElement(EnvironmentView,
  { agent: { ...agent, environmentRevisionId: selected }, workspace: workspace({ environmentRevisions: revisions }), busy, refresh: async () => {} }));

test('environment form roundtrips a pinned package and MCP tool input without mutating its source', () => {
  const original = structuredClone(revision);
  const draft = environmentDraft(revision);
  assert.deepEqual(parseEnvironmentDraft(draft), { reason: revision.reason, spec: revision.spec, requestedAccess: [] });
  draft.packages[0].version = '2.0.0';
  assert.deepEqual(revision, original);
  assert.equal(parseEnvironmentDraft(draft).spec.packages[0].version, '2.0.0');
});

test('environment editor retains invalid JSON and rejected version drafts unchanged', () => {
  for (const field of ['args', 'arguments'] as const) {
    const draft = environmentDraft(revision); draft.servers[0][field] = '{unfinished';
    const before = structuredClone(draft);
    assert.throws(() => parseEnvironmentDraft(draft), /JSON/);
    assert.deepEqual(draft, before);
  }
  for (const version of ['latest', '^1.2.3', 'https://external.example/archive.tgz']) {
    const draft = environmentDraft(revision); draft.packages[0].version = version;
    const before = structuredClone(draft);
    assert.throws(() => parseEnvironmentDraft(draft), /환경 구성 확인/);
    assert.deepEqual(draft, before);
  }
});

test('environment editor validates probe shape and declared package membership', () => {
  const draft = environmentDraft(revision);
  draft.servers[0].arguments = '[]';
  assert.throws(() => parseEnvironmentDraft(draft), /환경 구성 확인/);
  draft.servers[0].arguments = '{}'; draft.servers[0].package = 'not-declared';
  assert.throws(() => parseEnvironmentDraft(draft), /환경 구성 확인/);
  draft.servers[0].package = '@fixture/tool'; draft.servers[0].args = '{}';
  assert.throws(() => parseEnvironmentDraft(draft), /환경 구성 확인/);
});

test('access expansion stays visible as blocked without approval or ready actions', () => {
  const blocked: EnvironmentRevision = { ...revision, id: 'blocked', status: 'blocked', report: undefined,
    requestedAccess: ['New account', '<script>credential request</script>'], error: 'Existing access only' };
  const html = render([blocked]);
  assert.match(html, /접근 확대 차단/); assert.match(html, /New account/);
  assert.match(html, /추가 접근은 대표 요청함에서 결정·처리·검증/);
  assert.match(html, /승인만으로 계정 연결이나 권한이 추가되지는 않습니다/);
  assert.match(html, /href="#requests"/);
  assert.doesNotMatch(html, />승인<|이 환경 사용|구축 취소|<script>/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /완료된 검증 보고서가 없습니다/);
  const draft = environmentDraft(blocked); draft.requestedAccess = ' New account \n\n New repository \n';
  assert.deepEqual(parseEnvironmentDraft(draft).requestedAccess, ['New account', 'New repository']);
});

test('environment results distinguish failed checks, missing reports and actual ready selection', () => {
  const failed: EnvironmentRevision = { ...revision, id: 'failed', status: 'failed', error: 'Probe failed',
    report: { ...revision.report!, checks: [{ name: 'MCP probe', passed: false, detail: 'Tool returned error' }] } };
  const html = render([revision, failed, { ...revision, id: 'no-report', status: 'cancelled', report: undefined }]);
  assert.equal((html.match(/>이 환경 사용</g) ?? []).length, 1);
  assert.match(html, /검증 실패/); assert.match(html, /0\/1 통과/); assert.match(html, /MCP probe · 실패/);
  assert.match(html, /Tool returned error/); assert.match(html, /Probe failed/);
  assert.match(html, /완료된 검증 보고서가 없습니다/); assert.match(html, /구성을 복사해 편집/);
  assert.match(html, /local\/convert/); assert.match(html, /content-hash/); assert.match(html, /lock-hash/);
});

test('active environment selection is explicit and inaccessible agents do not leak into the view', () => {
  const html = render([revision, { ...revision, agentId: 'other', id: 'other-env', reason: 'Private other agent reason' }], revision.id);
  assert.match(html, /다음 작업에 사용/); assert.match(html, /기본 환경으로 복귀/);
  assert.doesNotMatch(html, /이 환경 사용|Private other agent reason/);
  assert.match(render([], 'missing'), /선택된 환경 기록 미확인/);
  assert.match(render([]), /추가 개인 환경이 없습니다/);
});

test('running work prevents environment selection while an owned build remains cancellable', () => {
  const html = render([revision, { ...revision, id: 'building', status: 'building', report: undefined }], revision.id, true);
  assert.match(html, /disabled=""[^>]*>[^<]*<svg[^]*?기본 환경으로 복귀/);
  assert.match(html, /class="button danger-subtle"><svg[^]*?구축 취소/);
  assert.match(html, /환경 적용과 새 구축은 대기합니다/);
});

test('draft renders controlled inputs and blocks submission during work without hiding user text', () => {
  const draft = environmentDraft(revision); draft.reason = 'Keep my unsaved reason'; draft.servers[0].arguments = '{unfinished';
  const html = renderToStaticMarkup(createElement(EnvironmentProposalForm, { agentId: agent.id, initialDraft: draft,
    busy: true, onClose: () => {}, onSaved: async () => {} }));
  assert.match(html, /Keep my unsaved reason/); assert.match(html, /\{unfinished/);
  assert.match(html, /type="submit"[^>]*disabled=""/);
  assert.match(html, /MCP 1 검증 입력/); assert.match(html, /패키지 1 버전/);
});

test('restore UI offers environment restoration separately from memory, skills and files', () => {
  const snapshot: Snapshot = { id: 'snapshot', agentId: agent.id, label: 'Saved', agentVersion: 1,
    agent: { ...agent, environmentRevisionId: revision.id }, memories: [], skills: [], sourceRunId: null, createdAt: date };
  const html = renderToStaticMarkup(createElement(RestoreForm, { agent, snapshot, onClose: () => {}, onSaved: async () => {} }));
  assert.match(html, /개인 환경도 복원 \(보존된 패키지·MCP 버전\)/);
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 4);
});

test('environment build run is identified and cancellable without task steering', () => {
  const run: Run = { id: 'build', agentId: agent.id, agentVersion: 1, snapshotId: 'snapshot', prompt: 'Build environment',
    status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], kind: 'environment',
    createdAt: date, startedAt: date, completedAt: null };
  const html = renderToStaticMarkup(createElement(AgentDetail, { agent, workspace: workspace({ runs: [run] }),
    onBack: () => {}, onSelect: () => {}, refresh: async () => {} }));
  assert.match(html, /tab-environment/); assert.match(html, /환경 구축 중에는 패키지·MCP 구성을 고정합니다/);
  assert.match(html, /구축 취소/); assert.doesNotMatch(html, /id="steering"|undefined/);
});
