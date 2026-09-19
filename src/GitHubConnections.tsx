import { useEffect, useRef, useState } from 'react';
import { GitBranch, Link2Off, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { Connection, Workspace } from '../shared/types';
import type { GitHubStatus, RepositoryGrant } from '../shared/repositories';
import { repositoryGrantSchema } from '../shared/repositories';
import { request, useAction } from './api';
import { DateLabel, Empty, ErrorNotice, Field, Modal, SectionTitle, Submit } from './ui';

type GrantDraft = RepositoryGrant & { rowId: string };
export interface GitHubConnectionDraft { access: 'read' | 'write'; grants: GrantDraft[] }
export function githubConnectionDraft(connection: Connection): GitHubConnectionDraft {
  return { access: connection.access, grants: (connection.grants ?? []).map((grant, index) => ({ ...grant, rowId: `saved-${index}` })) };
}
export function githubPermissionFingerprint(connection: Connection): string {
  return JSON.stringify({ version: connection.version ?? 0, access: connection.access, grants: connection.grants ?? [],
    generation: connection.github?.generation ?? null, status: connection.github?.status ?? null });
}
export function parseGitHubConnectionDraft(draft: GitHubConnectionDraft, workspace: Workspace) {
  if (!['read', 'write'].includes(draft.access) || draft.grants.length > 100) throw new Error('저장소 권한과 최대 100개 권한 행을 확인해야 합니다.');
  const seen = new Set<string>();
  const grants = draft.grants.map((row, index) => {
    const { rowId: _row, ...input } = row;
    const parsed = repositoryGrantSchema.safeParse(input);
    if (!parsed.success) throw new Error(`권한 ${index + 1}의 프로젝트·원팀·에이전트를 모두 선택해야 합니다.`);
    const grant = parsed.data;
    const project = workspace.projects?.find(item => item.id === grant.projectId);
    const team = workspace.teams.find(item => item.id === grant.teamId);
    if (!project?.teamIds.includes(grant.teamId) || !team?.memberIds.includes(grant.agentId)
      || !workspace.agents.some(item => item.id === grant.agentId)) throw new Error(`권한 ${index + 1}의 현재 프로젝트·팀 소속이 일치하지 않습니다.`);
    if (draft.access === 'read' && grant.access === 'write') throw new Error(`권한 ${index + 1}의 쓰기는 저장소 읽기 상한을 넘습니다. 작성 내용은 유지합니다.`);
    const key = `${grant.agentId}/${grant.teamId}/${grant.projectId}`;
    if (seen.has(key)) throw new Error(`권한 ${index + 1}에 같은 에이전트·원팀·프로젝트가 중복됐습니다.`);
    seen.add(key);
    return grant;
  });
  return { access: draft.access, grants };
}

export function GitHubConnections({ workspace, refresh }: { workspace: Workspace; refresh: () => Promise<void> }) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [adding, setAdding] = useState(false);
  // Keep the edit-start snapshot, not the polling object, as the draft source.
  const [editing, setEditing] = useState<Connection | null>(null);
  const statusSequence = useRef(0);
  const statusAction = useAction();
  useEffect(() => {
    const controller = new AbortController(), sequence = ++statusSequence.current;
    void request<GitHubStatus>('/github', 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted && statusSequence.current === sequence) { setStatus(value); setStatusError(''); }
    }).catch(error => {
      if (!controller.signal.aborted && statusSequence.current === sequence) setStatusError(error instanceof Error ? error.message : 'GitHub 서버 구성을 확인하지 못했습니다.');
    });
    return () => { controller.abort(); statusSequence.current++; };
  }, []);
  const refreshStatus = () => statusAction.execute(async () => {
    const sequence = ++statusSequence.current;
    const value = await request<GitHubStatus>('/github');
    if (statusSequence.current !== sequence) return;
    setStatus(value); setStatusError('');
    await refresh();
  });
  return <section className="panel connections-panel" aria-label="GitHub 저장소 연결">
    <SectionTitle title="GitHub 연결" detail="범위 등록·실제 접속 확인·에이전트 권한을 구분합니다."
      action={<div className="file-actions"><button className="button" disabled={statusAction.pending} onClick={() => void refreshStatus()}><RefreshCw size={14} />구성 새로고침</button><button className="button" onClick={() => setAdding(true)}><Plus size={14} />범위 등록</button></div>} />
    <GitHubServerStatus status={status} />
    <ErrorNotice message={statusError || statusAction.error} />
    <p className="inline-note">기본 브랜치 직접쓰기·병합·배포는 포함하지 않습니다. 권한은 명시한 프로젝트·원팀·에이전트에만 적용하며 복제본에 자동 상속하지 않습니다.</p>
    {workspace.connections.length ? <div className="form-stack">{workspace.connections.map(connection => <GitHubConnectionCard key={connection.id}
      connection={connection} workspace={workspace} status={status} refresh={refresh} onEdit={() => setEditing(structuredClone(connection))} />)}</div>
      : <Empty icon={<GitBranch size={24} />} title="등록된 저장소가 없습니다" detail="범위 등록만으로 계정 인증이나 실제 저장소 접근이 활성화되지는 않습니다." />}
    {adding ? <GitHubRegisterForm onClose={() => setAdding(false)} onSaved={async () => { await refresh(); setAdding(false); }} /> : null}
    {editing ? <GitHubConnectionEditor key={editing.id} connection={editing} workspace={workspace} status={status}
      onClose={() => setEditing(null)} onSaved={async () => { await refresh(); setEditing(null); }} /> : null}
  </section>;
}

