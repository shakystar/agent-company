import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactPreviews, ArtifactPreviewViewer, previewFolderChoices, previewVersionRefs, artifactPreviewDownloadHref } from '../src/ArtifactPreviews.tsx';
import type { Workspace } from '../shared/types.ts';
import type { SharedArtifact } from '../shared/collaboration.ts';
import { pinArtifactPreview } from '../server/artifact-preview.ts';

const date = '2026-09-11T05:00:00.000Z';
const scope = { type: 'team' as const, id: randomUUID() };
const artifacts: SharedArtifact[] = ['site/index.html', 'site/demo/index.html', 'site/demo/app.js'].map((name, i) => ({
  id: randomUUID(), scope, name, content: i === 2 ? 'console.log("demo")' : '<h1>검수</h1>', mediaType: 'text/plain',
  authorAgentId: null, version: i + 1, history: [], createdAt: date, updatedAt: date,
}));
const workspace: Workspace = { agents: [], runs: [], memories: [], skills: [], snapshots: [], activities: [],
  teams: [{ id: scope.id, name: '검수', description: '', workflow: '', memberIds: [], version: 1, createdAt: date, updatedAt: date }],
  approvals: [], connections: [], projects: [], sharedArtifacts: artifacts,
  runtime: { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: '' } };
const manifest = pinArtifactPreview({ teams: workspace.teams, projects: [], sharedArtifacts: artifacts }, { scope, prefix: 'site' });
const refresh = async () => {};

test('preview folder and version selection includes each file without mixing scopes or forcing a site name', () => {
  assert.deepEqual(previewFolderChoices(artifacts), ['site', 'site/demo']);
  assert.deepEqual(previewVersionRefs(artifacts, 'site'), artifacts.map(item => ({ artifactId: item.id, version: item.version })));
  assert.equal(previewVersionRefs(artifacts, 'site/demo').length, 2);
  assert.equal(previewVersionRefs(artifacts, 'si').length, 0);
  assert.equal(previewVersionRefs(artifacts, '').length, 3);
  assert.equal(artifactPreviewDownloadHref('a/b'), '/api/artifact-previews/a%2Fb/download');
});
test('saved preview UI exposes provenance and complete archive but never opens generated content during rendering', () => {
  const html = renderToStaticMarkup(createElement(ArtifactPreviews, { workspace: { ...workspace, artifactPreviews: [manifest] }, scope, refresh }));
  for (const label of ['산출물 미리보기·검수', '검수 버전', '포함된 파일·버전', '전체 ZIP 다운로드', '미리보기 열기', '개인정보', manifest.sourceHash]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /<iframe|<h1>검수<\/h1>|srcDoc|dangerouslySetInnerHTML/);
  assert.ok(html.includes('site/demo')); assert.ok(html.includes('v3'));
});
test('feedback default explicitly records without execution; frame attributes preserve isolation and controller-only origin referral', async () => {
  const conversation = { id: randomUUID(), scope, title: '실제 작업실', participantAgentIds: [], createdAt: date, updatedAt: date };
  const html = renderToStaticMarkup(createElement(ArtifactPreviewViewer, { workspace: { ...workspace, conversations: [conversation] }, manifest, refresh }));
  for (const label of ['대화에 기록만', '기록만 남기며 에이전트를 시작하지 않습니다', '의견 기록', '이 버전에 대한 의견']) assert.ok(html.includes(label));
  const source = await readFile(new URL('../src/ArtifactPreviews.tsx', import.meta.url), 'utf8');
  assert.match(source, /sandbox="allow-scripts allow-same-origin allow-forms"/);
  assert.match(source, /referrerPolicy="strict-origin"/);
  assert.doesNotMatch(source, /allow-top-navigation|allow-popups|dangerouslySetInnerHTML|srcDoc/);
});
test('viewer lifecycle source sends no requests on passive mount or unmount and retains explicit session controls', async () => {
  const source = await readFile(new URL('../src/ArtifactPreviews.tsx', import.meta.url), 'utf8');
  const viewerStart = source.indexOf('export function ArtifactPreviewViewer(');
  const renderStart = source.indexOf('return <section', viewerStart);
  assert.ok(viewerStart >= 0 && renderStart > viewerStart);
  const lifecycle = source.slice(viewerStart, renderStart);
  assert.match(lifecycle, /mounted\.current = true/);
  assert.match(lifecycle, /mounted\.current = false/);
  assert.doesNotMatch(lifecycle, /\brequest\s*(?:<[^>]+>)?\s*\(/);
  assert.match(lifecycle, /setTimeout\(\(\) => setExpired\(true\)/);
  assert.match(source, /const opened = await request<ArtifactPreviewSession>\([^\n]+\/open`[\s\S]*?'POST'/);
  assert.match(source, /if \(!mounted\.current\) \{ await request\([^\n]+\/session`, 'DELETE'\); return; \}/);
  assert.match(source, /await request\([^\n]+\/session`, 'DELETE'\); setSession\(null\); setExpired\(false\);/);
});
