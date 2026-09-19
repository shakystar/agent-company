import { useEffect, useState, type ReactNode } from 'react';
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, Box, ChevronRight, CircleAlert, ClipboardList, Command, GitFork, LayoutGrid, LoaderCircle, MessageSquare, Plus, Search, SlidersHorizontal, Sparkles, Target, Users } from 'lucide-react';
import type { Agent, RuntimeInfo, Workspace } from '../shared/types';
import { useWorkspace } from './api';
import { AgentForm, starters } from './AgentForms';
import { AgentDetail, activeRun } from './AgentDetail';
import { ActivityList, ActivityView, SettingsView, TeamsView } from './WorkspaceViews';
import { ProjectsView } from './CollaborationView';
import { ConversationWorkspace, conversationLocation } from './ConversationView';
import { ModelBudgetSummary } from './ModelBudgetView';
import { ObjectivesView } from './ObjectivesView';
import { OperatorRequestsView, operatorRequestLocation, operatorRequestOpen } from './OperatorRequestsView';
import { DeploymentNotice } from './DeploymentView';
import { DesktopSetupView } from './DesktopSetupView';
import { DesktopRuntimeSetupView } from './DesktopRuntimeSetupView';
import { DesktopMcpView } from './DesktopMcpView';
import { Avatar, DateLabel, Empty, ErrorNotice, SectionTitle, Status, TextLink } from './ui';

