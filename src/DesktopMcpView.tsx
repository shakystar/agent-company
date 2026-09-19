import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Copy, Link2, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { Workspace } from '../shared/types';
import type { DesktopMcpConfiguration, DesktopMcpCreated, DesktopMcpCreateInput, DesktopMcpGrant, DesktopMcpStatus } from '../shared/desktop-mcp';
import { request } from './api';
import { DateLabel, ErrorNotice, SectionTitle } from './ui';

type Session = { disposed: boolean; pending: boolean; reading: number | null; sequence: number; controllers: Set<AbortController> };
function useDesktopMcp() {
  const [status, setStatus] = useState<DesktopMcpStatus | null>(null), latest = useRef<DesktopMcpStatus | null>(null);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const [configuration, setConfiguration] = useState<DesktopMcpConfiguration | null>(null);
  const current = useRef<Session | null>(null);
  const accept = useCallback((session: Session, next: DesktopMcpStatus) => {
    if (session.disposed || current.current !== session) return;
    if (!next.available || latest.current && latest.current.generationKey !== next.generationKey) setConfiguration(null);
    latest.current = next; setStatus(next); setReadFailed(false);
  }, []);
  const refresh = useCallback(async () => {
    const session = current.current;
    if (!session || session.disposed || session.pending || session.reading) return;
    const sequence = ++session.sequence; session.reading = sequence;
    const controller = new AbortController(); session.controllers.add(controller);
    try {
      const next = await request<DesktopMcpStatus>('/desktop/mcp', 'GET', undefined, controller.signal);
      if (sequence === session.sequence) accept(session, next);
    } catch {
      if (!session.disposed && current.current === session && sequence === session.sequence) {
        setReadFailed(true); setConfiguration(null); setError('로컬 MCP 연결 상태를 확인하지 못했습니다. 다시 조회할 수 있습니다.');
      }
    } finally {
      session.controllers.delete(controller); if (session.reading === sequence) session.reading = null;
      if (!session.disposed && current.current === session) setLoading(false);
    }
  }, [accept]);
  useEffect(() => {
    const session: Session = { disposed: false, pending: false, reading: null, sequence: 0, controllers: new Set() };
    current.current = session; setConfiguration(null);
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (document.visibilityState === 'visible') await refresh(); if (!session.disposed) timer = setTimeout(poll, 4000); };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void poll(); document.addEventListener('visibilitychange', visible);
    return () => {
      session.disposed = true; clearTimeout(timer); for (const controller of session.controllers) controller.abort();
      document.removeEventListener('visibilitychange', visible); if (current.current === session) current.current = null;
    };
  }, [refresh]);
  const mutate = useCallback(async (path: string, body: unknown, create: boolean, grantId?: string) => {
    const session = current.current, state = latest.current;
    if (!session || session.disposed || session.pending || !state || (create ? !state.available : !state.grants.some(grant =>
      grant.id === grantId && !grant.revokedAt && (state.available || grant.generationKey !== state.generationKey)))) return;
    session.pending = true; ++session.sequence; setPending(true); setError(''); setConfiguration(null);
    // Invalidate and abort an older read so a conflict can always issue a fresh GET.
    for (const active of session.controllers) active.abort(); session.reading = null;
    const controller = new AbortController(); session.controllers.add(controller);
    let failed = false;
    try {
      const result = await request<DesktopMcpCreated | DesktopMcpStatus>(path, 'POST', body, controller.signal);
      if (!session.disposed && current.current === session) {
        if (create) { const created = result as DesktopMcpCreated; accept(session, created.status); setConfiguration(created.configuration); }
        else accept(session, result as DesktopMcpStatus);
      }
    } catch {
      if (!session.disposed && current.current === session) failed = true;
    } finally {
      session.controllers.delete(controller); session.pending = false;
      if (!session.disposed && current.current === session) {
        setPending(false);
        if (failed) { setError('변경을 완료하지 못했습니다. 최신 연결 상태를 다시 조회했습니다.'); await refresh(); }
      }
    }
  }, [accept, refresh]);
  return { status, loading, pending, error, readFailed, configuration, refresh: () => { setError(''); void refresh(); },
    create: (input: Omit<DesktopMcpCreateInput, 'revision'>) => {
      if (latest.current && !readFailed) void mutate('/desktop/mcp/grants', { ...input, revision: latest.current.revision }, true);
    },
    revoke: (id: string) => {
      if (latest.current && !readFailed) void mutate(`/desktop/mcp/grants/${encodeURIComponent(id)}/revoke`, { revision: latest.current.revision }, false, id);
    }, clearConfiguration: () => setConfiguration(null) };
}

