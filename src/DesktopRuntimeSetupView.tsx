import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, CircleAlert, Download, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import type { DesktopRuntimeSelection, DesktopRuntimeSetupInput, DesktopRuntimeSetupStatus } from '../shared/desktop-runtime-setup';
import { request } from './api';
import { ErrorNotice, SectionTitle } from './ui';

const phaseLabels: Record<DesktopRuntimeSetupStatus['phase'], string> = {
  unavailable: '실행 환경 설정 사용 불가', unconfigured: '실행 환경 미설정', checking: '실행 환경 확인 중',
  installing: '실행 이미지 설치 중', canceling: '실행 환경 작업 취소 중', saving: '실행 환경 저장 중',
  diagnosing: '실행 이미지 상태 진단 중', recovering: '실행 이미지 복구 중',
  restartRequired: '실행 환경 저장됨', configured: '실행 환경 선택됨', recoveryRequired: '실행 환경 설정 복구 필요',
  closing: '실행 환경 설정 종료 중',
};
type SetupAction = 'configure' | 'install' | 'recovery/inspect' | 'recovery/retry';
type SetupSession = {
  disposed: boolean; pending: boolean; cancelPending: boolean; controllers: Set<AbortController>;
  reading?: Promise<void>; refreshSoon: () => void;
};

function useRuntimeSetup() {
  const [status, setStatus] = useState<DesktopRuntimeSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<SetupAction | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const latest = useRef<DesktopRuntimeSetupStatus | null>(null);
  const sessionRef = useRef<SetupSession | null>(null);
  const accept = useCallback((session: SetupSession, next: DesktopRuntimeSetupStatus) => {
    if (session.disposed || sessionRef.current !== session || (latest.current && next.revision < latest.current.revision)) return;
    latest.current = next;
    setStatus(next);
  }, []);
  const refresh = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    if (!session || session.disposed) return Promise.resolve();
    if (session.reading) return session.reading;
    const controller = new AbortController(); session.controllers.add(controller);
    const reading = request<DesktopRuntimeSetupStatus>('/desktop/runtime-setup', 'GET', undefined, controller.signal)
      .then(next => {
        if (!session.disposed && sessionRef.current === session) { accept(session, next); setReadError(''); }
      }).catch(failure => {
        if (!session.disposed && sessionRef.current === session && !controller.signal.aborted) {
          setReadError(failure instanceof Error ? failure.message : '실행 환경 상태를 확인하지 못했습니다.');
        }
      }).finally(() => {
        session.controllers.delete(controller);
        if (session.reading === reading) session.reading = undefined;
        if (!session.disposed && sessionRef.current === session) setLoading(false);
      });
    session.reading = reading;
    return reading;
  }, [accept]);
  useEffect(() => {
    const session: SetupSession = { disposed: false, pending: false, cancelPending: false, controllers: new Set(), refreshSoon: () => undefined };
    sessionRef.current = session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!session.disposed && document.visibilityState === 'visible') timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (session.disposed || document.visibilityState !== 'visible') return;
      await refresh();
      schedule(session.pending || session.cancelPending || ['installing', 'checking', 'diagnosing', 'recovering', 'canceling', 'saving'].includes(latest.current?.phase ?? '') ? 1000 : 4000);
    };
    session.refreshSoon = () => schedule(0);
    const visible = () => { clearTimeout(timer); if (document.visibilityState === 'visible') session.refreshSoon(); };
    document.addEventListener('visibilitychange', visible);
    session.refreshSoon();
    return () => {
      session.disposed = true; clearTimeout(timer);
      for (const controller of session.controllers) controller.abort();
      document.removeEventListener('visibilitychange', visible);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [refresh]);
  const configure = useCallback(async (selection: DesktopRuntimeSelection, action: 'configure' | 'install' = 'configure') => {
    const session = sessionRef.current, current = latest.current;
    if (!session || session.disposed || session.pending || session.cancelPending || !current?.available || current.phase !== 'unconfigured'
      || action === 'install' && !current.imageInstallAvailable) return;
    session.pending = true; setPending(true); setPendingAction(action); setSaveError('');
    const controller = new AbortController(); session.controllers.add(controller);
    const input: DesktopRuntimeSetupInput = { revision: current.revision, selection };
    try {
      const saving = request<DesktopRuntimeSetupStatus>(`/desktop/runtime-setup/${action}`, 'POST', input, controller.signal);
      session.refreshSoon();
      accept(session, await saving);
    } catch (failure) {
      if (!session.disposed && sessionRef.current === session && !controller.signal.aborted) {
        setSaveError(failure instanceof Error ? failure.message : '실행 환경 설정을 저장하지 못했습니다.');
      }
    } finally {
      session.controllers.delete(controller); session.pending = false;
      if (!session.disposed && sessionRef.current === session) { setPending(false); setPendingAction(null); session.refreshSoon(); }
    }
  }, [accept]);
  const recovery = useCallback(async (action: 'inspect' | 'retry') => {
    const session = sessionRef.current, current = latest.current;
    if (!session || session.disposed || session.pending || session.cancelPending || !current?.recoveryAvailable
      || current.phase !== 'recoveryRequired' || action === 'retry' && !current.recovery) return;
    session.pending = true; setPending(true); setPendingAction(`recovery/${action}`); setSaveError('');
    const controller = new AbortController(); session.controllers.add(controller);
    try {
      const operation = request<DesktopRuntimeSetupStatus>(`/desktop/runtime-setup/recovery/${action}`, 'POST', { revision: current.revision }, controller.signal);
      session.refreshSoon(); accept(session, await operation);
    } catch {
      if (!session.disposed && sessionRef.current === session && !controller.signal.aborted) {
        setSaveError('복구 작업을 시작하지 못했습니다. 최신 상태를 다시 확인할 수 있습니다.');
      }
    } finally {
      session.controllers.delete(controller); session.pending = false;
      if (!session.disposed && sessionRef.current === session) { setPending(false); setPendingAction(null); session.refreshSoon(); }
    }
  }, [accept]);
  const cancel = useCallback(async () => {
    const session = sessionRef.current, current = latest.current;
    if (!session || session.disposed || session.cancelPending || !current || !['checking', 'installing', 'diagnosing', 'recovering'].includes(current.phase)) return;
    session.cancelPending = true; setCancelPending(true); setSaveError('');
    const controller = new AbortController(); session.controllers.add(controller);
    try {
      const cancelling = request<DesktopRuntimeSetupStatus>('/desktop/runtime-setup/cancel', 'POST', { revision: current.revision }, controller.signal);
      session.refreshSoon(); accept(session, await cancelling);
    } catch (failure) {
      if (!session.disposed && sessionRef.current === session && !controller.signal.aborted) {
        setSaveError(failure instanceof Error ? failure.message : '실행 환경 작업을 취소하지 못했습니다. 최신 상태를 다시 확인할 수 있습니다.');
      }
    } finally {
      session.controllers.delete(controller); session.cancelPending = false;
      if (!session.disposed && sessionRef.current === session) { setCancelPending(false); session.refreshSoon(); }
    }
  }, [accept]);
  return { status, loading, pending, pendingAction, cancelPending, readError, saveError, refresh, configure, recovery, cancel };
}