export function GitHubServerStatus({ status }: { status: GitHubStatus | null }) {
  return <div className="runtime-message" role="status"><ShieldCheck size={18} /><div>
    {!status ? <p>GitHub 서버 구성이 아직 확인되지 않았습니다. 인증·접속 성공은 미확인입니다.</p> : <>
      <p>{status.configured ? '서버 인증 설정 있음 · 저장소 접속은 개별 확인' : '서버 인증 미설정 · 실제 접속 확인 대기'}</p>
      {!status.configured && status.missing.length ? <p>미설정 항목: {status.missing.join(', ')}</p> : null}
      <p>{status.writable ? '작업 브랜치 게시·PR 작성 설정 켜짐' : '서버의 외부 쓰기 설정 꺼짐'}</p>
      <p>서버 허용 저장소: {status.repositories.length ? status.repositories.join(', ') : '미설정'}</p>
      <p>인증 정보는 서버에서만 설정하며 이 화면에는 입력하거나 표시하지 않습니다.</p>
    </>}
  </div></div>;
}

export function GitHubConnectionCard({ connection, workspace, status, refresh, onEdit }: {
  connection: Connection; workspace: Workspace; status: GitHubStatus | null; refresh: () => Promise<void>; onEdit: () => void;
}) {
  const action = useAction();
  const connected = connection.github?.status === 'connected';
  const allowed = status?.repositories.some(repository => repository.toLowerCase() === connection.repository.toLowerCase()) ?? false;
  const label = connected ? '접속 확인됨' : connection.github ? '연결 해제됨' : '범위만 등록됨';
  return <article className="model-budget-editor" aria-label={`${connection.repository} 연결 설정`}>
    <div className="connection-row"><GitBranch size={18} /><div><strong>{connection.repository}</strong><small><DateLabel value={connection.createdAt} /> 범위 등록</small></div>
      <span className={`tag ${connected ? 'tag-green' : 'tag-amber'}`}>{label}</span></div>
    <dl className="config-list"><div><dt>저장소 권한 상한</dt><dd>{connection.access === 'write' ? '읽기·작업 브랜치 게시·PR 작성' : '읽기'}</dd></div>
      <div><dt>마지막 접속 확인</dt><dd>{connection.github ? <DateLabel value={connection.github.verifiedAt} time /> : '확인 기록 없음'}</dd></div>
      {connection.github ? <><div><dt>GitHub 저장소 ID</dt><dd>{connection.github.repositoryId}</dd></div><div><dt>기본 브랜치</dt><dd>{connection.github.defaultBranch}</dd></div></> : null}</dl>
    {connection.github && !connected ? <p className="inline-note">마지막 확인 기록은 과거 접속 결과입니다. 현재 연결은 해제돼 있습니다.</p> : null}
    {status && !allowed ? <p className="inline-note">현재 서버 허용 저장소에 포함되지 않아 실제 접속을 확인할 수 없습니다.</p> : null}
    {connected && (!status?.configured || !allowed) ? <p className="inline-note">이전 접속 확인과 현재 서버 구성은 다릅니다. 현재 호출 가능 여부는 다시 확인해야 합니다.</p> : null}
    <GitHubGrantSummary connection={connection} workspace={workspace} />
    <div className="file-actions"><button className="button" disabled={action.pending || !status?.configured || !allowed}
      onClick={() => void action.execute(async () => { await request(`/connections/${connection.id}/verify`, 'POST', {}); await refresh(); })}>
      <ShieldCheck size={14} />{connected ? '접속 다시 확인' : connection.github ? '접속 확인·재연결' : '실제 접속 확인'}</button>
      <button className="button" disabled={action.pending} onClick={onEdit}><Pencil size={14} />역할별 권한 편집</button>
      {connected ? <button className="button danger-subtle" disabled={action.pending}
        onClick={() => void action.execute(async () => { await request(`/connections/${connection.id}`, 'PATCH', { enabled: false, expectedVersion: connection.version ?? 0 }); await refresh(); })}><Link2Off size={14} />연결 해제</button> : null}</div>
    <ErrorNotice message={action.error} />
  </article>;
}

