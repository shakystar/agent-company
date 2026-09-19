import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, CircleAlert, Copy, KeyRound, LoaderCircle, LogOut, RefreshCw } from 'lucide-react';
import type { DesktopSetupLoginInput, DesktopSetupPhase, DesktopSetupStatus } from '../shared/desktop-setup';
import { request } from './api';
import { ErrorNotice, SectionTitle } from './ui';

const activePhases = new Set<DesktopSetupPhase>(['checking', 'starting', 'awaiting', 'canceling', 'disconnecting', 'closing']);
const loginPhases = new Set<DesktopSetupPhase>(['unchecked', 'disconnected', 'failed']);
const phaseLabels: Record<DesktopSetupPhase, string> = {
  unavailable: '계정 연결 사용 불가', unchecked: '연결 상태 확인 전', checking: '계정 확인 중',
  disconnected: '연결된 계정 없음', starting: '로그인 시작 중', awaiting: '브라우저 로그인 대기',
  connected: '계정 연결됨', canceling: '로그인 취소 중', disconnecting: '계정 연결 해제 중',
  failed: '계정 연결 확인 필요', closing: '계정 연결 종료 중',
};

type SetupChange = { operation: 'check' | 'logout' }
  | { operation: 'login'; input: Omit<Extract<DesktopSetupLoginInput, { method: 'chatgptDeviceCode' }>, 'revision'>
    | Omit<Extract<DesktopSetupLoginInput, { method: 'apiKey' }>, 'revision'> }
  | { operation: 'cancel'; attemptId: string };
type SetupSession = {
  disposed: boolean;
  mutating: boolean;
  controllers: Set<AbortController>;
  read?: Promise<void>;
  refreshSoon: () => void;
};

