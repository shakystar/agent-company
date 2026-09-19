import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Boxes, Check, ChevronDown, Download, FileText, GitBranch, GitFork, History, Layers, LoaderCircle, MessageSquarePlus, Pause, Pencil, Play, Plus, RotateCcw, Send, Settings2, Sparkles, Square, Terminal } from 'lucide-react';
import type { Agent, Artifact, Memory, Run, Snapshot, Workspace } from '../shared/types';
import { request, useAction } from './api';
import { AgentForm, ForkForm, KnowledgeForm, RestoreForm } from './AgentForms';
import { Avatar, DateLabel, Empty, ErrorNotice, Modal, SectionTitle, Status, Submit, TextContent } from './ui';
import { WorkspaceFiles } from './WorkspaceFiles';
import { GrowthView, SkillCatalog } from './GrowthView';
import { UsageView } from './UsageView';
import { EnvironmentView } from './EnvironmentView';
import { ConversationWorkspace } from './ConversationView';
import { RunBudgetNotice, isCurrentBudgetWait } from './ModelBudgetView';
import { RunCheckpoints } from './RunCheckpoints';
import { isLearningReviewRun, LearningReviewView } from './LearningReviewView';

type Tab = 'work' | 'memory' | 'skills' | 'growth' | 'history' | 'files' | 'environment';
type Dialog = { kind: 'edit' } | { kind: 'fork'; snapshotId?: string } | { kind: 'restore'; snapshot: Snapshot } | { kind: 'memory'; memory?: Memory } | { kind: 'skill' } | null;
export const activeRun = (run: Run) => ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status);

