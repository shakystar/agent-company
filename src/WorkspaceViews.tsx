import { useId, useState, type ReactNode } from 'react';
import { Activity as ActivityIcon, ArrowRight, BookOpen, Box, Check, CheckCircle2, CircleAlert, Cpu, GitBranch, GitFork, Globe, Layers, LockKeyhole, Pencil, Plus, Server, ShieldCheck, Sparkles, Terminal, Users, X } from 'lucide-react';
import type { Activity, Agent, Team, Workspace } from '../shared/types';
import { request, useAction } from './api';
import { Avatar, DateLabel, Empty, ErrorNotice, Field, Modal, SectionTitle, Submit, TextContent } from './ui';
import { CollaborationPanel } from './CollaborationView';
import { StorageView } from './StorageView';
import { ModelBudgetView } from './ModelBudgetView';
import { GitHubConnections } from './GitHubConnections';
import { DeploymentPanel, deploymentHeld, useDeploymentStatus } from './DeploymentView';

const activityIcons = { created: Plus, run: Terminal, memory: BookOpen, skill: Sparkles, snapshot: Layers, fork: GitFork, restored: GitBranch, team: Users, system: Server };
export function ActivityList({ activities, agents, onSelect, compact = false }: { activities: Activity[]; agents: Agent[]; onSelect: (id: string) => void; compact?: boolean }) {
  const sorted = activities.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sorted.length ? <div className={`activity-list ${compact ? 'compact' : ''}`}>{sorted.map(activity => {
    const Icon = activityIcons[activity.type];
    const agent = agents.find(item => item.id === activity.agentId);
    return <article className="activity-item" key={activity.id}><span className={`activity-symbol event-${activity.type}`}><Icon size={16} /></span><div className="activity-copy"><h3>{activity.title}</h3>{activity.detail ? <p>{activity.detail}</p> : null}{agent ? <button className="activity-agent" onClick={() => onSelect(agent.id)}>{agent.name}<ArrowRight size={11} /></button> : null}</div><DateLabel value={activity.createdAt} time /></article>;
  })}</div> : <Empty icon={<ActivityIcon size={24} />} title="아직 남겨진 기록이 없습니다" detail="에이전트의 작업과 변화가 시간순으로 쌓입니다." />;
}

export function ActivityView({ workspace, onSelect }: { workspace: Workspace; onSelect: (id: string) => void }) {
  const [agentId, setAgentId] = useState('');
  const [filter, setFilter] = useState('');
  const activities = workspace.activities.filter(item => (!agentId || item.agentId === agentId) && (!filter || item.type === filter));
  return <><div className="page-heading"><div><span className="eyebrow">THE CHRONICLE</span><h1>활동 기록</h1><p>작업과 변화의 근거를 한곳에서 확인합니다.</p></div></div><div className="filter-bar"><label className="sr-only" htmlFor="activity-agent">에이전트 필터</label><select id="activity-agent" value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">모든 에이전트</option>{workspace.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><label className="sr-only" htmlFor="activity-type">활동 종류</label><select id="activity-type" value={filter} onChange={event => setFilter(event.target.value)}><option value="">모든 활동</option><option value="run">작업</option><option value="memory">기억</option><option value="skill">스킬</option><option value="fork">복제</option><option value="snapshot">스냅샷</option><option value="team">팀</option></select><span>{activities.length}개의 기록</span></div><div className="panel"><ActivityList activities={activities} agents={workspace.agents} onSelect={onSelect} /></div></>;
}

