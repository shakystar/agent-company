import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Workspace } from '../shared/types.ts';
import type { DesktopMcpGrant, DesktopMcpStatus } from '../shared/desktop-mcp.ts';
import { DesktopMcpPanel } from '../src/DesktopMcpView.tsx';

const date = '2026-09-12T01:00:00.000Z';
const workspace: Workspace = { agents: [], teams: [{ id: 'team-1', name: '제작팀', description: '', workflow: '', memberIds: [], version: 1, createdAt: date, updatedAt: date }],
  projects: [{ id: 'project-1', name: '브랜드 웹 제작', description: '', teamIds: ['team-1'], version: 1, createdAt: date, updatedAt: date }],
  runs: [], memories: [], skills: [], snapshots: [], approvals: [], activities: [], connections: [], runtime: {
    mode: 'docker', simulation: true, available: false, authenticated: false, image: '', model: '', version: null, message: '' } };
const status: DesktopMcpStatus = { available: true, revision: 1, generationKey: 'current', grants: [], error: null };
const grant: DesktopMcpGrant = { id: 'grant-1', label: '기획 도구', scope: { type: 'team', id: 'team-1' }, submitTasks: false,
  budgetTeamId: 'team-1', createdAt: date, revokedAt: null, generationKey: 'current' };
const props = { workspace, status, refresh: () => {}, create: () => {}, revoke: () => {}, clearConfiguration: () => {} };
const render = (changes: Partial<Parameters<typeof DesktopMcpPanel>[0]> = {}) => renderToStaticMarkup(createElement(DesktopMcpPanel, { ...props, ...changes }));

test('MCP creation starts read-only with explicit empty scope selection and accessible labels', () => {
  const html = render();
  assert.match(html, /aria-label="로컬 MCP 연결"/); assert.match(html, /공유할 팀/); assert.match(html, /value="" selected=""/);
  assert.match(html, /type="checkbox"/); assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /disabled=""[^>]*>.*?연결 설정 생성</); assert.match(html, /대표 승인·계정 설정·멤버 변경 권한은 제공하지 않습니다/);
  assert.match(html, /<label for="[^"]+">연결 이름/); assert.match(html, /maxLength="100"/);
  assert.match(html, /등록한 과제는 팀의 기존 자동 실행 설정을 따릅니다/);
});
test('grant list uses current scope and budget labels and distinguishes revoked and previous generations', () => {
  const html = render({ status: { ...status, grants: [grant, { ...grant, id: 'old', label: '복원 전', generationKey: 'previous' },
    { ...grant, id: 'revoked', label: '회수된 연결', revokedAt: date },
    { ...grant, id: 'project', scope: { type: 'project', id: 'project-1' }, submitTasks: true }] } });
  assert.match(html, /팀 · 제작팀/); assert.match(html, /프로젝트 · 브랜드 웹 제작/); assert.match(html, /예산 팀: 제작팀/);
  assert.match(html, /복원 이전 연결 · 사용 불가/); assert.match(html, /회수됨/); assert.match(html, /읽기 전용/);
  assert.match(html, /disabled=""[^>]*aria-label="회수된 연결 연결 회수"/);
});
test('unavailable and failed reads disable actions without claiming grants remain usable', () => {
  for (const changes of [{ status: { ...status, available: false, error: 'PRIVATE_RAW_DIAGNOSTIC', grants: [grant] } },
    { status: { ...status, grants: [grant] }, readFailed: true }]) {
    const html = render(changes); assert.match(html, /role="alert"/); assert.match(html, /<fieldset disabled=""/);
    assert.match(html, /상태 확인 불가/); assert.doesNotMatch(html, /사용 가능|PRIVATE_RAW_DIAGNOSTIC/);
  }
});
test('pending mutations block form, refresh and revocation while retaining grant details', () => {
  const html = render({ status: { ...status, grants: [grant] }, pending: true });
  assert.match(html, /aria-busy="true"/); assert.match(html, /<fieldset disabled=""/);
  assert.match(html, /disabled=""[^>]*>.*?연결 상태 다시 조회</); assert.match(html, /disabled=""[^>]*aria-label="기획 도구 연결 회수"/);
  assert.match(html, /기획 도구/);
});
test('one-time configuration has read-only JSON, copy and close controls and is absent once cleared', () => {
  const configuration = { mcpServers: { agent_company: { command: 'node.exe', args: ['bridge.js'], env: { AGENT_COMPANY_MCP_TOKEN: 'PUBLIC_FIXTURE_TOKEN' } } } };
  const html = render({ configuration }); assert.match(html, /PUBLIC_FIXTURE_TOKEN/); assert.match(html, /<textarea[^>]*readOnly=""/);
  assert.match(html, /연결 설정 복사/); assert.match(html, /aria-label="연결 설정 닫기"/); assert.match(html, /한 번만 표시/);
  assert.match(html, /연결 비밀값이 포함됩니다/); assert.match(html, /앱이 실행 중일 때 연결할 수 있습니다/);
  assert.match(html, /<fieldset disabled=""/); assert.doesNotMatch(render(), /PUBLIC_FIXTURE_TOKEN|MCP 연결 설정 JSON/);
});
test('restored unavailable state blocks creation but keeps old-grant revocation and restart guidance', () => {
  const restored = { ...status, available: false, grants: [{ ...grant, generationKey: 'previous' }] };
  const html = render({ status: restored });
  assert.match(html, /작업실 복원 후 새 연결을 만들려면 앱을 다시 시작해야 합니다/);
  assert.match(html, /<fieldset disabled=""/); assert.doesNotMatch(html, /disabled=""[^>]*aria-label="기획 도구 연결 회수"/);
  assert.match(render({ status: restored, readFailed: true }), /disabled=""[^>]*aria-label="기획 도구 연결 회수"/);
});
test('unknown scopes and hostile names are rendered as text, without grants secrets', () => {
  const html = render({ status: { ...status, grants: [{ ...grant, label: '<script>bad()</script>', scope: { type: 'project', id: 'missing' } }] } });
  assert.match(html, /현재 작업실에 없는 범위/); assert.doesNotMatch(html, /<script>|tokenHash/); assert.match(html, /&lt;script&gt;/);
});