export function AgentDetail({ agent, workspace, onBack, onSelect, refresh }: { agent: Agent; workspace: Workspace; onBack: () => void; onSelect: (id: string) => void; refresh: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('work');
  const [dialog, setDialog] = useState<Dialog>(null);
  const action = useAction();
  const memories = workspace.memories.filter(memory => memory.agentId === agent.id);
  const skills = workspace.skills.filter(skill => skill.agentId === agent.id);
  const runs = workspace.runs.filter(run => run.agentId === agent.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const busy = agent.status === 'running' || runs.some(activeRun);
  const snapshots = workspace.snapshots.filter(snapshot => snapshot.agentId === agent.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const parent = workspace.agents.find(item => item.id === agent.parentId);
  const children = workspace.agents.filter(item => item.parentId === agent.id);
  const saved = async () => { await refresh(); setDialog(null); };
  const tabs: Array<{ id: Tab; label: string; count?: number; icon: ReactNode }> = [{ id: 'work', label: '작업실', icon: <Terminal size={16} /> }, { id: 'memory', label: '기억', count: memories.length, icon: <BookOpen size={16} /> }, { id: 'skills', label: '스킬', count: skills.filter(skill => skill.status === 'active').length, icon: <Sparkles size={16} /> }, { id: 'history', label: '버전과 계보', icon: <GitBranch size={16} /> }];
  tabs.push({ id: 'files', label: '작업 파일', icon: <FileText size={16} /> });
  tabs.splice(3, 0, { id: 'growth', label: '성장', icon: <Sparkles size={16} /> });
  tabs.push({ id: 'environment', label: '환경', icon: <Boxes size={16} /> });
  return <>
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} />모든 에이전트</button>
    <section className="agent-heading"><div className="agent-identity"><Avatar agent={agent} size="large" /><div><div className="title-row"><h1>{agent.name}</h1><Status status={agent.status} /></div><p>{agent.description || '새로운 경험을 기다리는 에이전트'}</p><div className="agent-meta"><span>v{agent.version}</span><span>{agent.model}</span><span>{agent.generation}세대</span></div></div></div><div className="heading-actions"><button className="button" onClick={() => setDialog({ kind: 'edit' })}><Settings2 size={15} />설정</button><button className="button primary" onClick={() => setDialog({ kind: 'fork' })}><GitFork size={16} />복제</button></div></section>
    <div className="agent-overview-strip"><details><summary>페르소나 <ChevronDown size={14} /></summary><TextContent text={agent.persona} /></details><span><i className="small-dot" />개인 기억·스킬 자동 갱신</span><button className="text-link" disabled={action.pending || busy} onClick={() => void action.execute(async () => { await request(`/agents/${agent.id}`, 'PATCH', { status: agent.status === 'paused' ? 'idle' : 'paused' }); await refresh(); })}>{agent.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}{agent.status === 'paused' ? '활성화' : '일시 정지'}</button></div>
    <ErrorNotice message={action.error} />
    <div className="tabs" role="tablist" aria-label="에이전트 상세">{tabs.map((item, index) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={tab === item.id ? `panel-${item.id}` : undefined} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
      const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (nextIndex === null) return;
      event.preventDefault();
      const next = tabs[nextIndex].id;
      setTab(next);
      event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus();
    }}>{item.icon}{item.label}{item.count !== undefined ? <span>{item.count}</span> : null}</button>)}</div>
    <section className="tab-panel" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
      {tab === 'work' ? <><ConversationWorkspace scope={{ type: 'agent', id: agent.id }} workspace={workspace} refresh={refresh} onSelectAgent={onSelect} />
        {runs.length ? <details className="conversation-legacy"><summary>모든 실행 기록 · {runs.length}</summary><Workroom agent={agent} runs={runs} workspace={workspace} refresh={refresh} /></details> : null}</> : null}
      {tab === 'files' ? <WorkspaceFiles key={agent.id} agent={agent} busy={busy} onSaved={refresh} /> : null}
      {tab === 'memory' ? <><SectionTitle title="이어가는 기억" detail="작업에서 얻은 지식과 직접 남긴 기록입니다." action={<button className="button" disabled={busy} onClick={() => setDialog({ kind: 'memory' })}><Plus size={15} />기억 추가</button>} />{memories.length ? <div className="knowledge-grid">{memories.map(memory => <article className="knowledge-card" key={memory.id}><div className="card-topline"><span className="tag">{{ fact: '지식', preference: '선호', procedure: '절차' }[memory.kind]}</span><button className="icon-button" disabled={busy} aria-label={`${memory.title} 편집`} onClick={() => setDialog({ kind: 'memory', memory })}><Pencil size={14} /></button></div><h3>{memory.title}</h3><TextContent text={memory.content} /><div className="knowledge-footer"><span>{memory.sourceRunId ? '작업에서 축적' : '직접 기록'}</span><DateLabel value={memory.updatedAt} /></div></article>)}</div> : <Empty icon={<BookOpen size={25} />} title="아직 기록된 기억이 없습니다" detail="작업에서 얻은 경험이 이곳에 쌓입니다." action={<button className="button" disabled={busy} onClick={() => setDialog({ kind: 'memory' })}><Plus size={15} />첫 기억 추가</button>} />}</> : null}
      {tab === 'skills' ? <SkillCatalog skills={skills} revisions={workspace.skillRevisions ?? []} busy={busy}
        onAdd={() => setDialog({ kind: 'skill' })} onShowGrowth={() => setTab('growth')} /> : null}
      {tab === 'growth' ? <GrowthView agent={agent} workspace={workspace} /> : null}
      {tab === 'environment' ? <EnvironmentView key={agent.id} agent={agent} workspace={workspace} busy={busy} refresh={refresh} /> : null}
      {tab === 'history' ? <><SectionTitle title="갈라져도, 이어지는 경험" detail="시점을 보존하고 복제하거나 선택적으로 복원합니다." action={<button className="button" disabled={action.pending || busy} onClick={() => void action.execute(async () => { await request(`/agents/${agent.id}/snapshots`, 'POST', {}); await refresh(); })}><Plus size={15} />현재 시점 저장</button>} />
        <div className="lineage-panel"><span className="eyebrow">LINEAGE</span><div className="lineage-flow">{parent ? <><button className="lineage-node" onClick={() => onSelect(parent.id)}><Avatar agent={parent} /><span>{parent.name}<small>원본 · {parent.generation}세대</small></span></button><ArrowRight size={18} className="muted" /></> : <span className="lineage-root">ORIGIN</span>}<div className="lineage-node current"><Avatar agent={agent} /><span>{agent.name}<small>현재 · {agent.generation}세대</small></span></div>{children.length ? <><GitBranch size={22} className="muted" /><div className="lineage-children">{children.map(child => <button className="lineage-node" key={child.id} onClick={() => onSelect(child.id)}><Avatar agent={child} /><span>{child.name}<small>{child.generation}세대</small></span></button>)}</div></> : <button className="lineage-new" onClick={() => setDialog({ kind: 'fork' })}><Plus size={16} />새로운 갈래</button>}</div></div>
        <div className="snapshot-list">{snapshots.length ? snapshots.map(snapshot => <article className="snapshot-row" key={snapshot.id}><span className="snapshot-icon"><Layers size={18} /></span><div className="snapshot-description"><h3>{snapshot.label}<span className="tag">v{snapshot.agentVersion}</span></h3><p><DateLabel value={snapshot.createdAt} time /> · 기억 {snapshot.memories.length} · 스킬 {snapshot.skills.filter(skill => skill.status === 'active').length}</p></div><button className="button subtle" onClick={() => setDialog({ kind: 'fork', snapshotId: snapshot.id })}><GitFork size={15} />복제</button><button className="button subtle" disabled={busy} onClick={() => setDialog({ kind: 'restore', snapshot })}><RotateCcw size={15} />복원</button></article>) : <Empty icon={<History size={25} />} title="보존된 시점이 없습니다" detail="현재 시점을 저장해 복제와 복원의 기준으로 사용할 수 있습니다." />}</div>
      </> : null}
    </section>
    {dialog?.kind === 'edit' ? <AgentForm workspace={workspace} agent={agent} onClose={() => setDialog(null)} onSaved={saved} /> : null}
    {dialog?.kind === 'fork' ? <ForkForm agent={agent} snapshots={snapshots} initialSnapshotId={dialog.snapshotId} onClose={() => setDialog(null)} onSaved={async next => { await refresh(); setDialog(null); onSelect(next.id); }} /> : null}
    {dialog?.kind === 'restore' ? <RestoreForm agent={agent} snapshot={dialog.snapshot} onClose={() => setDialog(null)} onSaved={saved} /> : null}
    {dialog?.kind === 'memory' || dialog?.kind === 'skill' ? <KnowledgeForm agent={agent} kind={dialog.kind} memory={dialog.kind === 'memory' ? dialog.memory : undefined} onClose={() => setDialog(null)} onSaved={saved} /> : null}
  </>;
}