export function DesktopMcpGrantForm({ workspace, disabled, onCreate }: {
  workspace: Workspace; disabled: boolean; onCreate: (input: Omit<DesktopMcpCreateInput, 'revision'>) => void;
}) {
  const id = useId(), [label, setLabel] = useState(''), [scopeType, setScopeType] = useState<'team' | 'project'>('team');
  const [scopeId, setScopeId] = useState(''), [submitTasks, setSubmitTasks] = useState(false), [budgetTeamId, setBudgetTeamId] = useState('');
  const choices = scopeType === 'team' ? workspace.teams : workspace.projects ?? [];
  const selected = choices.some(item => item.id === scopeId);
  const project = scopeType === 'project' ? workspace.projects?.find(item => item.id === scopeId) : undefined;
  const projectTeams = workspace.teams.filter(team => project?.teamIds.includes(team.id));
  const budgetValid = scopeType === 'team' || !submitTasks || projectTeams.some(team => team.id === budgetTeamId);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (disabled || !label.trim() || !selected || !budgetValid) return;
    onCreate({ label: label.trim(), scope: { type: scopeType, id: scopeId }, submitTasks,
      budgetTeamId: scopeType === 'team' ? scopeId : submitTasks ? budgetTeamId : null });
  };
  return <form onSubmit={submit} autoComplete="off">
    <fieldset disabled={disabled} className="desktop-mcp-fields"><legend>새 연결 권한</legend>
      <div className="desktop-mcp-full"><label htmlFor={`${id}-label`}>연결 이름</label><input id={`${id}-label`} required maxLength={100} value={label}
        onChange={event => setLabel(event.target.value)} placeholder="이 연결을 구분할 이름" /></div>
      <div><label htmlFor={`${id}-type`}>공유 범위</label><select id={`${id}-type`} value={scopeType} onChange={event => {
        setScopeType(event.target.value as 'team' | 'project'); setScopeId(''); setBudgetTeamId(''); setSubmitTasks(false);
      }}><option value="team">팀</option><option value="project">프로젝트</option></select></div>
      <div><label htmlFor={`${id}-scope`}>{scopeType === 'team' ? '공유할 팀' : '공유할 프로젝트'}</label>
        <select id={`${id}-scope`} required value={scopeId} onChange={event => { setScopeId(event.target.value); setBudgetTeamId(''); setSubmitTasks(false); }}>
          <option value="">직접 선택</option>{choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>{choices.length === 0 ? <p>선택할 {scopeType === 'team' ? '팀' : '프로젝트'}이 없습니다.</p> : null}</div>
      <label className="desktop-mcp-checkbox desktop-mcp-full"><input type="checkbox" checked={submitTasks} onChange={event => { setSubmitTasks(event.target.checked); setBudgetTeamId(''); }} />
        <span>과제 등록 허용<small>선택하지 않으면 읽기 전용으로 연결합니다.</small><small>등록한 과제는 팀의 기존 자동 실행 설정을 따릅니다.</small></span></label>
      {scopeType === 'project' && submitTasks ? <div className="desktop-mcp-full"><label htmlFor={`${id}-budget`}>과제 예산을 사용할 팀</label>
        <select id={`${id}-budget`} value={budgetTeamId} required onChange={event => setBudgetTeamId(event.target.value)}>
          <option value="">프로젝트 참여 팀 직접 선택</option>{projectTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select>{projectTeams.length === 0 ? <p>이 프로젝트에는 선택할 참여 팀이 없습니다.</p> : null}</div> : null}
      <div className="desktop-mcp-actions desktop-mcp-full"><button type="submit" className="button primary" disabled={disabled || !label.trim() || !selected || !budgetValid}>
        <Link2 size={15} aria-hidden="true" />연결 설정 생성</button></div>
    </fieldset>
  </form>;
}

function scopeName(grant: DesktopMcpGrant, workspace: Workspace) {
  const items = grant.scope.type === 'team' ? workspace.teams : workspace.projects ?? [];
  return `${grant.scope.type === 'team' ? '팀' : '프로젝트'} · ${items.find(item => item.id === grant.scope.id)?.name ?? '현재 작업실에 없는 범위'}`;
}
function Configuration({ value, onClose }: { value: DesktopMcpConfiguration; onClose: () => void }) {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false), [copying, setCopying] = useState(false);
  const alive = useRef(true), lock = useRef(false), id = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const copy = async () => {
    if (lock.current) return; lock.current = true; setCopying(true); setCopyError(false);
    try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); if (alive.current) setCopied(true); }
    catch { if (alive.current) setCopyError(true); }
    finally { lock.current = false; if (alive.current) setCopying(false); }
  };
  return <div className="desktop-mcp-configuration" role="region" aria-labelledby={`${id}-title`}>
    <div className="desktop-mcp-config-heading"><h3 id={`${id}-title`}>생성된 연결 설정</h3><button type="button" className="icon-button" onClick={onClose} aria-label="연결 설정 닫기"><X size={18} /></button></div>
    <p>이 설정은 한 번만 표시합니다. 닫으면 다시 조회할 수 없습니다.</p>
    <p>연결 비밀값이 포함됩니다. 사용하는 도구의 MCP 설정에 등록합니다.</p>
    <label className="sr-only" htmlFor={`${id}-value`}>MCP 연결 설정 JSON</label>
    <textarea id={`${id}-value`} readOnly value={JSON.stringify(value, null, 2)} spellCheck={false} autoComplete="off" rows={10} />
    <div className="desktop-mcp-actions"><button type="button" className="button" disabled={copying} onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{copied ? '복사 완료' : '연결 설정 복사'}</button></div>
    <span role="status" aria-live="polite">{copied ? '연결 설정을 복사했습니다.' : ''}</span>
    <ErrorNotice message={copyError ? '복사하지 못했습니다. 연결 설정을 직접 선택해 복사할 수 있습니다.' : ''} />
  </div>;
}

