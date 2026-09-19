import { useEffect, useId, useState } from 'react';
import { Clock3, Gauge, Pencil, Save } from 'lucide-react';
import type { Run, Workspace } from '../shared/types';
import type { ConversationScope } from '../shared/conversations';
import type { OperationalBudgetStatus } from '../shared/operational-budget';
import { request, useAction } from './api';
import { Empty, ErrorNotice, Field, SectionTitle, Status } from './ui';

export interface ModelBudgetDraft { expectedRevision: number; dailyLimit: string; projectDailyLimits: Record<string, string>;
  teamDailyLimits?: Record<string, string>; agentDailyLimits?: Record<string, string> }
const storageKey = 'operational-budget-draft:v1';
const draftLimits = (limits: Record<string, number | null>) => Object.fromEntries(Object.entries(limits).map(([id, limit]) => [id, limit === null ? '' : String(limit)]));
export function modelBudgetDraft(status: OperationalBudgetStatus): ModelBudgetDraft {
  return { expectedRevision: status.revision, dailyLimit: String(status.dailyLimit),
    projectDailyLimits: draftLimits(status.projectDailyLimits),
    ...(status.teamDailyLimits ? { teamDailyLimits: draftLimits(status.teamDailyLimits) } : {}),
    ...(status.agentDailyLimits ? { agentDailyLimits: draftLimits(status.agentDailyLimits) } : {}) };
}
function count(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label}은 0부터 1,000,000까지의 정수입니다.`);
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000) throw new Error(`${label}은 0부터 1,000,000까지의 정수입니다.`);
  return parsed;
}
export function parseModelBudgetDraft(draft: ModelBudgetDraft) {
  const parseLimits = (limits: Record<string, string>, label: string) => Object.fromEntries(Object.entries(limits).map(([id, limit]) =>
    [id, limit.trim() === '' ? null : count(limit, `${label} 일일 상한`)]));
  return { expectedRevision: draft.expectedRevision, dailyLimit: count(draft.dailyLimit, '전체 일일 상한'),
    projectDailyLimits: parseLimits(draft.projectDailyLimits, '프로젝트'),
    ...(draft.teamDailyLimits ? { teamDailyLimits: parseLimits(draft.teamDailyLimits, '팀') } : {}),
    ...(draft.agentDailyLimits ? { agentDailyLimits: parseLimits(draft.agentDailyLimits, '에이전트') } : {}) };
}
function readSavedDraft(): { draft: ModelBudgetDraft; error: string } | null {
  try {
    if (typeof window === 'undefined') return null;
    const value: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null');
    if (!value || typeof value !== 'object' || !('draft' in value) || !value.draft || typeof value.draft !== 'object') return null;
    const draft = value.draft as ModelBudgetDraft;
    if (!Number.isSafeInteger(draft.expectedRevision) || typeof draft.dailyLimit !== 'string' || !draft.projectDailyLimits
      || typeof draft.projectDailyLimits !== 'object' || Array.isArray(draft.projectDailyLimits)
      || !Object.values(draft.projectDailyLimits).every(limit => typeof limit === 'string')) return null;
    for (const limits of [draft.teamDailyLimits, draft.agentDailyLimits]) {
      if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits)
        || !Object.values(limits).every(limit => typeof limit === 'string'))) return null;
    }
    return { draft, error: 'error' in value && typeof value.error === 'string' ? value.error : '' };
  } catch { return null; }
}
function removeSavedDraft() { try { window.sessionStorage.removeItem(storageKey); } catch { /* In-memory state still works when storage is unavailable. */ } }
const projectName = (workspace: Workspace, id: string | null) => id === null ? '프로젝트 없는 개인 작업' : workspace.projects?.find(project => project.id === id)?.name ?? `이전 프로젝트 · ${id}`;
export const budgetTeamLabel = (workspace: Workspace, id: string | null | undefined) => id === undefined ? '팀 귀속 미기록' : id === null ? '팀 없는 개인 작업' : workspace.teams.find(team => team.id === id)?.name ?? `이전 팀 · ${id}`;
const budgetAgentName = (workspace: Workspace, id: string) => workspace.agents.find(agent => agent.id === id)?.name ?? `이전 에이전트 · ${id}`;
const budgetScopeLabel = (scope: 'global' | 'project' | 'team' | 'agent') => ({ global: '전체', project: '프로젝트', team: '팀', agent: '에이전트' })[scope];
export function budgetResetLabel(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

export function ModelBudgetSummary({ workspace }: { workspace: Workspace }) {
  const budget = workspace.modelBudget;
  return budget ? <a className="model-budget-summary" href="#settings"><Gauge size={15} /><span>오늘 모델 시작 <strong>{budget.used.toLocaleString()} / {budget.dailyLimit.toLocaleString()}회</strong></span>
    <span>잔여 {budget.remaining.toLocaleString()}회{budget.waiting.length ? ` · 예산 대기 ${budget.waiting.length}건` : ''}</span></a> : null;
}

export function ModelBudgetView({ workspace, refresh }: { workspace: Workspace; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(() => !!readSavedDraft());
  const budget = workspace.modelBudget;
  return <section className="panel model-budget-panel" aria-label="운영 모델 예산"><SectionTitle title="모델 시작 한도" detail="전체·프로젝트·팀·에이전트의 일일 사용량을 함께 관리합니다."
    action={<button className="button" disabled={!budget || editing} onClick={() => setEditing(true)}><Pencil size={14} />상한 변경</button>} />
    {!budget ? <Empty icon={<Gauge size={24} />} title="운영 한도 정보를 확인하지 못했습니다" detail="확인되지 않은 사용량을 0회나 무제한으로 표시하지 않습니다." /> : <>
      <p className="model-budget-day">{budget.date} · 한국시간 기준 · 다음 갱신 {budgetResetLabel(budget.resetAt)}</p>
      <dl className="model-budget-totals"><div><dt>전체 일일 상한</dt><dd>{budget.dailyLimit.toLocaleString()}<small>회</small></dd></div>
        <div><dt>오늘 모델 시작</dt><dd>{budget.used.toLocaleString()}<small>회</small></dd></div><div><dt>남은 모델 시작</dt><dd>{budget.remaining.toLocaleString()}<small>회</small></dd></div></dl>
      <p className="inline-note">상담·작업·평가·재수정·재시도·재개의 모델 시작을 합산합니다. 명령 도구 호출 횟수나 토큰 상한이 아닙니다. 시간·토큰 관측은 품질 점수로 사용하지 않습니다.</p>
      <div className="model-budget-table-wrap" tabIndex={0} aria-label="프로젝트별 예산 표 가로 스크롤"><table className="model-budget-table"><caption>프로젝트별 오늘 사용량</caption><thead><tr><th scope="col">프로젝트</th><th scope="col">일일 상한</th><th scope="col">사용</th><th scope="col">프로젝트 잔여</th></tr></thead>
        <tbody>{budget.projects.map(project => <tr key={project.projectId}><th scope="row">{projectName(workspace, project.projectId)}</th>
          <td>{project.limit === null ? '별도 제한 없음' : `${project.limit.toLocaleString()}회`}</td><td>{project.used.toLocaleString()}회</td>
          <td>{project.remaining === null ? '전체 잔여 한도 내' : `${project.remaining.toLocaleString()}회`}</td></tr>)}
          {!budget.projects.length ? <tr><td colSpan={4}>등록된 프로젝트 예산이 없습니다.</td></tr> : null}</tbody></table></div>
      <p className="inline-note">프로젝트 상한은 예약량이 아닙니다. 별도 제한이 없어도 전체 한도를 함께 적용합니다. 프로젝트 없는 개인 작업도 전체 사용량에 포함합니다.</p>
      <ScopeBudgetTable label="팀" rows={budget.teams?.map(team => ({ ...team, id: team.teamId, name: budgetTeamLabel(workspace, team.teamId) }))} legacy={budget.legacyUnattributed?.team} />
      <ScopeBudgetTable label="에이전트" rows={budget.agents?.map(agent => ({ ...agent, id: agent.agentId, name: budgetAgentName(workspace, agent.agentId) }))} legacy={budget.legacyUnattributed?.agent} />
      <p className="inline-note">한 번의 모델 시작에 전체·원래 프로젝트·원래 팀 한도와 실제 실행 에이전트 한도를 함께 적용합니다. 여러 팀에 소속되어도 원래 과제의 한 팀에만 기록합니다. 범위별 사용량은 서로 겹치므로 합산하지 않습니다.</p>
      {editing ? <ModelBudgetEditor workspace={workspace} status={budget} onSaved={async () => { await refresh(); setEditing(false); }} onClose={() => setEditing(false)} /> : null}
      <section className="model-budget-waiting" aria-label="모델 예산 대기 작업"><h3>예산 대기 <span>{budget.waiting.length}건</span></h3>
        {budget.waiting.length ? <ul>{budget.waiting.map(waiting => { const run = workspace.runs.find(item => item.id === waiting.runId);
          const title = workspace.conversationMessages?.find(message => message.id === run?.conversationMessageId)?.content ?? run?.prompt ?? waiting.runId;
          return <li key={waiting.runId}><div><strong>{projectName(workspace, waiting.projectId)}</strong><span className="tag tag-amber">{budgetScopeLabel(waiting.blockedBy)} 한도 소진</span>{run ? <Status status={run.status} /> : null}</div>
            <p>{title.slice(0, 200)}</p><p>{budgetTeamLabel(workspace, waiting.teamId)}{waiting.agentId ? ` · 실행 에이전트 ${budgetAgentName(workspace, waiting.agentId)}` : ''}</p><p>{waiting.reason}</p>
            {!run || isCurrentBudgetWait(run) ? <small><Clock3 size={12} />한국시간 {budgetResetLabel(waiting.resetAt)} 이후 새 한도에서 자동 재개</small> : null}
            {run?.conversationId ? <a href={`#conversation/${encodeURIComponent(run.conversationId)}`}>연결 대화 열기</a> : null}</li>;
        })}</ul> : <p className="inline-note">현재 예산 때문에 대기하는 작업이 없습니다.</p>}
        <p className="inline-note">사용 이력은 초기화하지 않습니다. 한도 소진 시 진행 중 호출은 마치고 다음 시작부터 대기합니다. 사용자의 일시정지·취소는 자동 해제하지 않습니다.</p>
      </section>
    </>}
  </section>;
}