function GitHubGrantSummary({ connection, workspace }: { connection: Connection; workspace: Workspace }) {
  const grants = connection.grants ?? [];
  return grants.length ? <div className="model-budget-table-wrap" tabIndex={0} aria-label={`${connection.repository} 역할별 권한 표 가로 스크롤`}>
    <table className="model-budget-table"><caption>역할별 허용 범위</caption><thead><tr><th scope="col">에이전트</th><th scope="col">원팀</th><th scope="col">프로젝트</th><th scope="col">권한</th></tr></thead>
      <tbody>{grants.map((grant, index) => <tr key={`${grant.agentId}-${grant.teamId}-${grant.projectId}-${index}`}>
        <th scope="row">{workspace.agents.find(agent => agent.id === grant.agentId)?.name ?? '현재 에이전트 없음'}</th>
        <td>{workspace.teams.find(team => team.id === grant.teamId)?.name ?? '현재 팀 없음'}</td>
        <td>{workspace.projects?.find(project => project.id === grant.projectId)?.name ?? '현재 프로젝트 없음'}</td>
        <td>{grant.access === 'write' ? '읽기·게시·PR 작성' : '읽기'}</td></tr>)}</tbody></table></div>
    : <p className="inline-note">허용된 에이전트가 없습니다. 접속을 확인해도 팀 전체에 권한이 자동 부여되지 않습니다.</p>;
}

export function GitHubRegisterForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [repository, setRepository] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const action = useAction();
  return <Modal title="저장소 접근 범위 등록" eyebrow="SCOPED CONNECTION" onClose={onClose} busy={action.pending}>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
      await request('/connections', 'POST', { repository: repository.trim(), access }); await onSaved();
    }); }}><Field label="저장소"><input required autoFocus maxLength={250} placeholder="owner/repository" value={repository} disabled={action.pending} onChange={event => setRepository(event.target.value)} /></Field>
      <Field label="저장소 권한 상한"><select value={access} disabled={action.pending} onChange={event => setAccess(event.target.value as 'read' | 'write')}><option value="read">읽기</option><option value="write">읽기·작업 브랜치 게시·PR 작성</option></select></Field>
      <p className="inline-note">접근 범위만 등록합니다. 실제 접속 확인과 에이전트별 권한 부여는 별도이며 인증 정보를 생성하지 않습니다.</p>
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" disabled={action.pending} onClick={onClose}>취소</button><Submit pending={action.pending}>범위 등록</Submit></div>
    </form>
  </Modal>;
}