export function DesktopMcpPanel({ workspace, status, loading = false, pending = false, readFailed = false, error = '', configuration = null,
  refresh, create, revoke, clearConfiguration }: { workspace: Workspace; status: DesktopMcpStatus | null; loading?: boolean; pending?: boolean;
    readFailed?: boolean; error?: string; configuration?: DesktopMcpConfiguration | null; refresh: () => void;
    create: (input: Omit<DesktopMcpCreateInput, 'revision'>) => void; revoke: (id: string) => void; clearConfiguration: () => void }) {
  const available = !!status?.available && !readFailed;
  const restored = !!status && !status.available && status.grants.some(grant => grant.generationKey !== status.generationKey);
  return <section className="panel desktop-mcp-panel" aria-label="로컬 MCP 연결" aria-busy={pending || loading}>
    <SectionTitle title="로컬 MCP 연결" detail="외부 도구에 선택한 팀 또는 프로젝트의 공유 내용을 연결합니다."
      action={<button type="button" className="button subtle" disabled={pending || loading} onClick={refresh}><RefreshCw size={14} aria-hidden="true" />연결 상태 다시 조회</button>} />
    <p className="desktop-mcp-note">대표 승인·계정 설정·멤버 변경 권한은 제공하지 않습니다.</p>
    <p className="desktop-mcp-note">앱이 실행 중일 때 연결할 수 있습니다.</p>
    {loading ? <p className="desktop-mcp-state" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />연결 상태를 확인하고 있습니다.</p> : null}
    {!loading && !available ? <ErrorNotice message="로컬 MCP 연결을 사용할 수 없습니다. 상태를 다시 조회할 수 있습니다." /> : null}
    {restored ? <p className="desktop-mcp-note" role="status">작업실 복원 후 새 연결을 만들려면 앱을 다시 시작해야 합니다.</p> : null}
    <ErrorNotice message={error} />
    {configuration && available ? <Configuration value={configuration} onClose={clearConfiguration} /> : null}
    <DesktopMcpGrantForm workspace={workspace} disabled={!available || pending || !!configuration} onCreate={create} />
    <h3 className="desktop-mcp-list-title">등록된 연결</h3>
    {status && status.grants.length === 0 ? <p className="desktop-mcp-note">등록된 연결이 없습니다.</p> : null}
    <ul className="desktop-mcp-grants">{status?.grants.map(grant => {
      const oldGeneration = grant.generationKey !== status.generationKey;
      return <li key={grant.id}><div className="desktop-mcp-grant-detail"><strong>{grant.label}</strong><span>{scopeName(grant, workspace)}</span>
        <span>{grant.submitTasks ? '읽기 및 과제 등록' : '읽기 전용'}{grant.submitTasks && grant.budgetTeamId
          ? ` · 예산 팀: ${workspace.teams.find(team => team.id === grant.budgetTeamId)?.name ?? '현재 작업실에 없는 팀'}` : ''}</span>
        <small>생성 <DateLabel value={grant.createdAt} /> · {grant.revokedAt ? '회수됨' : oldGeneration ? '복원 이전 연결 · 사용 불가' : available ? '사용 가능' : '상태 확인 불가'}</small></div>
        <button type="button" className="button subtle" disabled={readFailed || pending || !!grant.revokedAt || (!available && !oldGeneration)} onClick={() => revoke(grant.id)} aria-label={`${grant.label} 연결 회수`}>회수</button>
      </li>;
    })}</ul>
  </section>;
}

export function DesktopMcpView({ workspace }: { workspace: Workspace }) {
  const connection = useDesktopMcp();
  return <DesktopMcpPanel workspace={workspace} {...connection} />;
}
