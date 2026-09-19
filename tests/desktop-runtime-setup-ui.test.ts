import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesktopRuntimeSetupStatus } from '../shared/desktop-runtime-setup.ts';
import { DesktopRuntimeSetupPanel } from '../src/DesktopRuntimeSetupView.tsx';

const initial: DesktopRuntimeSetupStatus = { available: true, imageInstallAvailable: true, recoveryAvailable: false, recovery: null, revision: 0, phase: 'unconfigured', selection: null, progress: null, error: null };
const render = (status = initial, extra: Partial<Parameters<typeof DesktopRuntimeSetupPanel>[0]> = {}) => renderToStaticMarkup(createElement(DesktopRuntimeSetupPanel, {
  status, refresh: () => {}, configure: () => {}, recovery: () => {}, cancel: () => {}, ...extra,
}));
test('first setup offers explicit install and original probe-only save with empty inputs', () => {
  const html = render(); assert.match(html, /실행 이미지 설치하고 저장/); assert.match(html, /확인하고 저장/);
  assert.match(html, /없는 실행 이미지를 다운로드하거나 설치/); assert.match(html, /계정 연결이나 실제 모델 호출의 성공을 의미하지 않습니다/);
  assert.match(html, /value="install" disabled=""/); assert.match(html, /value="configure" disabled=""/);
  assert.doesNotMatch(render({ ...initial, imageInstallAvailable: false }), /실행 이미지 설치하고 저장/);
});
test('installation shows progress and keeps cancel outside the disabled fieldset', () => {
  const html = render({ ...initial, phase: 'installing', progress: { stage: 'loading', completed: 1, total: 2 } }, { pending: true, pendingAction: 'install' });
  assert.match(html, /실행 이미지 설치 중/); assert.match(html, /<fieldset[^>]*disabled=""/);
  assert.match(html, /<progress aria-label="실행 이미지 설치 진행" max="2" value="1"/);
  assert.match(html, /<button class="button subtle" type="button">실행 환경 작업 취소/);
  assert.ok(html.indexOf('</fieldset>') < html.indexOf('실행 환경 작업 취소'));
});
test('registry download reports its phase and local image reuse before installation', () => {
  const html = render({ ...initial, phase: 'installing', progress: { stage: 'downloading', completed: 0, total: 2 } });
  assert.match(html, /이미지 다운로드/); assert.match(render(), /이미 설치된 버전은 재사용/);
});
test('canceling says cleanup is pending while preventing duplicate writes and cancellation', () => {
  const html = render({ ...initial, phase: 'canceling' }, { pending: true, pendingAction: 'install', cancelPending: true });
  assert.match(html, /실행 환경 작업 취소 중/); assert.match(html, /진행 중인 이미지 처리가 끝나면 취소됩니다/);
  assert.match(html, /disabled="">취소 정리 중/); assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /설정은 저장하지 않았습니다/);
});
test('saving and closing phases cannot offer a misleading cancellation or completed installation', () => {
  for (const phase of ['saving', 'closing'] as const) {
    const html = render({ ...initial, phase }); assert.doesNotMatch(html, /실행 환경 작업 취소|취소 정리 중|앱을 닫고 다시 시작하면 적용/);
  }
});
test('completed cancellation leaves an editable initial form with a status message', () => {
  const html = render({ ...initial, error: { code: 'SETUP_RUNTIME_CANCELLED', message: '실행 환경 작업을 취소했습니다. 설정은 저장하지 않았습니다.' } });
  assert.match(html, /설정은 저장하지 않았습니다/); assert.doesNotMatch(html, /<fieldset[^>]*disabled=""/);
  assert.match(html, /실행 환경 미설정/); assert.doesNotMatch(html, /실행 환경 저장됨/);
});

const recovery: DesktopRuntimeSetupStatus = { ...initial, available: false, imageInstallAvailable: false, recoveryAvailable: true, phase: 'recoveryRequired',
  recovery: { fingerprint: 'a'.repeat(64), selection: { kind: 'wsl-docker', wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Recorded-Ubuntu', model: 'recorded-model' },
    images: [{ kind: 'worker', status: 'present' }, { kind: 'browser', status: 'missing' }] } };
test('recovery requires diagnosis first and displays only the recorded readonly target and image metadata', () => {
  const before = render({ ...recovery, recovery: null }); assert.match(before, /실행 이미지 상태 진단/); assert.doesNotMatch(before, /실행 이미지 복구하고 저장|<input|<form/);
  const html = render(recovery); assert.match(html, /Recorded-Ubuntu/); assert.match(html, /recorded-model/); assert.match(html, /실행 이미지 복구하고 저장/);
  assert.match(html, /실행 이미지/); assert.match(html, /이미지 있음/); assert.match(html, /브라우저 이미지/); assert.match(html, /이미지 없음/);
  assert.match(html, /진단은 이미지 등록 상태만 조회/); assert.doesNotMatch(html, /<input|<form|실행 이미지 설치하고 저장|aaaaaaaa/);
  assert.doesNotMatch(render({ ...recovery, recoveryAvailable: false, recovery: null }), /실행 이미지 상태 진단|실행 이미지 복구하고 저장/);
});
test('recovery work blocks duplicate actions but retains cancel until the commit boundary', () => {
  for (const phase of ['diagnosing', 'recovering', 'checking'] as const) {
    const html = render({ ...recovery, phase }, { pending: true, pendingAction: phase === 'diagnosing' ? 'recovery/inspect' : 'recovery/retry' });
    assert.match(html, /<button class="button subtle" type="button">실행 환경 작업 취소/);
    assert.match(html, /<button class="button" type="button" disabled=""/); assert.doesNotMatch(html, /<form|<input/);
  }
  const cancelling = render({ ...recovery, phase: 'canceling' }, { cancelPending: true, pendingAction: 'recovery/retry' });
  assert.match(cancelling, /진행 중인 이미지 처리가 끝나면 취소됩니다/); assert.doesNotMatch(cancelling, /복구 작업을 취소했습니다/);
  const saving = render({ ...recovery, phase: 'saving' }); assert.doesNotMatch(saving, /실행 환경 작업 취소|앱을 닫고 다시 시작하면 적용/);
});