function ScopeBudgetTable({ label, rows, legacy }: { label: string; rows?: Array<{ id: string; name: string; limit: number | null; used: number; remaining: number | null }>; legacy?: number }) {
  return <section aria-label={`${label}별 모델 한도`}>
    {rows === undefined ? <p className="inline-note">{label}별 한도·사용량은 현재 서버에서 확인되지 않았습니다.</p> : <>
      <div className="model-budget-table-wrap" tabIndex={0} aria-label={`${label}별 예산 표 가로 스크롤`}><table className="model-budget-table"><caption>{label}별 오늘 사용량</caption><thead><tr><th scope="col">{label}</th><th scope="col">일일 상한</th><th scope="col">사용</th><th scope="col">{label} 잔여</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{row.limit === null ? '별도 제한 없음' : `${row.limit.toLocaleString()}회`}</td>
          <td>{row.used.toLocaleString()}회</td><td>{row.remaining === null ? '다른 범위 잔여 한도 내' : `${row.remaining.toLocaleString()}회`}</td></tr>)}
          {!rows.length ? <tr><td colSpan={4}>등록된 {label} 예산이 없습니다.</td></tr> : null}</tbody></table></div>
      {legacy === undefined ? <p className="inline-note">과거 {label} 귀속 미기록 건수는 확인되지 않았습니다.</p> : legacy > 0 ? <p className="conversation-notice" role="status">오늘 {label} 귀속 미기록 {legacy.toLocaleString()}회가 모든 {label}의 사용량에 보수적으로 포함돼 있습니다. 확정 귀속 사용량이 아니며 한도 회피를 막기 위한 계산입니다.</p> : null}
    </>}
  </section>;
}