function Workroom({ agent, runs, workspace, refresh }: { agent: Agent; runs: Run[]; workspace: Workspace; refresh: () => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find(run => run.id === selectedId) ?? runs[0];
  return <div className="workroom-grid"><div className="workroom-main">
      {selected ? <RunDetail key={selected.id} run={selected} workspace={workspace} refresh={refresh} onSelectRun={setSelectedId} /> : <div className="first-run-state"><div className="orbit-mark small"><span /><span /><span /></div><h3>첫 작업에서 시작되는 경험</h3><p>작업 결과와 새로 쌓인 기억·스킬을 이곳에서 확인합니다.</p></div>}
    </div><aside className="run-sidebar"><div className="section-heading"><h2>작업 기록</h2><span className="count">{runs.length}</span></div>{runs.length ? runs.map(run => <button key={run.id} className={`run-list-item ${selected?.id === run.id ? 'selected' : ''}`} onClick={() => setSelectedId(run.id)}><div><Status status={run.status} /><DateLabel value={run.createdAt} /></div><p>{run.prompt}</p><span className="mono">v{run.agentVersion}{run.kind ? ` · ${{ task: '작업', review: '성장 비교', repair: '자동 재수정', environment: '환경 구축' }[run.kind]}` : ''}</span></button>) : <p className="aside-empty">아직 실행한 작업이 없습니다.</p>}</aside></div>;
}

function RunDetail({ run, workspace, refresh, onSelectRun }: { run: Run; workspace: Workspace; refresh: () => Promise<void>; onSelectRun: (id: string) => void }) {
  const [steering, setSteering] = useState('');
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const action = useAction();
  const running = activeRun(run);
  const paused = run.status === 'paused';
  const budgetWaiting = isCurrentBudgetWait(run);
  const events = workspace.activities.filter(item => item.runId === run.id).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const memories = workspace.memories.filter(item => item.sourceRunId === run.id);
  const skills = workspace.skills.filter(item => item.sourceRunId === run.id);
  const download = (item: Artifact) => { const url = URL.createObjectURL(new Blob([item.content], { type: item.mediaType || 'text/plain' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name.replace(/[\\/]/g, '_'); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <article className="run-detail"><div className="run-detail-heading"><div><span className="eyebrow">ASSIGNMENT</span><h2>{run.prompt}</h2></div><Status status={run.status} /></div><div className="run-metadata"><span><DateLabel value={run.createdAt} time /></span><span>v{run.agentVersion}</span>{run.kind ? <span>{{ task: '작업', review: '성장 비교', repair: '자동 재수정', environment: '환경 구축' }[run.kind]}</span> : null}</div>
    {run.error ? <ErrorNotice message={run.error} /> : null}
    <RunBudgetNotice run={run} workspace={workspace} />
    {run.continuedByRunId ? <p className="conversation-notice">검증된 환경에서 새 실행으로 이어졌습니다. <button className="text-link" onClick={() => onSelectRun(run.continuedByRunId!)}>이어진 실행 확인</button></p> : null}
    {run.continuedFromRunId ? <p className="conversation-notice">대표 요청 해결 후 기존 작업을 이어받았습니다. <button className="text-link" onClick={() => onSelectRun(run.continuedFromRunId!)}>원래 실행 확인</button></p> : null}
    {run.consultationOfRunId ? <p className="conversation-notice">대기 중인 작업의 별도 상담입니다. 원래 작업의 대기 조건과 완료 상태는 유지됩니다. <span className="mono">Run {run.consultationOfRunId.slice(0, 8)}</span></p> : null}
    {running && run.pauseRequestedAt && !paused ? <p className="conversation-notice" role="status">일시정지 요청됨 · 안전한 처리 경계까지 기다립니다.</p> : null}
    {paused ? <div className="conversation-notice"><p>사용자 일시정지 상태입니다. 진행 상태를 보존하며 직접 재개하기 전에는 이어가지 않습니다.</p><button className="button" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/runs/${run.id}/continue`, 'POST', {}); await refresh(); })}><Play size={13} />작업 재개</button></div> : null}
    {budgetWaiting ? <div className="model-budget-notice"><p role="status">모델 실행 예산이 부족하여 대기합니다. 진행 상태를 보존하며 예산이 허용되면 이어갑니다.</p><button className="button" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/runs/${run.id}/resume`, 'POST', {}); await refresh(); })}><Play size={13} />예산 대기 재개</button><p className="inline-note">이 작업의 재개를 요청합니다. 한도를 늘리지 않으며 예산이 부족하면 다시 대기합니다.</p></div> : null}
    {run.result ? <div className="run-result"><TextContent text={run.result} /></div> : running && !paused ? <div className="working-state"><LoaderCircle size={20} className="spin" /><span>{run.pauseRequestedAt ? '일시정지 처리 경계를 기다리고 있습니다.' : budgetWaiting ? '모델 실행 예산을 기다리고 있습니다.' : run.status === 'running' ? '작업을 진행하고 있습니다.' : '독립된 실행 환경을 준비하고 있습니다.'}</span></div> : <p className="muted result-empty">저장된 결과가 없습니다.</p>}
    <RunCheckpoints run={run} />
    {isLearningReviewRun(run) ? <LearningReviewView run={run} /> : null}
    {run.artifacts.length ? <div className="artifact-section"><h3>{run.consultationOfRunId ? '상담 첨부' : '결과물'} <span>{run.artifacts.length}</span></h3><div className="artifact-grid">{run.artifacts.map(item => <button className="artifact-card" key={item.id} onClick={() => setArtifact(item)}><FileText size={22} /><span>{item.name}<small>{item.mediaType}</small></span><ArrowRight size={15} /></button>)}</div></div> : null}
    {memories.length || skills.length ? <div className="growth-summary"><Sparkles size={18} /><div><strong>이 작업에서 남긴 경험</strong><p>기억 {memories.length}개 · 스킬 {skills.filter(skill => skill.status === 'active').length}개 적용{skills.some(skill => skill.status !== 'active') ? ` · 미적용 후보 ${skills.filter(skill => skill.status !== 'active').length}개` : ''}</p></div></div> : null}
    {events.length ? <details className="run-events" open={running}><summary>실행 기록 <span>{events.length}</span><ChevronDown size={14} /></summary><ol>{events.map(event => <li key={event.id}><i /><div><strong>{event.title}</strong>{event.detail ? <TextContent text={event.detail} /> : null}</div><DateLabel value={event.createdAt} time /></li>)}</ol></details> : null}
    {run.steering.length ? <details className="run-events"><summary>추가 지시 <span>{run.steering.length}</span><ChevronDown size={14} /></summary><ol>{run.steering.map((message, index) => <li key={index}><MessageSquarePlus size={14} /><TextContent text={message} /></li>)}</ol></details> : null}
    <UsageView attempts={(workspace.modelAttempts ?? []).filter(attempt => attempt.runId === run.id)} legacy={run} />
    {running && !paused && (!run.kind || run.kind === 'task') ? <button className="button" disabled={action.pending || !!run.pauseRequestedAt} onClick={() => void action.execute(async () => { await request(`/runs/${run.id}/pause`, 'POST', {}); await refresh(); })}><Pause size={13} />{run.pauseRequestedAt ? '일시정지 대기' : '작업 일시정지'}</button> : null}
    {running && run.kind !== 'review' && run.kind !== 'repair' && run.kind !== 'environment' ? <form className="steering-form" onSubmit={event => { event.preventDefault(); void action.execute(async () => { await request(`/runs/${run.id}/steer`, 'POST', { message: steering }); setSteering(''); await refresh(); }); }}><label className="sr-only" htmlFor="steering">추가 지시</label><input id="steering" value={steering} required maxLength={10000} onChange={event => setSteering(event.target.value)} placeholder="진행 중인 작업에 추가 지시" /><button className="icon-button" type="submit" aria-label="추가 지시 전달" disabled={action.pending || !steering.trim()}><Send size={17} /></button><button className="button danger-subtle" type="button" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/runs/${run.id}/cancel`, 'POST'); await refresh(); })}><Square size={13} />작업 취소</button><span className="steering-hint">현재 턴이 끝난 뒤 추가 지시를 반영합니다.</span></form> : null}
    {running && (run.kind === 'review' || run.kind === 'repair') ? <div className="steering-form"><p className="inline-note">비교 중에는 과제와 입력 조건을 고정합니다. 추가 지시는 일반 작업에서 전달할 수 있습니다.</p><button className="button danger-subtle" type="button" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/runs/${run.id}/cancel`, 'POST'); await refresh(); })}><Square size={13} />작업 취소</button></div> : null}
    {running && run.kind === 'environment' ? <div className="steering-form"><p className="inline-note">환경 구축 중에는 패키지·MCP 구성을 고정합니다. 변경안은 환경 탭에서 새 버전으로 작성합니다.</p><button className="button danger-subtle" type="button" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/runs/${run.id}/cancel`, 'POST'); await refresh(); })}><Square size={13} />구축 취소</button></div> : null}
    <ErrorNotice message={action.error} />
    {artifact ? <Modal title={artifact.name} eyebrow="ARTIFACT" onClose={() => setArtifact(null)} wide><TextContent text={artifact.content} className="artifact-preview mono" /><div className="modal-actions"><button className="button primary" onClick={() => download(artifact)}><Download size={16} />다운로드</button></div></Modal> : null}
  </article>;
}