export function DesktopRuntimeSetupPanel({ status, loading = false, pending = false, pendingAction = null, cancelPending = false,
  readError = '', saveError = '', refresh, configure, recovery, cancel }: {
    status: DesktopRuntimeSetupStatus | null; loading?: boolean; pending?: boolean; pendingAction?: SetupAction | null;
    cancelPending?: boolean; readError?: string; saveError?: string; refresh: () => void;
    configure: (selection: DesktopRuntimeSelection, action?: 'configure' | 'install') => void; cancel: () => void;
    recovery: (action: 'inspect' | 'retry') => void;
  }) {
  const [wslExecutable, setWslExecutable] = useState('');
  const [distro, setDistro] = useState('');
  const [model, setModel] = useState('');
  const id = useId();
  const checking = pending || cancelPending || ['installing', 'checking', 'diagnosing', 'recovering', 'canceling', 'saving'].includes(status?.phase ?? '');
  const recoveryMode = !!status && !status.available && status.recoveryAvailable && status.phase !== 'restartRequired' && status.phase !== 'configured';
  const editable = status?.phase === 'unconfigured' && status.available && !checking;
  const hasInput = !!wslExecutable.trim() && !!distro.trim() && !!model.trim();
  const label = cancelPending ? phaseLabels.canceling : status && status.phase !== 'unconfigured' ? phaseLabels[status.phase]
    : pending ? pendingAction === 'install' ? phaseLabels.installing : phaseLabels.checking : status ? phaseLabels[status.phase]
    : loading ? '실행 환경 설정 확인 중' : '실행 환경 설정 확인 불가';
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || !hasInput) return;
    const action = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'install' ? 'install' : 'configure';
    if (action === 'install' && !status?.imageInstallAvailable) return;
    configure({ kind: 'wsl-docker', wslExecutable: wslExecutable.trim(), distro: distro.trim(), model: model.trim() }, action);
  };
  return <section className="panel desktop-runtime-setup-panel" aria-label="설치형 실행 환경 설정">
    <SectionTitle title="실행 환경 선택" detail="WSL의 Docker 환경과 사용할 모델을 직접 지정합니다."
      action={<button className="button subtle" type="button" disabled={loading || cancelPending || status?.phase === 'closing'} onClick={refresh}><RefreshCw size={14} aria-hidden="true" />실행 환경 다시 조회</button>} />
    <div className={`desktop-runtime-setup-phase desktop-runtime-setup-phase-${status?.phase ?? 'unknown'}`} role="status" aria-live="polite">
      {loading || checking || status?.phase === 'closing' ? <LoaderCircle size={18} className="spin" aria-hidden="true" />
        : status?.phase === 'configured' || status?.phase === 'restartRequired' ? <CheckCircle2 size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
      <strong>{label}</strong>
    </div>
    {status?.phase === 'unavailable' ? <p className="desktop-runtime-setup-note">이 설치본에는 사용할 수 있는 실행 환경 구성요소가 없습니다. 구성요소가 포함된 설치본에서 설정할 수 있습니다.</p> : null}
    {status?.phase === 'recoveryRequired' ? <p className="desktop-runtime-setup-note">{status.recoveryAvailable
      ? '이전 이미지 설치의 완료 여부를 확인해야 합니다. 설치 기록의 대상만 진단하고 복구할 수 있습니다.'
      : '저장된 실행 환경 설정을 확인하지 못했습니다. 설정 복구 후 다시 사용할 수 있습니다.'}</p> : null}
    {recoveryMode ? <div className="desktop-runtime-setup-recovery" aria-busy={checking}>
      {status.recovery ? <>
        <dl className="desktop-runtime-setup-selection" aria-label="설치 기록의 복구 대상">
          <div><dt>WSL 실행파일 경로</dt><dd>{status.recovery.selection.wslExecutable}</dd></div>
          <div><dt>WSL 배포판 이름</dt><dd>{status.recovery.selection.distro}</dd></div>
          <div><dt>모델 ID</dt><dd>{status.recovery.selection.model}</dd></div>
        </dl>
        <ul className="desktop-runtime-setup-images" aria-label="실행 이미지 진단 결과">{status.recovery.images.map(image => <li key={image.kind}>
          <span>{image.kind === 'worker' ? '실행 이미지' : '브라우저 이미지'}</span><strong>{image.status === 'present' ? '이미지 있음' : '이미지 없음'}</strong>
        </li>)}</ul>
      </> : null}
      <p className="desktop-runtime-setup-note">진단은 이미지 등록 상태만 조회합니다. 복구 시 설치 정보를 검증하고 기록된 대상에 다시 설치합니다.</p>
      <div className="desktop-runtime-setup-recovery-actions">
        <button className="button" type="button" disabled={checking || !!readError || status.phase !== 'recoveryRequired'} onClick={() => recovery('inspect')}>
          <RefreshCw size={15} aria-hidden="true" />실행 이미지 상태 진단</button>
        {status.recovery ? <button className="button primary" type="button" disabled={checking || !!readError || status.phase !== 'recoveryRequired'} onClick={() => recovery('retry')}>
          <Download size={15} aria-hidden="true" />실행 이미지 복구하고 저장</button> : null}
      </div>
    </div> : null}
    {status && !recoveryMode && ['unconfigured', 'installing', 'checking', 'canceling', 'saving'].includes(status.phase) ? <form onSubmit={save} autoComplete="off" aria-busy={checking}>
      <fieldset className="desktop-runtime-setup-fields" disabled={!editable}>
        <div className="desktop-runtime-setup-path"><label htmlFor={`${id}-wsl`}>WSL 실행파일 경로</label>
          <input id={`${id}-wsl`} value={wslExecutable} onChange={event => setWslExecutable(event.target.value)} required maxLength={4000}
            placeholder="예: C:\Windows\System32\wsl.exe" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-wsl-hint`} />
          <p id={`${id}-wsl-hint`}>사용할 wsl.exe의 전체 Windows 경로입니다.</p></div>
        <div><label htmlFor={`${id}-distro`}>WSL 배포판 이름</label>
          <input id={`${id}-distro`} value={distro} onChange={event => setDistro(event.target.value)} required maxLength={64}
            placeholder="예: Ubuntu-22.04" autoComplete="off" autoCapitalize="none" spellCheck={false} /></div>
        <div><label htmlFor={`${id}-model`}>모델 ID</label>
          <input id={`${id}-model`} value={model} onChange={event => setModel(event.target.value)} required maxLength={100}
            placeholder="예: gpt-6-astra" autoComplete="off" autoCapitalize="none" spellCheck={false} /></div>
        {status.imageInstallAvailable ? <p className="desktop-runtime-setup-install-note">지정한 Docker에 없는 실행 이미지를 다운로드하거나 설치합니다. 이미 설치된 버전은 재사용합니다.</p> : null}
        <div className="desktop-runtime-setup-save"><button className="button" type="submit" value="configure" disabled={!editable || !hasInput}>
          <Save size={15} aria-hidden="true" />확인하고 저장</button>
          {status.imageInstallAvailable ? <button className="button primary" type="submit" value="install" disabled={!editable || !hasInput}>
            <Download size={15} aria-hidden="true" />실행 이미지 설치하고 저장</button> : null}</div>
      </fieldset>
    </form> : null}
    {status?.progress && ['installing', 'recovering'].includes(status.phase) ? <div className="desktop-runtime-setup-progress" role="status" aria-live="polite">
      <span>{{ verifying: '설치 정보 검증', checking: '이미지 확인', loading: '이미지 설치', downloading: '이미지 다운로드' }[status.progress.stage]} · {status.progress.completed}/{status.progress.total}</span>
      <progress aria-label="실행 이미지 설치 진행" max={Math.max(1, status.progress.total)} value={status.progress.total > 0 ? status.progress.completed : undefined} />
    </div> : null}
    {status && ['installing', 'checking', 'diagnosing', 'recovering', 'canceling'].includes(status.phase) || cancelPending ? <div className="desktop-runtime-setup-cancel">
      <button className="button subtle" type="button" disabled={cancelPending || status?.phase === 'canceling'} onClick={cancel}>
        {cancelPending || status?.phase === 'canceling' ? '취소 정리 중' : '실행 환경 작업 취소'}</button>
      {cancelPending || status?.phase === 'canceling' ? <p role="status">{pendingAction === 'install' || pendingAction === 'recovery/retry' || status?.recovery
        ? '진행 중인 이미지 처리가 끝나면 취소됩니다.' : '진행 중인 작업의 처리가 끝나면 취소됩니다.'}</p> : null}
    </div> : null}
    {status?.selection && (status.phase === 'configured' || status.phase === 'restartRequired') ? <dl className="desktop-runtime-setup-selection">
      <div><dt>실행 방식</dt><dd>WSL · Docker</dd></div>
      <div><dt>WSL 실행파일 경로</dt><dd>{status.selection.wslExecutable}</dd></div>
      <div><dt>WSL 배포판 이름</dt><dd>{status.selection.distro}</dd></div>
      <div><dt>모델 ID</dt><dd>{status.selection.model}</dd></div>
    </dl> : null}
    {status?.phase === 'restartRequired' ? <p className="desktop-runtime-setup-restart" role="status">앱을 닫고 다시 시작하면 적용됩니다.</p> : null}
    {status?.phase === 'configured' ? <p className="desktop-runtime-setup-note">현재 저장된 선택입니다. 이 화면에서는 기존 선택을 변경할 수 없습니다.</p> : null}
    {status?.error && ['SETUP_RUNTIME_CANCELLED', 'SETUP_RUNTIME_RECOVERY_CANCELLED'].includes(status.error.code) ? <p className="desktop-runtime-setup-note" role="status">{status.error.message}</p>
      : <ErrorNotice message={status?.error?.message ?? ''} />}
    <ErrorNotice message={saveError} />
    <ErrorNotice message={readError} />
    <p className="desktop-runtime-setup-footnote">실행 환경 저장은 계정 연결이나 실제 모델 호출의 성공을 의미하지 않습니다.</p>
  </section>;
}

export function DesktopRuntimeSetupView() {
  const setup = useRuntimeSetup();
  return <DesktopRuntimeSetupPanel {...setup} />;
}