export function ModelBudgetEditor({ workspace, status, onSaved, onClose, initialDraft }: { workspace: Workspace; status: OperationalBudgetStatus;
  onSaved: () => Promise<void>; onClose: () => void; initialDraft?: ModelBudgetDraft }) {
  const [saved] = useState(readSavedDraft);
  const [draft, setDraft] = useState<ModelBudgetDraft>(() => {
    const current = modelBudgetDraft(status);
    const previous = initialDraft ?? saved?.draft;
    return previous ? { ...current, ...previous } : current;
  });
  const [savedError, setSavedError] = useState(initialDraft ? '' : saved?.error ?? '');
  const action = useAction();
  const prefix = useId();
  const changedElsewhere = draft.expectedRevision !== status.revision;
  const projectIds = [...new Set([...(workspace.projects ?? []).map(project => project.id), ...Object.keys(status.projectDailyLimits), ...Object.keys(draft.projectDailyLimits)])];
  const extraLimits = [
    { key: 'teamDailyLimits', label: '팀', ids: workspace.teams.map(team => team.id), name: (id: string) => budgetTeamLabel(workspace, id) },
    { key: 'agentDailyLimits', label: '에이전트', ids: workspace.agents.map(agent => agent.id), name: (id: string) => budgetAgentName(workspace, id) },
  ] as const;
  useEffect(() => {
    try { window.sessionStorage.setItem(storageKey, JSON.stringify({ draft, error: action.error || savedError })); }
    catch { /* Draft and error stay in memory even when browser storage is unavailable. */ }
  }, [draft, action.error, savedError]);
  return <form className="model-budget-editor form-stack" aria-label="모델 일일 상한 변경" onSubmit={event => { event.preventDefault(); if (changedElsewhere) return; setSavedError('');
    void action.execute(async () => { await request('/model-budget', 'PATCH', parseModelBudgetDraft(draft)); removeSavedDraft(); await onSaved(); }); }}>
    <Field label="전체 일일 상한" hint="0이면 다음 모델 시작부터 전체 작업이 대기합니다."><input inputMode="numeric" type="text" required maxLength={7}
      value={draft.dailyLimit} disabled={action.pending} onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, dailyLimit: value })); }} /></Field>
    <fieldset className="model-budget-project-fields" disabled={action.pending}><legend>프로젝트별 선택 상한</legend>{projectIds.map(id => <label key={id} htmlFor={`${prefix}-${id}`}>
      <span>{projectName(workspace, id)}</span><input id={`${prefix}-${id}`} inputMode="numeric" type="text" maxLength={7} placeholder="별도 제한 없음" value={draft.projectDailyLimits[id] ?? ''}
        onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, projectDailyLimits: { ...current.projectDailyLimits, [id]: value } })); }} />
    </label>)}{!projectIds.length ? <p className="inline-note">프로젝트를 만들면 선택 상한을 설정할 수 있습니다.</p> : null}</fieldset>
    {extraLimits.map(scope => {
      const limits = draft[scope.key];
      const ids = [...new Set([...scope.ids, ...Object.keys(status[scope.key] ?? {}), ...Object.keys(limits ?? {})])];
      return <fieldset key={scope.key} className="model-budget-project-fields" disabled={action.pending || limits === undefined}><legend>{scope.label}별 선택 상한</legend>
        {limits === undefined ? <p className="inline-note">현재 서버에서 {scope.label} 한도 설정을 확인하지 못했습니다.</p> : ids.map(id => <label key={id} htmlFor={`${prefix}-${scope.key}-${id}`}><span>{scope.name(id)}</span>
          <input id={`${prefix}-${scope.key}-${id}`} inputMode="numeric" type="text" maxLength={7} placeholder="별도 제한 없음" value={limits[id] ?? ''}
            onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, [scope.key]: { ...current[scope.key], [id]: value } })); }} /></label>)}
        {limits !== undefined && !ids.length ? <p className="inline-note">{scope.label}을 만들면 선택 상한을 설정할 수 있습니다.</p> : null}</fieldset>;
    })}
    <p className="inline-note">프로젝트 입력을 비우면 별도 제한을 해제합니다. 팀·에이전트도 같습니다. 0은 해당 범위의 신규 모델 시작을 대기시킵니다. 상한 변경은 사용량을 지우거나 진행 중 호출을 취소하지 않습니다.</p>
    {changedElsewhere ? <p className="model-budget-conflict" role="status">다른 설정 변경이 먼저 저장됐습니다. 입력 초안은 보존했으며 현재 설정을 확인한 뒤 다시 편집할 수 있습니다.</p> : null}
    <ErrorNotice message={action.error || savedError} /><div className="model-budget-editor-actions">
      <button className="button subtle" type="button" disabled={action.pending} onClick={() => { removeSavedDraft(); onClose(); }}>초안 취소</button>
      {changedElsewhere ? <button className="button" type="button" disabled={action.pending} onClick={() => { setDraft(modelBudgetDraft(status)); setSavedError(''); }}>초안 교체·최신 설정 가져오기</button> : null}
      <button className="button primary" type="submit" disabled={action.pending || changedElsewhere}><Save size={14} />{action.pending ? '저장 중' : '상한 저장'}</button></div>
  </form>;
}

