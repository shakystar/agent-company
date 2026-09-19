import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Workspace } from '../shared/types.ts';
import type { DeploymentStatus } from '../shared/deployment.ts';
import { DeploymentNotice, DeploymentPanel, deploymentHeld } from '../src/DeploymentView.tsx';
import { SettingsView } from '../src/WorkspaceViews.tsx';

const date = '2026-09-11T12:00:00.000Z';
const status: DeploymentStatus = { phase: 'running', requestedAt: null, readyAt: null, activeRunIds: [], pendingRunCount: 7, reason: null };
const workspace = (deployment?: DeploymentStatus): Workspace => ({ agents: [], teams: [], runs: [], memories: [], skills: [], snapshots: [], approvals: [], activities: [], connections: [],
  deployment, runtime: { mode: 'docker', simulation: true, available: true, authenticated: true, image: 'pinned-fixture', model: 'fixture', version: null, message: 'No models' } });
const panel = (deployment: DeploymentStatus | null = status, extra: { pending?: boolean; error?: string } = {}) => renderToStaticMarkup(createElement(DeploymentPanel, {
  status: deployment, workspace: workspace(deployment ?? undefined), onPrepare: () => {}, onResume: () => {}, onRefresh: () => {}, ...extra,
}));

test('unknown deployment state is not reported as running and cannot begin preparation', () => {
  const html = panel(null); assert.match(html, /배포 상태 확인 중/); assert.match(html, /disabled=""[^>]*>.*?배포 준비</);
  assert.doesNotMatch(html, /작업 실행 허용|배포 준비 완료/); assert.equal(deploymentHeld(undefined), false);
});

test('running state offers preparation while preserving nonzero unfinished work', () => {
  const html = panel(); assert.match(html, /작업 실행 허용/); assert.match(html, /보존된 미완료 작업/);
  assert.match(html, /<dd>7<small>건/); assert.match(html, /현재 턴은 마무리한 뒤 보존/);
  assert.doesNotMatch(html, />작업 재개<|미완료 작업이 없어야|자동 배포|배포 성공/);
});

test('draining has its own active count, durable hold explanation and explicit resume control', () => {
  const draining: DeploymentStatus = { ...status, phase: 'draining', requestedAt: date, activeRunIds: ['first-run', 'second-run'] };
  const html = panel(draining); assert.match(html, /배포 준비 중/); assert.match(html, /진행 중인 실행 2건 확인/);
  assert.match(html, /<dd>2<small>건/); assert.match(html, /서버 재시작 후에도 유지/); assert.match(html, />작업 재개</);
  assert.equal(deploymentHeld(draining), true); assert.doesNotMatch(html, /배포 준비 완료|배포 성공/);
});

test('ready with pending work means transition can proceed, not that deployment or every task is finished', () => {
  const html = panel({ ...status, phase: 'ready', requestedAt: date, readyAt: date });
  assert.match(html, /배포 준비 완료/); assert.match(html, /<dd>7<small>건/);
  assert.match(html, /실제 전환은 별도 정식 배포 절차/); assert.match(html, /기존 실행은 사용하던 이미지로 이어갑니다/);
  assert.match(html, /새 실행은 정식 전환으로 활성화한 이미지/); assert.match(html, /개별 작업의 사용자 중지와 기존 예산 한도는 유지/);
  assert.doesNotMatch(html, /배포 성공|배포 완료|작업 전체 완료/);
});

test('blocked state exposes the reason and busy or failed actions do not replace saved phase', () => {
  const blocked = { ...status, phase: 'blocked' as const, requestedAt: date, reason: '<script>not executable</script> Worker cleanup pending' };
  const html = panel(blocked, { pending: true, error: 'Fixture POST failure' });
  assert.match(html, /배포 준비 보류/); assert.match(html, /Worker cleanup pending/); assert.match(html, /role="alert"/);
  assert.match(html, /aria-busy="true"/); assert.match(html, /disabled=""[^>]*>.*?처리 중</);
  assert.match(html, /Fixture POST failure/); assert.match(html, /마지막으로 확인한 상태를 유지/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});

test('zero active tasks does not imply cleanup has completed', () => {
  const html = panel({ ...status, phase: 'blocked', reason: '종료 확인 대기 컨테이너 1개', requestedAt: date });
  assert.match(html, /진행 중인 과제<\/dt><dd>0/);
  assert.match(html, /종료 확인 대기 컨테이너 1개/);
  assert.match(html, /정리 상태를 자동으로 다시 확인/);
  assert.doesNotMatch(html, /현재 턴·실행 정리 중/);
});

test('hold notices link to settings and disappear when execution is allowed', () => {
  assert.equal(renderToStaticMarkup(createElement(DeploymentNotice, { status })), '');
  const html = renderToStaticMarkup(createElement(DeploymentNotice, { status: { ...status, phase: 'draining' } }));
  assert.match(html, /href="#settings"/); assert.match(html, /배포 준비 중/); assert.match(html, /새 작업 시작을 보류/);
});

test('settings keep deployment status above runtime and omit blocked auxiliary polling panels during hold', () => {
  const html = renderToStaticMarkup(createElement(SettingsView, { workspace: workspace({ ...status, phase: 'ready', requestedAt: date, readyAt: date }), refresh: async () => {} }));
  assert.match(html, /배포 준비 완료/); assert.match(html, /에이전트 실행기/);
  assert.ok(html.indexOf('작업을 보존하는 배포 준비') < html.indexOf('에이전트 실행기'));
  assert.doesNotMatch(html, /aria-label="저장공간과 백업"|지금 백업/);
  assert.match(html, /배포 상태 조회와 작업 재개는 계속 사용할 수 있습니다/);
});

test('desktop connection setup stays below the deployment panel and page heading', () => {
  const html = renderToStaticMarkup(createElement(SettingsView, {
    workspace: workspace({ ...status, phase: 'blocked', requestedAt: date, reason: '종료 확인 대기 컨테이너 1개' }),
    refresh: async () => {}, children: createElement('section', { 'aria-label': 'desktop-connection-setup' }, '연결 설정'),
  }));
  assert.ok(html.indexOf('<h1>실행 환경</h1>') < html.indexOf('작업을 보존하는 배포 준비'));
  assert.ok(html.indexOf('종료 확인 대기 컨테이너 1개') < html.indexOf('desktop-connection-setup'));
  assert.ok(html.indexOf('desktop-connection-setup') < html.indexOf('에이전트 실행기'));
});