function useDesktopSetup() {
  const [status, setStatus] = useState<DesktopSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const latest = useRef<DesktopSetupStatus | null>(null);
  const sessionRef = useRef<SetupSession | null>(null);

  const accept = useCallback((session: SetupSession, next: DesktopSetupStatus) => {
    if (session.disposed || sessionRef.current !== session || (latest.current && next.revision < latest.current.revision)) return;
    latest.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    if (!session || session.disposed) return Promise.resolve();
    if (session.read) return session.read;
    const controller = new AbortController();
    session.controllers.add(controller);
    const reading = request<DesktopSetupStatus>('/desktop/setup', 'GET', undefined, controller.signal)
      .then(next => {
        if (session.disposed || sessionRef.current !== session) return;
        accept(session, next);
        setReadError('');
      }).catch(failure => {
        if (!session.disposed && sessionRef.current === session && !controller.signal.aborted) {
          setReadError(failure instanceof Error ? failure.message : '계정 연결 상태를 확인하지 못했습니다.');
        }
      }).finally(() => {
        session.controllers.delete(controller);
        if (session.read === reading) session.read = undefined;
        if (!session.disposed && sessionRef.current === session) setLoading(false);
      });
    session.read = reading;
    return reading;
  }, [accept]);

  useEffect(() => {
    const session: SetupSession = { disposed: false, mutating: false, controllers: new Set(), refreshSoon: () => undefined };
    sessionRef.current = session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!session.disposed && document.visibilityState === 'visible') timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (session.disposed || document.visibilityState !== 'visible') return;
      await refresh();
      schedule(session.mutating || (latest.current && activePhases.has(latest.current.phase)) ? 1000 : 4000);
    };
    session.refreshSoon = () => schedule(0);
    const visibilityChanged = () => { clearTimeout(timer); if (document.visibilityState === 'visible') session.refreshSoon(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    session.refreshSoon();
    return () => {
      session.disposed = true;
      clearTimeout(timer);
      for (const controller of session.controllers) controller.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [refresh]);

  const change = useCallback(async (change: SetupChange) => {
    const session = sessionRef.current, current = latest.current;
    if (!session || session.disposed || session.mutating || !current || !current.provider.available) return;
    const canLogin = loginPhases.has(current.phase);
    if (change.operation === 'login' && !canLogin) return;
    if (change.operation === 'cancel' && (current.phase !== 'awaiting' || current.login?.attemptId !== change.attemptId)) return;
    if ((change.operation === 'check' || change.operation === 'logout') && !canLogin && current.phase !== 'connected') return;
    session.mutating = true;
    setPending(true);
    setActionError('');
    const controller = new AbortController();
    session.controllers.add(controller);
    const body = { revision: current.revision, ...(change.operation === 'login' ? change.input
      : change.operation === 'cancel' ? { attemptId: change.attemptId } : {}) };
    try {
      const response = request<DesktopSetupStatus>(`/desktop/setup/${change.operation}`, 'POST', body, controller.signal);
      session.refreshSoon();
      accept(session, await response);
    } catch (failure) {
      if (!session.disposed && sessionRef.current === session && !controller.signal.aborted) {
        setActionError(failure instanceof Error ? failure.message : '계정 연결을 처리하지 못했습니다.');
      }
    } finally {
      session.controllers.delete(controller);
      session.mutating = false;
      if (!session.disposed && sessionRef.current === session) {
        setPending(false);
        session.refreshSoon();
      }
    }
  }, [accept]);

  return { status, loading, pending, readError, actionError, refresh, change };
}

function CopyField({ label, value, buttonLabel, code = false }: { label: string; value: string; buttonLabel: string; code?: boolean }) {
  const id = useId();
  const lifetime = useRef<AbortController | null>(null);
  const copying = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ value: string; message: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); };
  }, []);
  const copy = async () => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || copying.current) return;
    copying.current = true; setBusy(true); setNotice(null);
    try {
      await navigator.clipboard.writeText(value);
      if (!controller.signal.aborted) setNotice({ value, message: '복사했습니다.' });
    } catch {
      if (!controller.signal.aborted) setNotice({ value, message: '복사하지 못했습니다. 표시된 값을 선택해 복사할 수 있습니다.' });
    } finally {
      copying.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <div className="desktop-setup-copy-field">
    <label htmlFor={id}>{label}</label>
    <div><input id={id} className={code ? 'desktop-setup-code' : undefined} value={value} readOnly spellCheck={false} autoComplete="off" />
      <button className="button" type="button" disabled={busy} onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{buttonLabel}</button></div>
    <span className="desktop-setup-copy-notice" role="status">{notice?.value === value ? notice.message : ''}</span>
  </div>;
}