export function budgetProjects(workspace: Workspace, scope: ConversationScope) {
  if (scope.type === 'project') return (workspace.projects ?? []).filter(project => project.id === scope.id);
  const teamIds = scope.type === 'team' ? [scope.id] : workspace.teams.filter(team => team.memberIds.includes(scope.id)).map(team => team.id);
  return (workspace.projects ?? []).filter(project => project.teamIds.some(id => teamIds.includes(id)));
}
export function BudgetProjectSelect({ workspace, scope, value, onChange, disabled }: { workspace: Workspace; scope: ConversationScope; value: string;
  onChange: (value: string) => void; disabled?: boolean }) {
  const projects = budgetProjects(workspace, scope);
  if (scope.type === 'project') return <p className="inline-note">예산 귀속 · {projectName(workspace, scope.id)} · 이 프로젝트로 고정됩니다.</p>;
  return <Field label="예산 귀속" hint="후속 협업·성장·재시도는 이 프로젝트의 사용량에 함께 기록합니다."><select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">프로젝트 없는 작업 · 전체·팀·실행 에이전트 한도 적용</option>
    {value && !projects.some(project => project.id === value) ? <option value={value}>현재 연결되지 않은 프로젝트</option> : null}
    {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field>;
}
export function budgetTeams(workspace: Workspace, scope: ConversationScope, projectId: string | null) {
  const project = workspace.projects?.find(item => item.id === (scope.type === 'project' ? scope.id : projectId));
  return workspace.teams.filter(team => (scope.type === 'team' ? team.id === scope.id : scope.type === 'agent' ? team.memberIds.includes(scope.id) : true)
    && (!(projectId || scope.type === 'project') || !!project?.teamIds.includes(team.id)));
}
export function budgetTeamSelection(workspace: Workspace, scope: ConversationScope, projectId: string | null, value: string): string | null | undefined {
  const teams = budgetTeams(workspace, scope, projectId);
  if (scope.type === 'team') return teams.some(team => team.id === scope.id) ? scope.id : undefined;
  if (value) return value === 'none' ? scope.type === 'agent' && !projectId ? null : undefined : teams.some(team => team.id === value) ? value : undefined;
  if (teams.length === 1) return teams[0].id;
  return teams.length === 0 && scope.type === 'agent' && !projectId ? null : undefined;
}
export function BudgetTeamSelect({ workspace, scope, projectId, value, onChange, disabled }: { workspace: Workspace; scope: ConversationScope; projectId: string | null;
  value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const teams = budgetTeams(workspace, scope, projectId);
  const selected = budgetTeamSelection(workspace, scope, projectId, value);
  const personal = scope.type === 'agent' && !projectId;
  if (scope.type === 'team' || teams.length === 1 && !value && !personal) return <p className="inline-note">팀 귀속 · {budgetTeamLabel(workspace, selected)} · 원래 과제의 한 팀으로 고정됩니다.</p>;
  if (!teams.length && selected === null) return <p className="inline-note">팀 귀속 · 팀 없는 개인 작업 · 전체·실행 에이전트 한도를 적용합니다.</p>;
  return <Field label="팀 예산 귀속" hint="원래 과제의 한 팀을 선택합니다. 여러 소속 팀에 중복 차감하지 않으며, 실행 에이전트 한도는 별도로 적용합니다."><select required value={value || (teams.length === 1 ? teams[0].id : '')} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">팀 선택</option>{personal ? <option value="none">팀 없는 개인 작업</option> : null}
    {value && selected === undefined ? <option value={value}>현재 연결되지 않은 팀 · 다시 선택</option> : null}
    {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select>
    {selected === undefined ? <span className="inline-note">현재 연결된 팀 선택이 필요합니다.</span> : null}</Field>;
}
export function isCurrentBudgetWait(run: Run): boolean {
  return !!run.modelBudgetPaused && ['queued', 'starting', 'running', 'waiting'].includes(run.status) && !run.pauseRequestedAt;
}
export function RunBudgetNotice({ run, workspace }: { run: Run; workspace: Workspace }) {
  const budget = workspace.modelBudget;
  const budgetWaiting = isCurrentBudgetWait(run);
  const waiting = budgetWaiting ? budget?.waiting.find(item => item.runId === run.id) ?? run.modelBudgetBlock : null;
  return <div className="run-budget-notice"><span>예산 귀속 · {run.budgetProjectId === undefined ? '이전 작업 · 미기록' : projectName(workspace, run.budgetProjectId)} · {budgetTeamLabel(workspace, run.budgetTeamId)} · 실행 에이전트 {budgetAgentName(workspace, run.agentId)}</span>
    {waiting ? <p role="status">{budgetScopeLabel(waiting.blockedBy)} 일일 한도 소진 · {waiting.reason}<br />한국시간 {budgetResetLabel(waiting.resetAt)} 이후 새 한도에서 자동 재개합니다.</p>
      : budgetWaiting ? <p role="status">모델 실행 예산 대기 · {run.error || '진행 상태를 보존합니다.'}</p> : null}
    {budgetWaiting ? <a href="#settings">모델 한도 확인·변경</a> : null}</div>;
}
