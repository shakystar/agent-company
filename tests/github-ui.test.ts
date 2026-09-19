import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Connection, Workspace } from '../shared/types.ts';
import type { GitHubStatus, RepositoryGrant } from '../shared/repositories.ts';
import { GitHubConnections, GitHubConnectionCard, GitHubConnectionEditor, GitHubRegisterForm, GitHubServerStatus,
  githubConnectionDraft, githubPermissionFingerprint, parseGitHubConnectionDraft } from '../src/GitHubConnections.tsx';
import { SettingsView } from '../src/WorkspaceViews.tsx';

const date = '2026-09-09T12:00:00.000Z';
const agent: Agent = { id: randomUUID(), name: '제작 에이전트', description: '', persona: 'fixture', model: 'fixture', status: 'idle',
  color: '#72836b', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date };
const teamId = randomUUID(), projectId = randomUUID();
const grant: RepositoryGrant = { agentId: agent.id, teamId, projectId, access: 'write' };
const connection: Connection = { id: randomUUID(), repository: 'formnest/studio-site', access: 'write', version: 3, createdAt: date,
  github: { status: 'connected', repositoryId: 42, defaultBranch: 'main', generation: randomUUID(), verifiedAt: date }, grants: [grant] };
const status: GitHubStatus = { configured: true, missing: [], repositories: [connection.repository], writable: true };
const workspace = (extra: Partial<Workspace> = {}): Workspace => ({ agents: [agent], runs: [], memories: [], skills: [], snapshots: [], activities: [],
  teams: [{ id: teamId, name: '사이트 팀', description: '', workflow: '', memberIds: [agent.id], version: 1, createdAt: date, updatedAt: date }],
  projects: [{ id: projectId, name: '대표 작품', description: '', teamIds: [teamId], version: 1, createdAt: date, updatedAt: date }],
  approvals: [], connections: [connection], runtime: { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', message: '', version: null }, ...extra });
const noop = () => {};
const refresh = async () => {};
const card = (value = connection, configuration: GitHubStatus | null = status) => renderToStaticMarkup(createElement(GitHubConnectionCard,
  { connection: value, workspace: workspace({ connections: [value] }), status: configuration, refresh, onEdit: noop }));

test('repository draft is isolated from polling objects and serializes only grant metadata', () => {
  const original = structuredClone(connection), draft = githubConnectionDraft(connection);
  assert.deepEqual(parseGitHubConnectionDraft(draft, workspace()), { access: 'write', grants: [grant] });
  draft.grants[0].access = 'read';
  assert.deepEqual(connection, original);
  assert.equal(parseGitHubConnectionDraft(draft, workspace()).grants[0].access, 'read');
  assert.equal('rowId' in parseGitHubConnectionDraft(draft, workspace()).grants[0], false);
});

test('grant validation rejects incomplete scopes, revoked membership, duplicates and write above read cap without erasing drafts', () => {
  const blank = githubConnectionDraft(connection); blank.grants[0].agentId = '';
  const before = structuredClone(blank);
  assert.throws(() => parseGitHubConnectionDraft(blank, workspace()), /모두 선택/); assert.deepEqual(blank, before);
  assert.throws(() => parseGitHubConnectionDraft(githubConnectionDraft(connection), workspace({ teams: [] })), /소속/);
  assert.throws(() => parseGitHubConnectionDraft(githubConnectionDraft(connection), workspace({ agents: [] })), /소속/);
  assert.throws(() => parseGitHubConnectionDraft(githubConnectionDraft(connection), workspace({ projects: [] })), /소속/);
  const duplicate = githubConnectionDraft(connection); duplicate.grants.push({ ...duplicate.grants[0], rowId: 'second' });
  assert.throws(() => parseGitHubConnectionDraft(duplicate, workspace()), /중복/);
  const readOnly = githubConnectionDraft(connection); readOnly.access = 'read';
  assert.throws(() => parseGitHubConnectionDraft(readOnly, workspace()), /읽기 상한/);
  assert.equal(readOnly.grants[0].access, 'write');
});

test('same agent may have separately scoped grants and an empty grant list grants nothing', () => {
  const current = workspace(), otherTeam = { ...current.teams[0], id: randomUUID() }, otherProject = { ...current.projects![0], id: randomUUID(), teamIds: [otherTeam.id] };
  current.teams.push(otherTeam); current.projects!.push(otherProject);
  const draft = githubConnectionDraft(connection);
  draft.grants.push({ ...grant, rowId: 'other-scope', teamId: otherTeam.id, projectId: otherProject.id });
  assert.equal(parseGitHubConnectionDraft(draft, current).grants.length, 2);
  assert.deepEqual(parseGitHubConnectionDraft({ access: 'read', grants: [] }, current), { access: 'read', grants: [] });
});

test('server configuration is separate from actual repository verification and exposes no credential input', () => {
  const html = renderToStaticMarkup(createElement(GitHubServerStatus, { status: { configured: false, missing: ['AGENT_GITHUB_APP_ID'], repositories: [], writable: false } }));
  assert.match(html, /서버 인증 미설정/); assert.match(html, /AGENT_GITHUB_APP_ID/); assert.match(html, /외부 쓰기 설정 꺼짐/);
  assert.match(html, /입력하거나 표시하지 않습니다/); assert.doesNotMatch(html, /<input|<textarea|접속 확인됨/);
  const configured = renderToStaticMarkup(createElement(GitHubServerStatus, { status }));
  assert.match(configured, /서버 인증 설정 있음 · 저장소 접속은 개별 확인/);
  assert.doesNotMatch(configured, /접속 확인됨/);
});

test('registered, verified and disconnected repositories remain visibly distinct', () => {
  const registered = card({ ...connection, github: undefined, grants: [] });
  assert.match(registered, /범위만 등록됨/); assert.match(registered, /확인 기록 없음/); assert.match(registered, /허용된 에이전트가 없습니다/);
  assert.doesNotMatch(registered, /연결 해제<|접속 확인됨/);
  const verified = card();
  for (const label of ['접속 확인됨', '마지막 접속 확인', 'main', '제작 에이전트', '사이트 팀', '대표 작품', '연결 해제']) assert.ok(verified.includes(label));
  const disconnected = card({ ...connection, github: { ...connection.github!, status: 'disconnected' } });
  assert.match(disconnected, /연결 해제됨/); assert.match(disconnected, /과거 접속 결과/); assert.match(disconnected, /접속 확인·재연결/);
  assert.doesNotMatch(disconnected, />연결 해제</);
});

test('verification stays disabled when authentication or approved repository is missing', () => {
  for (const configuration of [null, { ...status, configured: false }, { ...status, repositories: ['other/repository'] }]) {
    const html = card(connection, configuration);
    assert.match(html, /<button class="button" disabled=""[^]*?접속 다시 확인/);
    assert.match(html, /이전 접속 확인과 현재 서버 구성은 다릅니다/);
  }
});

test('editor preserves explicit controlled drafts, scoped selections and absent-member errors', () => {
  const draft = githubConnectionDraft(connection); draft.grants[0].agentId = randomUUID();
  const html = renderToStaticMarkup(createElement(GitHubConnectionEditor, { connection, workspace: workspace(), status,
    onClose: noop, onSaved: refresh, initialDraft: draft }));
  for (const label of ['권한 1 프로젝트', '권한 1 원팀', '권한 1 에이전트', '권한 1 접근 범위', '현재 원팀에 없는 에이전트', '권한 1 제거']) assert.ok(html.includes(label));
  assert.match(html, new RegExp(`value="${draft.grants[0].agentId}" selected=""`));
  assert.match(html, /다음 작업부터 적용/); assert.match(html, /상담에서는 읽기만/);
  assert.doesNotMatch(html, /모든 에이전트|type="password"/);
});

test('polling scope changes disable save without replacing the edit draft', () => {
  const newer = { ...connection, version: 4, grants: [] };
  assert.notEqual(githubPermissionFingerprint(connection), githubPermissionFingerprint(newer));
  const html = renderToStaticMarkup(createElement(GitHubConnectionEditor, { connection, workspace: workspace({ connections: [newer] }), status,
    onClose: noop, onSaved: refresh }));
  assert.match(html, /편집 중 연결이나 권한이 변경/); assert.match(html, /제작 에이전트/);
  assert.match(html, /type="submit" disabled=""/);
});

test('new connection registration defaults to read and never claims to authenticate', () => {
  const html = renderToStaticMarkup(createElement(GitHubRegisterForm, { onClose: noop, onSaved: refresh }));
  assert.match(html, /value="read" selected=""/); assert.match(html, /접근 범위만 등록/); assert.match(html, /인증 정보를 생성하지 않습니다/);
  assert.doesNotMatch(html, /type="password"|type="hidden"/);
});

test('connection page explains clone and deployment boundaries and escapes external labels', () => {
  const html = renderToStaticMarkup(createElement(GitHubConnections, { workspace: workspace({ connections: [{ ...connection, repository: '<script>bad</script>' }] }), refresh }));
  assert.match(html, /복제본에 자동 상속하지 않습니다/); assert.match(html, /기본 브랜치 직접쓰기·병합·배포는 포함하지 않습니다/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test('mutation source uses versioned PATCH, explicit verification and useAction without resetting drafts in effects', async () => {
  const source = await readFile(new URL('../src/GitHubConnections.tsx', import.meta.url), 'utf8');
  assert.match(source, /\/verify`, 'POST', \{\}/);
  assert.match(source, /enabled: false, expectedVersion: connection\.version \?\? 0/);
  assert.match(source, /\.\.\.input, expectedVersion: connection\.version \?\? 0/);
  assert.doesNotMatch(source, /enabled: true|localStorage|sessionStorage|dangerouslySetInnerHTML/);
  assert.match(source, /useState\(\(\) => structuredClone\(initialDraft \?\? githubConnectionDraft\(connection\)\)\)/);
  assert.match(source, /action\.execute\(submit\)/);
  assert.match(source, /controller\.abort\(\)/);
  const actionHook = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(actionHook, /finally \{ lock\.current = false; setPending\(false\); \}/);
});

test('settings integrates the live GitHub panel once and retains runtime controls', async () => {
  const html = renderToStaticMarkup(createElement(SettingsView, { workspace: workspace(), refresh }));
  assert.equal((html.match(/aria-label="GitHub 저장소 연결"/g) ?? []).length, 1);
  assert.match(html, /에이전트 실행기/); assert.match(html, /상태 새로고침/); assert.match(html, /역할별 권한 편집/);
  const source = await readFile(new URL('../src/WorkspaceViews.tsx', import.meta.url), 'utf8');
  assert.match(source, /<GitHubConnections workspace=\{workspace\} refresh=\{refresh\} \/>/);
  assert.doesNotMatch(source, /setAdding|setRepository|setAccess|request\('\/connections'/);
});