export function DesktopSetupView() {
  const { status, loading, pending, readError, actionError, refresh, change } = useDesktopSetup();
  const [apiKey, setApiKey] = useState('');
  const apiKeyId = useId();
  const available = !!status?.provider.available;
  const canLogin = !!status && available && loginPhases.has(status.phase);
  const active = !!status && activePhases.has(status.phase);
  const busy = pending || (active && status.phase !== 'awaiting');
  const label = status?.phase === 'connected' && status.account?.type === 'apiKey' ? 'API 키 저장됨'
    : status ? phaseLabels[status.phase] : loading ? '계정 연결 상태 확인 중' : '계정 연결 상태 확인 불가';
  const act = (input: SetupChange) => { const operation = change(input); setApiKey(''); void operation; };
  const submitKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canLogin || pending || !apiKey.trim()) return;
    act({ operation: 'login', input: { method: 'apiKey', apiKey: apiKey.trim() } });
  };
  useEffect(() => { if (!canLogin) setApiKey(''); }, [canLogin]);

  return <section className="panel desktop-setup-panel" aria-label="모델 계정 연결">
    <SectionTitle title="모델 계정 연결" detail="이 작업실에서 사용할 본인 계정을 연결합니다."
      action={<button className="button subtle" type="button" disabled={loading || pending} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />상태 다시 조회</button>} />
    <div className={`desktop-setup-phase desktop-setup-phase-${status?.phase ?? 'unknown'}`} role="status" aria-live="polite">
      {busy || loading ? <LoaderCircle size={18} className="spin" aria-hidden="true" />
        : status?.phase === 'connected' ? <CheckCircle2 size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
      <strong>{pending && !active ? '계정 연결 처리 중' : label}</strong>
    </div>
    {status?.phase === 'unavailable' ? <p className="desktop-setup-description">이 앱에서는 계정 연결 구성요소를 사용할 수 없습니다. 구성요소가 포함된 설치본에서 연결할 수 있습니다.</p> : null}
    {status?.phase === 'unchecked' ? <p className="desktop-setup-description">저장된 계정이 있는지 확인하거나 새 로그인을 시작할 수 있습니다.</p> : null}
    {status?.phase === 'connected' && status.account ? <div className="desktop-setup-account">
      <div><strong>{status.account.type === 'apiKey' ? 'OpenAI API 키' : 'ChatGPT'}</strong>
        {status.account.type === 'chatgpt' ? <p>{status.account.email ?? '연결된 ChatGPT 계정'}<span>{status.account.planType}</span></p>
          : <p>API 키의 유효성과 실제 모델 호출은 아직 확인하지 않았습니다.</p>}</div>
      <button className="button" type="button" disabled={pending} onClick={() => act({ operation: 'logout' })}><LogOut size={14} aria-hidden="true" />연결 해제</button>
    </div> : null}
    {status?.phase === 'awaiting' && status.login ? <div className="desktop-setup-device">
      <p className="desktop-setup-description">브라우저에서 로그인 주소를 열고 인증 코드를 입력하면 연결 상태가 자동으로 갱신됩니다.</p>
      <CopyField key={`${status.login.attemptId}-url`} label="공식 로그인 주소" value={status.login.verificationUrl} buttonLabel="주소 복사" />
      <CopyField key={`${status.login.attemptId}-code`} label="인증 코드" value={status.login.userCode} buttonLabel="코드 복사" code />
      <button className="button" type="button" disabled={pending} onClick={() => act({ operation: 'cancel', attemptId: status.login!.attemptId })}>로그인 취소</button>
    </div> : null}
    {canLogin || status?.phase === 'unavailable' ? <div className="desktop-setup-methods" aria-busy={pending}>
      <div className="desktop-setup-chatgpt"><h3>ChatGPT 계정</h3><p>본인 계정으로 브라우저에서 로그인합니다.</p>
        <button className="button primary" type="button" disabled={!canLogin || pending} onClick={() => act({ operation: 'login', input: { method: 'chatgptDeviceCode' } })}>ChatGPT 로그인</button>
        {canLogin ? <button className="button subtle" type="button" disabled={pending} onClick={() => act({ operation: 'check' })}><RefreshCw size={14} aria-hidden="true" />저장된 연결 확인</button> : null}
      </div>
      <form className="desktop-setup-key" onSubmit={submitKey} autoComplete="off"><h3>OpenAI API 키</h3><label htmlFor={apiKeyId}>API 키</label>
        <input id={apiKeyId} type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false}
          maxLength={8192} disabled={!canLogin || pending} required aria-describedby={`${apiKeyId}-hint`} />
        <p id={`${apiKeyId}-hint`}>입력한 키는 전송 후 입력란에서 지워집니다.</p>
        <button className="button" type="submit" disabled={!canLogin || pending || !apiKey.trim()}><KeyRound size={14} aria-hidden="true" />API 키 저장</button>
      </form>
    </div> : null}
    <ErrorNotice message={status?.error?.message ?? ''} />
    <ErrorNotice message={actionError} />
    <ErrorNotice message={readError} />
    <p className="desktop-setup-execution-note">{status?.executionReady
      ? '이 계정으로 작업을 시작할 수 있습니다.'
      : '계정과 실행 환경을 연결하면 작업을 시작할 수 있습니다.'}</p>
  </section>;
}