export function TeamsView({ workspace, refresh, onSelect }: { workspace: Workspace; refresh: () => Promise<void>; onSelect: (id: string) => void }) {
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = workspace.teams.find(team => team.id === selectedId) ?? workspace.teams[0];
  const approvals = workspace.approvals.filter(item => item.status === 'pending');
  const action = useAction();
  return <><div className="page-heading"><div><span className="eyebrow">BETTER TOGETHER</span><h1>팀</h1><p>각자의 경험을 가진 에이전트에 공동의 방향을 부여합니다.</p></div><button className="button primary" onClick={() => setEditing('new')} disabled={!workspace.agents.length}><Plus size={16} />팀 만들기</button></div>
    {approvals.length ? <section className="approval-section"><SectionTitle title={`검토할 구성 변경 ${approvals.length}건`} />{approvals.map(approval => { const team = workspace.teams.find(item => item.id === approval.teamId); const proposer = workspace.agents.find(item => item.id === approval.proposedByAgentId); return <article className="approval-card" key={approval.id}><div className="approval-icon"><Users size={20} /></div><div><h3>{team?.name ?? '팀'} · 구성 변경</h3><p>{approval.reason}</p><div className="approval-members">{approval.memberIds.map(id => <span className="tag" key={id}>{workspace.agents.find(agent => agent.id === id)?.name ?? id}</span>)}</div><small>{proposer?.name ?? '에이전트'}의 제안 · <DateLabel value={approval.createdAt} /></small></div><div className="approval-actions"><button className="button" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/approvals/${approval.id}/resolve`, 'POST', { approved: false }); await refresh(); })}><X size={14} />거절</button><button className="button primary" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/approvals/${approval.id}/resolve`, 'POST', { approved: true }); await refresh(); })}><Check size={14} />승인</button></div></article>; })}<ErrorNotice message={action.error} /></section> : null}
    {workspace.teams.length && selected ? <div className="teams-layout"><aside className="team-list">{workspace.teams.map(team => <button key={team.id} className={`team-list-item ${selected.id === team.id ? 'selected' : ''}`} onClick={() => setSelectedId(team.id)}><span className="team-symbol"><Users size={20} /></span><span><strong>{team.name}</strong><small>{team.memberIds.length}명의 에이전트</small></span></button>)}</aside><section className="team-detail panel"><div className="team-heading"><div><span className="eyebrow">TEAM · v{selected.version}</span><h2>{selected.name}</h2><p>{selected.description}</p></div><button className="button" onClick={() => setEditing(selected)}><Pencil size={14} />편집</button></div><div className="team-members">{selected.memberIds.map(id => { const agent = workspace.agents.find(item => item.id === id); return agent ? <button className="team-member" onClick={() => onSelect(agent.id)} key={id}><Avatar agent={agent} /><span>{agent.name}<small>{agent.description || `${agent.generation}세대`}</small></span><ArrowRight size={15} /></button> : null; })}</div><div className="workflow-heading"><h3>워크플로우</h3><span className="tag mono">MARKDOWN</span></div>{selected.workflow ? <TextContent text={selected.workflow} className="workflow-content" /> : <p className="muted">아직 작성된 워크플로우가 없습니다.</p>}<div className="inline-note"><LockKeyhole size={15} />자료와 협업 도구만 공유합니다. 구성원의 개인 기억과 작업 폴더는 격리됩니다.</div><CollaborationPanel key={selected.id} scope={{ type: 'team', id: selected.id }} workspace={workspace} refresh={refresh} onSelect={onSelect} /></section></div> : <div className="panel"><Empty icon={<Users size={29} />} title="함께할 팀을 구성합니다" detail={workspace.agents.length ? '에이전트를 묶고 Markdown으로 공동의 방향을 작성할 수 있습니다.' : '에이전트를 생성한 뒤 팀으로 묶을 수 있습니다.'} action={workspace.agents.length ? <button className="button" onClick={() => setEditing('new')}><Plus size={16} />첫 팀 만들기</button> : undefined} /></div>}
    {selected ? <TeamTaskDiscoveryStatus team={selected} /> : null}
    {editing ? <TeamForm key={editing === 'new' ? 'new' : editing.id} team={editing === 'new' ? undefined : editing} agents={workspace.agents} onClose={() => setEditing(null)} onSaved={async team => { await refresh(); setSelectedId(team.id); setEditing(null); }} /> : null}
  </>;
}

const taskDiscoveryExplanation = '유휴 팀원이 새 과제를 확인하고 자청 여부를 판단합니다. 끄면 새 탐색만 멈추며 진행 중 작업·동료 메시지는 별도입니다.';
export function TeamTaskDiscoveryStatus({ team }: { team: Team }) {
  return <section className="inline-note" aria-label="열린 과제 자동 탐색 상태"><div><p>{team.name} · 열린 과제 자동 탐색 <span className={`tag ${team.autoDiscoverTasks ? 'tag-green' : ''}`}>{team.autoDiscoverTasks ? '켜짐' : '꺼짐'}</span></p>
    <p>{taskDiscoveryExplanation}</p></div></section>;
}

export function TeamForm({ team, agents, onClose, onSaved }: { team?: Team; agents: Agent[]; onClose: () => void; onSaved: (team: Team) => Promise<void> }) {
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [workflow, setWorkflow] = useState(team?.workflow ?? '');
  const [memberIds, setMemberIds] = useState(team?.memberIds ?? []);
  const [autoDiscoverTasks, setAutoDiscoverTasks] = useState(team?.autoDiscoverTasks ?? false);
  const discoveryHintId = useId();
  const action = useAction();
  return <Modal title={team ? '팀 편집' : '새로운 팀'} eyebrow="SHARED DIRECTION" onClose={onClose} busy={action.pending} wide><form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => { const saved = await request<Team>(team ? `/teams/${team.id}` : '/teams', team ? 'PATCH' : 'POST', { name, description, workflow, memberIds, autoDiscoverTasks }); await onSaved(saved); }); }}><div className="form-columns"><Field label="팀 이름"><input required maxLength={100} value={name} onChange={event => setName(event.target.value)} autoFocus /></Field><Field label="한 줄 소개"><input maxLength={250} value={description} onChange={event => setDescription(event.target.value)} /></Field></div><div className="field"><span>구성원</span><div className="member-picker">{agents.map(agent => <label className={memberIds.includes(agent.id) ? 'selected' : ''} key={agent.id}><input type="checkbox" checked={memberIds.includes(agent.id)} onChange={event => setMemberIds(current => event.target.checked ? [...current, agent.id] : current.filter(id => id !== agent.id))} /><Avatar agent={agent} size="small" /><span className="member-name">{agent.name}</span></label>)}</div></div><Field label="워크플로우 · Markdown" hint="목표와 역할, 결과물의 조건을 자유롭게 작성할 수 있습니다."><textarea rows={9} maxLength={100000} className="mono" value={workflow} onChange={event => setWorkflow(event.target.value)} placeholder={'# 공동 목표\n\n이 팀이 함께할 작업의 방향'} /></Field>
    <div><label className="check-row"><input type="checkbox" checked={autoDiscoverTasks} disabled={action.pending} aria-describedby={discoveryHintId}
      onChange={event => setAutoDiscoverTasks(event.target.checked)} />열린 과제 자동 탐색</label><p id={discoveryHintId} className="inline-note">{taskDiscoveryExplanation}</p></div>
    <ErrorNotice message={action.error} /><div className="modal-actions"><button type="button" className="button subtle" onClick={onClose} disabled={action.pending}>취소</button><Submit pending={action.pending}>{team ? '변경 저장' : '팀 생성'}</Submit></div></form></Modal>;
}