export function GitHubConnectionEditor({ connection, workspace, status, onClose, onSaved, initialDraft }: {
  connection: Connection; workspace: Workspace; status: GitHubStatus | null; onClose: () => void; onSaved: () => Promise<void>; initialDraft?: GitHubConnectionDraft;
}) {
  const [draft, setDraft] = useState(() => structuredClone(initialDraft ?? githubConnectionDraft(connection)));
  const [baseline] = useState(() => githubPermissionFingerprint(connection));
  const nextRow = useRef(0), action = useAction();
  const current = workspace.connections.find(item => item.id === connection.id);
  const conflict = !current || githubPermissionFingerprint(current) !== baseline;
  const changeGrant = (rowId: string, patch: Partial<RepositoryGrant>) => setDraft(previous => ({ ...previous,
    grants: previous.grants.map(grant => grant.rowId === rowId ? { ...grant, ...patch } : grant) }));
  const submit = async () => {
    if (conflict) throw new Error('편집 중 저장소 권한이 변경됐습니다. 작성 내용은 유지합니다.');
    const input = parseGitHubConnectionDraft(draft, workspace);
    await request(`/connections/${connection.id}`, 'PATCH', { ...input, expectedVersion: connection.version ?? 0 }); await onSaved();
  };
  return <Modal title="역할별 저장소 권한" eyebrow={connection.repository} onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(submit); }}>
      <Field label="저장소 권한 상한"><select value={draft.access} disabled={action.pending} onChange={event => setDraft(previous => ({ ...previous, access: event.target.value as 'read' | 'write' }))}>
        <option value="read">읽기</option><option value="write">읽기·작업 브랜치 게시·PR 작성</option></select></Field>
      {!status?.writable ? <p className="inline-note">서버 외부 쓰기는 꺼져 있거나 미확인입니다. 쓰기 권한을 저장해도 서버 쓰기 설정을 켜기 전에는 게시할 수 없습니다.</p> : null}
      <p className="inline-note">프로젝트·원팀·에이전트를 모두 지정합니다. 상담에서는 읽기만 가능하며, 새 권한은 다음 작업부터 적용됩니다. 행 제거는 해당 권한의 철회입니다.</p>
      {draft.grants.map((grant, index) => {
        const project = workspace.projects?.find(item => item.id === grant.projectId);
        const teams = workspace.teams.filter(team => project?.teamIds.includes(team.id));
        const team = teams.find(item => item.id === grant.teamId);
        const agents = workspace.agents.filter(agent => team?.memberIds.includes(agent.id));
        return <fieldset className="environment-server-fields" key={grant.rowId} disabled={action.pending}><legend>권한 {index + 1}</legend>
          <Field label={`권한 ${index + 1} 프로젝트`}><select required value={grant.projectId} onChange={event => changeGrant(grant.rowId, { projectId: event.target.value, teamId: '', agentId: '' })}>
            <option value="">프로젝트 선택</option>{grant.projectId && !project ? <option value={grant.projectId}>현재 프로젝트 없음</option> : null}
            {(workspace.projects ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label={`권한 ${index + 1} 원팀`}><select required value={grant.teamId} disabled={!project} onChange={event => changeGrant(grant.rowId, { teamId: event.target.value, agentId: '' })}>
            <option value="">원팀 선택</option>{grant.teamId && !team ? <option value={grant.teamId}>현재 프로젝트에 없는 팀</option> : null}
            {teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label={`권한 ${index + 1} 에이전트`}><select required value={grant.agentId} disabled={!team} onChange={event => changeGrant(grant.rowId, { agentId: event.target.value })}>
            <option value="">에이전트 선택</option>{grant.agentId && !agents.some(agent => agent.id === grant.agentId) ? <option value={grant.agentId}>현재 원팀에 없는 에이전트</option> : null}
            {agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label={`권한 ${index + 1} 접근 범위`}><select value={grant.access} onChange={event => changeGrant(grant.rowId, { access: event.target.value as 'read' | 'write' })}>
            <option value="read">읽기</option><option value="write" disabled={draft.access === 'read'}>읽기·작업 브랜치 게시·PR 작성</option></select></Field>
          <button className="button danger-subtle" type="button" aria-label={`권한 ${index + 1} 제거`} onClick={() => setDraft(previous => ({ ...previous, grants: previous.grants.filter(item => item.rowId !== grant.rowId) }))}><Trash2 size={14} />권한 제거</button>
        </fieldset>;
      })}
      {!draft.grants.length ? <p className="inline-note">허용된 에이전트가 없습니다. 저장하면 이 저장소의 에이전트 권한을 모두 해제합니다.</p> : null}
      <button className="button" type="button" disabled={action.pending || draft.grants.length >= 100} onClick={() => {
        const rowId = `new-${nextRow.current++}`;
        setDraft(previous => ({ ...previous, grants: [...previous.grants, { rowId, agentId: '', teamId: '', projectId: '', access: 'read' }] }));
      }}><Plus size={14} />에이전트 권한 추가</button>
      {conflict ? <p className="model-budget-conflict" role="status">편집 중 연결이나 권한이 변경됐습니다. 작성 내용은 보존했으며, 창을 다시 열면 최신 범위를 확인할 수 있습니다.</p> : null}
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" disabled={action.pending} onClick={onClose}>취소</button>
        <Submit pending={action.pending || conflict}>권한 저장</Submit></div>
    </form>
  </Modal>;
}