type View = 'agents' | 'conversations' | 'teams' | 'projects' | 'objectives' | 'requests' | 'activity' | 'settings';
export function appLocation(hash: string): { view: View; conversationId: string | null } | null {
  if (operatorRequestLocation(hash)) return { view: 'requests', conversationId: null };
  const conversation = conversationLocation(hash);
  if (conversation) return { view: 'conversations', conversationId: conversation.id };
  const view = hash.slice(1);
  return ['agents', 'teams', 'projects', 'objectives', 'activity', 'settings'].includes(view) ? { view: view as View, conversationId: null } : null;
}
export function App() {
  const { workspace, error, refresh } = useWorkspace();
  const [view, setView] = useState<View>(() => typeof window !== 'undefined' ? appLocation(window.location.hash)?.view ?? 'agents' : 'agents');
  const [conversationId, setConversationId] = useState<string | null>(() => typeof window !== 'undefined' ? conversationLocation(window.location.hash)?.id ?? null : null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creation, setCreation] = useState<true | typeof starters[number] | null>(null);
  const selected = workspace?.agents.find(agent => agent.id === selectedId);
  useEffect(() => {
    const changed = () => {
      const route = appLocation(window.location.hash);
      if (route) { setView(route.view); setConversationId(route.conversationId); setSelectedId(null); }
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const selectAgent = (id: string) => { setSelectedId(id); setView('agents'); window.history.replaceState(null, '', '#agents'); window.scrollTo({ top: 0 }); };
  const navigate = (next: View) => { setView(next); setSelectedId(null); if (next === 'conversations') { setConversationId(null); window.location.hash = 'conversations'; } else window.history.replaceState(null, '', `#${next}`); window.scrollTo({ top: 0 }); };
  const pending = workspace?.approvals.filter(item => item.status === 'pending').length ?? 0;
  const openRequests = workspace?.operatorRequests?.filter(operatorRequestOpen).length ?? 0;
  const navigation: Array<{ id: View; label: string; icon: ReactNode }> = [{ id: 'agents', label: '에이전트', icon: <LayoutGrid size={18} /> }, { id: 'conversations', label: '대화', icon: <MessageSquare size={18} /> }, { id: 'teams', label: '팀', icon: <Users size={18} /> }, { id: 'projects', label: '프로젝트', icon: <Box size={18} /> }, { id: 'objectives', label: '목적', icon: <Target size={18} /> }, { id: 'requests', label: '대표 요청함', icon: <ClipboardList size={18} /> }, { id: 'activity', label: '활동 기록', icon: <Activity size={18} /> }, { id: 'settings', label: '실행 환경', icon: <SlidersHorizontal size={18} /> }];
  return <div className="app-shell"><a className="skip-link" href="#main-content">본문으로 이동</a><aside className="sidebar"><button className="brand" onClick={() => navigate('agents')} aria-label="Agent Company 홈"><span className="brand-mark"><i /><i /><i /><i /></span><span>agent<span className="brand-dot">.</span>company</span></button><div className="workspace-label"><span className="workspace-initial">P</span><div>개인 작업실<small>PERSONAL WORKSPACE</small></div><span className="workspace-status" /></div><span className="nav-caption">WORKSPACE</span><nav aria-label="주 메뉴">{navigation.map(item => <button className={view === item.id ? 'active' : ''} key={item.id} onClick={() => navigate(item.id)} aria-current={view === item.id ? 'page' : undefined}>{item.icon}<span>{item.label}</span>{item.id === 'agents' && workspace ? <span className="nav-count">{workspace.agents.length}</span> : item.id === 'requests' && openRequests ? <span className="nav-notification" aria-label={`미처리 대표 요청 ${openRequests}건`}>{openRequests}</span> : item.id === 'teams' && pending ? <span className="nav-notification">{pending}</span> : null}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-philosophy"><GitFork size={21} /><p>경험을 쌓고.<br />가능성을 이어갑니다.</p></div><button className="runtime-indicator" onClick={() => navigate('settings')}><span className={`runtime-dot ${workspace?.runtime.available && workspace.runtime.authenticated ? 'online' : ''}`} /><span>{workspace ? workspace.runtime.available && workspace.runtime.authenticated ? '실행 환경 준비됨' : '실행 환경 연결 대기' : '작업실 연결 중'}</span><ChevronRight size={13} /></button><div className="sidebar-version"><span>LOCAL STUDIO</span><span>v0.1</span></div></div></aside><div className="main-shell"><header className="topbar"><div><span>작업실</span><ChevronRight size={13} /><strong>{selected && view === 'agents' ? selected.name : navigation.find(item => item.id === view)?.label}</strong></div><span className="topbar-label"><span className="small-dot" />개인 전용</span></header><main id="main-content"><ErrorNotice message={error} />{!workspace ? <div className="loading-state">{error ? <><CircleAlert size={28} /><h2>작업실을 연결하지 못했습니다</h2><button className="button" onClick={() => void refresh()}>다시 연결</button></> : <><LoaderCircle size={29} className="spin" /><h2>작업실을 불러오고 있습니다</h2></>}</div> : <>
      <RuntimeNotice runtime={workspace.runtime} />
      {view !== 'settings' ? <DeploymentNotice status={workspace.deployment} /> : null}
      {view !== 'settings' ? <ModelBudgetSummary workspace={workspace} /> : null}
      {view === 'agents' ? selected ? <AgentDetail key={selected.id} agent={selected} workspace={workspace} onBack={() => setSelectedId(null)} onSelect={selectAgent} refresh={refresh} /> : <Studio workspace={workspace} onSelect={selectAgent} onCreate={starter => setCreation(starter ?? true)} onActivity={() => navigate('activity')} /> : null}
      {view === 'conversations' ? <><div className="page-heading"><div><span className="eyebrow">SHARED WORKROOM</span><h1>대화형 작업실</h1><p>실제 작업 에이전트와 이야기하고, 동료 간 논의에 참여합니다.</p></div></div><ConversationWorkspace workspace={workspace} refresh={refresh} onSelectAgent={selectAgent} conversationId={conversationId} /></> : null}
      {view === 'teams' ? <TeamsView workspace={workspace} refresh={refresh} onSelect={selectAgent} /> : null}
      {view === 'projects' ? <ProjectsView workspace={workspace} refresh={refresh} onSelect={selectAgent} /> : null}
      {view === 'objectives' ? <ObjectivesView workspace={workspace} refresh={refresh} onSelect={selectAgent} /> : null}
      {view === 'requests' ? <OperatorRequestsView workspace={workspace} refresh={refresh} onSelect={selectAgent} /> : null}
      {view === 'activity' ? <ActivityView workspace={workspace} onSelect={selectAgent} /> : null}
      {view === 'settings' ? <SettingsView workspace={workspace} refresh={refresh}>{workspace.desktop?.runtimeSetup ? <DesktopRuntimeSetupView /> : null}{workspace.desktop?.accountSetup ? <DesktopSetupView /> : null}{workspace.desktop?.localMcp ? <DesktopMcpView workspace={workspace} /> : null}</SettingsView> : null}
    </>}</main><footer className="workspace-footer"><span>AGENT COMPANY</span><span>기억은 남고, 다음 작업은 이어집니다.</span></footer></div>{creation && workspace ? <AgentForm workspace={workspace} starter={creation === true ? undefined : creation} onClose={() => setCreation(null)} onSaved={async agent => { await refresh(); setCreation(null); selectAgent(agent.id); }} /> : null}</div>;
}

export function RuntimeNotice({ runtime }: { runtime: RuntimeInfo }) {
  return runtime.simulation ? <div className="runtime-simulation-notice" role="status"><CircleAlert size={17} /><span>화면 검증용 · 실제 모델을 호출하지 않습니다</span></div> : null;
}

function Studio({ workspace, onSelect, onCreate, onActivity }: { workspace: Workspace; onSelect: (id: string) => void; onCreate: (starter?: typeof starters[number]) => void; onActivity: () => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const query = search.trim().toLocaleLowerCase();
  const agents = workspace.agents.filter(agent => (!query || `${agent.name} ${agent.description} ${agent.persona}`.toLocaleLowerCase().includes(query)) && (filter === 'all' || (filter === 'forks' ? !!agent.parentId : agent.status === filter)));
  const running = workspace.runs.filter(activeRun).length;
  const completed = workspace.runs.filter(run => run.status === 'succeeded').length;
  const metrics = [{ label: '에이전트', value: workspace.agents.length, icon: <Box size={15} /> }, { label: '기억', value: workspace.memories.length, icon: <BookOpen size={15} /> }, { label: '활성 스킬', value: workspace.skills.filter(skill => skill.status === 'active').length, icon: <Sparkles size={15} /> }, { label: '완료한 작업', value: completed, icon: <ArrowUpRight size={15} /> }];
  return <><div className="page-heading"><div><span className="eyebrow">YOUR AGENT STUDIO</span><h1>에이전트</h1><p>함께 일하고, 경험을 쌓고, 새로운 방향으로.</p></div><button className="button primary" onClick={() => onCreate()}><Plus size={17} />에이전트 생성</button></div>
    <section className={`studio-banner ${workspace.agents.length ? 'has-agents' : ''}`}><div className="banner-copy"><span className="banner-kicker"><span className="small-dot" />{workspace.agents.length ? `${running}개의 작업이 진행 중입니다` : 'THE FIRST CHAPTER'}</span><h2>{workspace.agents.length ? <>각자의 경험이,<br />다음의 가능성으로.</> : <>가능성을,<br /><span>함께 키웁니다.</span></>}</h2><p>{workspace.agents.length ? '오늘의 작업이 다음 작업의 출발점이 됩니다.' : '하나의 페르소나에서 시작되는 나만의 에이전트.'}</p>{workspace.agents.length ? <div className="banner-bottom"><span className="mono">{String(workspace.agents.length).padStart(2, '0')} AGENTS</span><span className="banner-divider" /><span>독립된 기억 · 이어지는 경험</span></div> : <button className="banner-link" onClick={() => onCreate()}>첫 에이전트 만들기<ArrowUpRight size={17} /></button>}</div><div className="banner-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-orbit orbit-three" /><div className="art-path" /><span className="art-node node-one">a</span><span className="art-node node-two"><Sparkles size={25} strokeWidth={1.2} /></span><span className="art-node node-three"><GitFork size={20} strokeWidth={1.2} /></span><span className="art-dot art-dot-one" /><span className="art-dot art-dot-two" /><span className="art-label label-one">ORIGIN</span><span className="art-label label-two">EXPERIENCE</span><span className="art-label label-three">EVOLUTION</span></div></section>
    <section className="metrics-strip" aria-label="작업실 현황">{metrics.map(metric => <div className="metric" key={metric.label}><span>{metric.icon}{metric.label}</span><strong>{metric.value.toLocaleString()}<small>{metric.label === '에이전트' ? '명' : '개'}</small></strong></div>)}</section>
    {workspace.agents.length ? <section><div className="agents-toolbar"><div className="filter-tabs" aria-label="에이전트 필터">{[{ id: 'all', label: '전체' }, { id: 'running', label: '실행 중' }, { id: 'forks', label: '복제본' }].map(item => <button key={item.id} className={filter === item.id ? 'active' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><label className="search-field"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="에이전트 검색" aria-label="에이전트 검색" /></label></div>{agents.length ? <div className="agents-grid">{agents.map(agent => <AgentCard key={agent.id} agent={agent} workspace={workspace} onClick={() => onSelect(agent.id)} />)}<button className="new-agent-card" onClick={() => onCreate()}><span><Plus size={22} /></span><strong>새로운 가능성</strong><p>에이전트 생성</p></button></div> : <Empty icon={<Search size={25} />} title="일치하는 에이전트가 없습니다" detail="검색어와 필터에 해당하는 에이전트가 없습니다." />}</section> : <section className="starter-section"><SectionTitle title="어디서부터 시작할까" detail="빈 페르소나로 시작하거나, 출발점을 선택할 수 있습니다." /><div className="starter-grid">{starters.map((starter, index) => <button className="starter-card" onClick={() => onCreate(starter)} key={starter.name}><span className={`starter-symbol starter-${index}`}>{index === 0 ? <Search size={24} strokeWidth={1.4} /> : index === 1 ? <Command size={24} strokeWidth={1.4} /> : <PencilSymbol />}</span><div><h3>{starter.name}</h3><p>{starter.description}</p></div><ArrowUpRight size={17} /></button>)}</div></section>}
    <section className="recent-section"><SectionTitle title="최근의 변화" action={<TextLink onClick={onActivity}>모든 기록</TextLink>} /><div className="panel"><ActivityList activities={workspace.activities.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)} agents={workspace.agents} onSelect={onSelect} compact /></div></section>
  </>;
}

function PencilSymbol() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2.2 2.2 0 0 0-4-4L5 15l-1 5Z" /><path d="M13 20h8" /></svg>; }

function AgentCard({ agent, workspace, onClick }: { agent: Agent; workspace: Workspace; onClick: () => void }) {
  const memories = workspace.memories.filter(item => item.agentId === agent.id).length;
  const skills = workspace.skills.filter(item => item.agentId === agent.id && item.status === 'active').length;
  const parent = workspace.agents.find(item => item.id === agent.parentId);
  const latest = workspace.runs.filter(item => item.agentId === agent.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return <button className="agent-card" onClick={onClick}><div className="agent-card-top"><Avatar agent={agent} /><Status status={agent.status} /></div><h3>{agent.name}<ArrowUpRight size={17} /></h3><p className="agent-card-description">{agent.description || agent.persona}</p><div className="agent-card-stats"><span><BookOpen size={13} />기억 {memories}</span><span><Sparkles size={13} />스킬 {skills}</span><span className="mono">v{agent.version}</span></div><div className="agent-card-bottom">{parent ? <span><GitFork size={12} />{parent.name}에서 분기</span> : <span><span className="small-dot" />{agent.generation}세대 · ORIGINAL</span>}<span>{latest ? <DateLabel value={latest.createdAt} /> : '첫 작업 대기'}</span></div></button>;
}