export function SettingsView({ workspace, refresh, children }: { workspace: Workspace; refresh: () => Promise<void>; children?: ReactNode }) {
  const deployment = useDeploymentStatus(workspace.deployment);
  const holding = deploymentHeld(deployment.status);
  const panel = <DeploymentPanel status={deployment.status} error={deployment.error} pending={deployment.pending} workspace={workspace}
    onRefresh={() => void deployment.refresh()} onPrepare={() => void deployment.change('prepare', refresh)} onResume={() => void deployment.change('resume', refresh)} />;
  return <><EnvironmentView workspace={workspace} refresh={refresh} deployment={<>{panel}{children}</>} holding={holding} />{holding ? <p className="inline-note">배포 준비 중에는 연결·예산·저장공간 설정의 변경과 보조 조회를 보류합니다. 배포 상태 조회와 작업 재개는 계속 사용할 수 있습니다.</p>
    : <><ModelBudgetView workspace={workspace} refresh={refresh} /><StorageView refresh={refresh} /></>}</>;
}

function EnvironmentView({ workspace, refresh, deployment, holding }: { workspace: Workspace; refresh: () => Promise<void>; deployment: ReactNode; holding: boolean }) {
  const runtime = workspace.runtime;
  const action = useAction();
  return <><div className="page-heading"><div><span className="eyebrow">CONTROL ROOM</span><h1>실행 환경</h1><p>준비 상태와 허용된 접근 범위를 확인합니다.</p></div><button className="button" disabled={action.pending} onClick={() => void action.execute(refresh)}>상태 새로고침</button></div>{deployment}<div className="settings-grid"><section className="panel runtime-panel"><div className="panel-heading"><span className="settings-icon"><Box size={23} /></span><div><h2>에이전트 실행기</h2><p>{runtime.mode === 'docker' ? 'Docker' : 'Kubernetes'} · 독립 실행 환경</p></div><span className={`tag ${runtime.available && runtime.authenticated ? 'tag-green' : 'tag-amber'}`}>{runtime.available && runtime.authenticated ? '준비됨' : '연결 대기'}</span></div><dl className="config-list"><div><dt>런타임</dt><dd>{runtime.available ? <><CheckCircle2 size={14} />사용 가능</> : <><CircleAlert size={14} />사용 불가</>}</dd></div><div><dt>모델 인증</dt><dd>{runtime.authenticated ? '인증 설정 있음 · 호출 미검증' : '미연결'}</dd></div><div><dt>기본 모델</dt><dd className="mono">{runtime.model || '미설정'}</dd></div><div><dt>실행 이미지</dt><dd className="mono">{runtime.image || '미설정'}</dd></div>{runtime.version ? <div><dt>버전</dt><dd className="mono">{runtime.version}</dd></div> : null}</dl><div className="runtime-message"><Server size={16} /><p>{runtime.message}</p></div></section><section className="panel autonomy-panel"><div className="panel-heading"><span className="settings-icon"><ShieldCheck size={23} /></span><div><h2>자율성의 경계</h2><p>개인 작업실의 운영 원칙</p></div></div><div className="policy-row"><BookOpen size={17} /><span>자기 기억·스킬 갱신</span><span className="tag tag-green">자동</span></div><div className="policy-row"><Globe size={17} /><span>기존 접근 범위 내 도구</span><span className="tag tag-green">자동</span></div><div className="policy-row"><Users size={17} /><span>에이전트의 팀 구성 제안</span><span className="tag tag-amber">승인 후 적용</span></div><div className="policy-row"><LockKeyhole size={17} /><span>새 연결·접근 범위 확대</span><span className="tag">사용자 설정</span></div></section></div>
    {!holding ? <GitHubConnections workspace={workspace} refresh={refresh} /> : null}<ErrorNotice message={action.error} />
  </>;
}
