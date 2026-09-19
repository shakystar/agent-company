import { useRef, useState } from 'react';
import { ArrowRight, Check, FileText, FolderOpen, ListTodo, MessageSquare, Pencil, Plus, Send, Users } from 'lucide-react';
import type { Agent, Run, Workspace } from '../shared/types';
import type { CollaborationOperation, CollaborationScope, PeerMessage, Project, SharedArtifact, TeamTask } from '../shared/collaboration';
import { request, useAction } from './api';
import { DateLabel, Empty, ErrorNotice, Field, Modal, SectionTitle, Status, Submit, TextContent } from './ui';
import { SharedFiles } from './FileTransfer';
import type { Conversation } from '../shared/conversations';
import { ConversationWorkspace, conversationHref } from './ConversationView';
import { BudgetProjectSelect, BudgetTeamSelect, budgetTeamLabel, budgetTeamSelection } from './ModelBudgetView';
import { ArtifactPreviews } from './ArtifactPreviews';
import { operatorRequestHref } from './OperatorRequestsView';
import type { OperatorRequest } from '../shared/operator-requests';

type PanelProps = { scope: CollaborationScope; workspace: Workspace; refresh: () => Promise<void>; onSelect: (id: string) => void };
const sameScope = (left: CollaborationScope, right: CollaborationScope) => left.type === right.type && left.id === right.id;
const post = <T,>(operation: CollaborationOperation, args: unknown) => request<T>(`/collaboration/${operation}`, 'POST', args);
const agentName = (workspace: Workspace, id: string | null) => id === null ? '사용자' : workspace.agents.find(agent => agent.id === id)?.name ?? '구성원 제외됨';

function scopeMembers(workspace: Workspace, scope: CollaborationScope): Agent[] {
  const teamIds = scope.type === 'team' ? [scope.id] : workspace.projects?.find(project => project.id === scope.id)?.teamIds ?? [];
  const memberIds = new Set(workspace.teams.filter(team => teamIds.includes(team.id)).flatMap(team => team.memberIds));
  return workspace.agents.filter(agent => memberIds.has(agent.id));
}

export function CollaborationPanel(props: PanelProps) {
  const [tab, setTab] = useState<'conversations' | 'artifacts' | 'tasks' | 'messages'>('conversations');
  const tabs = [
    { id: 'conversations', label: '대화형 작업실', icon: MessageSquare },
    { id: 'artifacts', label: '공유 자료', icon: FileText },
    { id: 'tasks', label: '공동 작업판', icon: ListTodo },
    { id: 'messages', label: '직접 메시지', icon: MessageSquare },
  ] as const;
  return <div className="collaboration-panel"><div className="tabs collaboration-tabs" aria-label="협업 공간 보기">
    {tabs.map(item => <button key={item.id} aria-pressed={tab === item.id} className={tab === item.id ? 'active' : ''}
      onClick={() => setTab(item.id)}><item.icon size={16} />{item.label}</button>)}
  </div>
    {tab === 'conversations' ? <ConversationWorkspace scope={props.scope} workspace={props.workspace} refresh={props.refresh} onSelectAgent={props.onSelect} /> : null}
    {tab === 'artifacts' ? <><ArtifactPreviews key={`preview-${props.scope.type}-${props.scope.id}`} scope={props.scope} workspace={props.workspace} refresh={props.refresh} /><SharedArtifacts {...props} /><SharedFiles key={`${props.scope.type}-${props.scope.id}`} scope={props.scope} /></> : null}
    {tab === 'tasks' ? <TaskBoard {...props} /> : null}
    {tab === 'messages' ? <DirectMessages {...props} /> : null}
  </div>;
}

function SharedArtifacts({ workspace, scope, refresh }: PanelProps) {
  const [editing, setEditing] = useState<SharedArtifact | 'new' | null>(null);
  const [reading, setReading] = useState<SharedArtifact | null>(null);
  const artifacts = (workspace.sharedArtifacts ?? []).filter(item => sameScope(item.scope, scope));
  return <section aria-label="공유 자료"><SectionTitle title="공유 자료" detail="공개한 텍스트 자료와 변경 이력을 공유합니다."
    action={<button className="button" onClick={() => setEditing('new')}><Plus size={14} />자료 게시</button>} />
    {artifacts.length ? <div className="collaboration-list">{artifacts.map(artifact => <article className="collaboration-card" key={artifact.id}>
      <div className="collaboration-row"><FileText size={18} /><div className="collaboration-copy"><h3>{artifact.name}</h3>
        <p>{agentName(workspace, artifact.authorAgentId)} · v{artifact.version} · <DateLabel value={artifact.updatedAt} time /></p></div>
        <button className="button" onClick={() => setReading(artifact)} aria-label={`${artifact.name} 본문과 이력`}>본문·이력</button>
        <button className="icon-button" aria-label={`${artifact.name} 수정`} onClick={() => setEditing(artifact)}><Pencil size={15} /></button>
      </div></article>)}</div> : <Empty icon={<FileText size={24} />} title="공유한 자료가 없습니다" detail="개인 파일과 기억은 자동 공개되지 않습니다." />}
    {editing ? <ArtifactForm scope={scope} artifact={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)}
      onSaved={async () => { await refresh(); setEditing(null); }} /> : null}
    {reading ? <ArtifactReader artifact={reading} onClose={() => setReading(null)} /> : null}
  </section>;
}

function ArtifactForm({ scope, artifact, onClose, onSaved }: { scope: CollaborationScope; artifact?: SharedArtifact;
  onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(artifact?.name ?? '');
  const [content, setContent] = useState(artifact?.content ?? '');
  const action = useAction();
  return <Modal title={artifact ? '공유 자료 수정' : '공유 자료 게시'} onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
      await post('artifact_publish', { scope, name, content, mediaType: artifact?.mediaType ?? 'text/plain',
        ...(artifact ? { artifactId: artifact.id, expectedVersion: artifact.version } : {}) }); await onSaved();
    }); }}><Field label="자료 경로" hint="공간 안의 상대경로이며 실제 개인 파일을 자동 전송하지 않습니다.">
      <input required autoFocus={!artifact} maxLength={200} value={name} disabled={!!artifact || action.pending}
        placeholder="notes/result.md" onChange={event => setName(event.target.value)} /></Field>
      <Field label="본문" hint={artifact ? `v${artifact.version}을 기준으로 저장합니다. 다른 변경이 먼저 저장되면 충돌을 표시합니다.` : '공유할 내용을 직접 입력합니다.'}>
        <textarea rows={12} maxLength={64000} value={content} className="mono" disabled={action.pending}
          onChange={event => setContent(event.target.value)} /></Field><ErrorNotice message={action.error} />
      <div className="modal-actions"><button className="button subtle" type="button" disabled={action.pending} onClick={onClose}>취소</button>
        <Submit pending={action.pending}>{artifact ? '새 버전 저장' : '공유 자료 게시'}</Submit></div>
    </form>
  </Modal>;
}

function ArtifactReader({ artifact, onClose }: { artifact: SharedArtifact; onClose: () => void }) {
  const [requestedVersion, setRequestedVersion] = useState(artifact.version);
  const [displayed, setDisplayed] = useState({ version: artifact.version, content: artifact.content });
  const action = useAction();
  return <Modal title={artifact.name} eyebrow={`SHARED ARTIFACT · v${displayed.version}`} onClose={onClose} busy={action.pending} wide>
    <form className="collaboration-version" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
      setDisplayed(await post<{ version: number; content: string }>('artifact_read', { artifactId: artifact.id, version: requestedVersion }));
    }); }}><Field label="조회할 버전"><input type="number" required min={1} max={artifact.version} value={requestedVersion}
      disabled={action.pending} onChange={event => setRequestedVersion(Number(event.target.value))} /></Field>
      <Submit pending={action.pending}>버전 조회</Submit></form>
    <ErrorNotice message={action.error} /><TextContent text={displayed.content || '(빈 자료)'} className="collaboration-document" />
  </Modal>;
}

function TaskBoard(props: PanelProps) {
  const { workspace, scope, refresh } = props;
  const [creating, setCreating] = useState(false);
  const tasks = (workspace.teamTasks ?? []).filter(item => sameScope(item.scope, scope));
  const members = scopeMembers(workspace, scope);
  return <section aria-label="공동 작업판"><SectionTitle title="공동 작업판" detail="동료가 과제를 제안하고 맡은 작업의 결과를 남깁니다."
    action={<button className="button" onClick={() => setCreating(true)}><Plus size={14} />과제 제안</button>} />
    {tasks.length ? <div className="collaboration-list">{tasks.map(task => <TaskCard key={task.id} task={task} members={members} {...props} />)}</div>
      : <Empty icon={<ListTodo size={24} />} title="공동 과제가 없습니다" detail="과제를 제안하거나 에이전트에게 수행을 요청할 수 있습니다." />}
    {creating ? <TaskForm scope={scope} workspace={workspace} onClose={() => setCreating(false)} onSaved={async () => { await refresh(); setCreating(false); }} /> : null}
  </section>;
}

export function teamTaskRun(task: TeamTask, runs: Run[]): Run | undefined {
  return task.claimedRunId ? runs.find(run => run.id === task.claimedRunId)
    : runs.filter(run => run.teamTaskId === task.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
export function TaskCard({ task, members, workspace, scope, refresh, onSelect }: PanelProps & { task: TeamTask; members: Agent[] }) {
  const [agentId, setAgentId] = useState('');
  const [budgetProjectId, setBudgetProjectId] = useState('');
  const [teamChoice, setTeamChoice] = useState('');
  const action = useAction();
  const ready = workspace.runtime.available && workspace.runtime.authenticated;
  const selected = members.find(agent => agent.id === agentId);
  const run = teamTaskRun(task, workspace.runs);
  const inheritedProject = task.budgetProjectId !== undefined || !!task.budgetRootRunId;
  const inheritedTeam = task.budgetTeamId !== undefined || !!task.budgetRootRunId;
  const projectId = task.budgetProjectId !== undefined ? task.budgetProjectId : scope.type === 'project' ? scope.id : budgetProjectId || null;
  const teamId = inheritedTeam ? task.budgetTeamId : budgetTeamSelection(workspace, scope, projectId, teamChoice);
  const teamAllowed = inheritedTeam || teamId !== undefined;
  return <article className="collaboration-card"><div className="collaboration-row"><div className="collaboration-copy"><h3>{task.title}</h3>
    <p>{task.externalClient ? `외부 클라이언트 ${task.externalClient.label}` : agentName(workspace, task.createdByAgentId)}의 제안 · v{task.version}</p></div>
    <span className={`tag ${task.status === 'done' ? 'tag-green' : ''}`}>{task.status === 'open' ? '참여 가능' : task.status === 'claimed' ? '담당 중' : '완료'}</span></div>
    {task.description ? <TextContent text={task.description} className="collaboration-body" /> : null}
    {task.assigneeAgentId ? <div className="collaboration-meta"><button className="text-link" onClick={() => onSelect(task.assigneeAgentId!)}>
      담당 · {agentName(workspace, task.assigneeAgentId)}<ArrowRight size={12} /></button>{run ? <><Status status={run.status} /><span className="mono" title={run.id}>Run {run.id.slice(0, 8)}</span>
        {run.conversationId ? <a className="text-link" href={conversationHref(run.conversationId)}>연결 작업 대화</a>
          : <button className="text-link" onClick={() => onSelect(run.agentId)}>실행 에이전트 보기</button>}</>
        : task.claimedRunId ? <span className="muted">연결 실행을 확인하지 못했습니다.</span> : null}</div> : null}
    {task.outcome ? <div className="collaboration-outcome"><h4>결과</h4><TextContent text={task.outcome} /></div> : null}
    {task.artifactIds.length ? <div className="collaboration-meta">{task.artifactIds.map(id => <span className="tag" key={id}>
      <FileText size={12} />{workspace.sharedArtifacts?.find(item => item.id === id)?.name ?? id}</span>)}</div> : null}
    {task.status === 'open' ? <form className="collaboration-task-start" onSubmit={event => { event.preventDefault(); if (!teamAllowed) return; void action.execute(async () => {
      await request(`/team-tasks/${task.id}/run`, 'POST', { agentId, expectedVersion: task.version,
        ...(!inheritedProject ? { budgetProjectId: projectId } : {}), ...(!inheritedTeam ? { budgetTeamId: teamId } : {}) }); await refresh();
    }); }}><Field label="작업할 에이전트"><select required value={agentId} disabled={action.pending} onChange={event => setAgentId(event.target.value)}>
      <option value="">에이전트 선택</option>{members.map(agent => <option key={agent.id} value={agent.id} disabled={agent.status !== 'idle'}>
        {agent.name}{agent.status !== 'idle' ? ' · 다른 작업 중 또는 일시 정지' : ''}</option>)}</select></Field>
      {!inheritedProject ? <BudgetProjectSelect workspace={workspace} scope={scope} value={budgetProjectId} onChange={value => { setBudgetProjectId(value); setTeamChoice(''); }} disabled={action.pending} /> : <p className="inline-note">예산 귀속 · {task.budgetProjectId === null ? '프로젝트 없는 개인 작업' : workspace.projects?.find(project => project.id === task.budgetProjectId)?.name ?? '이전 프로젝트'} · 원래 과제를 이어갑니다.</p>}
      {inheritedTeam ? <p className="inline-note">팀 귀속 · {budgetTeamLabel(workspace, task.budgetTeamId)} · 원래 과제를 이어갑니다. 실제 실행 에이전트 한도를 함께 적용합니다.</p>
        : <BudgetTeamSelect workspace={workspace} scope={scope} projectId={projectId} value={teamChoice} onChange={setTeamChoice} disabled={action.pending} />}
      <button className="button primary" type="submit" disabled={action.pending || !selected || selected.status !== 'idle' || !ready || !teamAllowed}>
        {action.pending ? '시작 중' : '수행 요청·작업 시작'}</button>
      {!ready ? <small className="muted">실행 환경 연결 후 과제를 시작할 수 있습니다.</small> : null}
    </form> : null}<ErrorNotice message={action.error} />
  </article>;
}

export function TaskForm({ scope, workspace, onClose, onSaved }: { scope: CollaborationScope; workspace: Workspace; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const action = useAction();
  const [budgetProjectId, setBudgetProjectId] = useState('');
  const [teamChoice, setTeamChoice] = useState('');
  const projectId = scope.type === 'project' ? scope.id : budgetProjectId || null;
  const teamId = budgetTeamSelection(workspace, scope, projectId, teamChoice);
  return <Modal title="공동 과제 제안" onClose={onClose} busy={action.pending}><form className="form-stack" onSubmit={event => {
    event.preventDefault(); if (teamId === undefined) return;
    void action.execute(async () => { await post('task_create', { scope, title, description, budgetProjectId: projectId, budgetTeamId: teamId }); await onSaved(); });
  }}><Field label="과제 이름"><input required autoFocus maxLength={200} value={title} disabled={action.pending}
    onChange={event => setTitle(event.target.value)} /></Field><Field label="목적·완료 조건"><textarea rows={7} maxLength={8000}
      value={description} disabled={action.pending} onChange={event => setDescription(event.target.value)} /></Field>
    <BudgetProjectSelect workspace={workspace} scope={scope} value={budgetProjectId} onChange={value => { setBudgetProjectId(value); setTeamChoice(''); }} disabled={action.pending} />
    <BudgetTeamSelect workspace={workspace} scope={scope} projectId={projectId} value={teamChoice} onChange={setTeamChoice} disabled={action.pending} />
    <ErrorNotice message={action.error} /><div className="modal-actions"><button type="button" className="button subtle" onClick={onClose} disabled={action.pending}>취소</button>
      <button className="button primary" type="submit" disabled={action.pending || teamId === undefined}>{action.pending ? '저장 중' : '과제 게시'}</button></div></form></Modal>;
}

function DirectMessages(props: PanelProps) {
  const { workspace, scope, refresh } = props;
  const [composing, setComposing] = useState<PeerMessage | 'new' | null>(null);
  const [threadId, setThreadId] = useState('');
  const messages = (workspace.messages ?? []).filter(item => sameScope(item.scope, scope));
  const visible = threadId ? messages.filter(item => item.threadId === threadId) : messages;
  const members = scopeMembers(workspace, scope);
  return <section aria-label="직접 메시지"><SectionTitle title="직접 메시지" detail="사용자 명의로 전송합니다. 에이전트 간 대화도 이곳에서 확인합니다."
    action={<button className="button" disabled={!members.length} onClick={() => setComposing('new')}><Plus size={14} />새 메시지</button>} />
    {threadId ? <div className="collaboration-filter"><span>선택한 대화</span><button className="text-link" onClick={() => setThreadId('')}>모든 대화 보기</button></div> : null}
    {!workspace.runtime.available || !workspace.runtime.authenticated ? <p className="inline-note">메시지는 저장되며 실행 환경이 연결되면 에이전트 작업이 시작됩니다.</p> : null}
    {visible.length ? <div className="collaboration-list">{visible.map(message => <MessageCard key={message.id} message={message} {...props}
      onThread={() => setThreadId(message.threadId)} onReply={() => setComposing(message)} />)}</div>
      : <Empty icon={<MessageSquare size={24} />} title="아직 메시지가 없습니다" detail="메시지의 수신 확인과 과제 완료는 별도로 기록합니다." />}
    {composing ? <MessageForm scope={scope} workspace={workspace} members={members} reply={composing === 'new' ? undefined : composing}
      onClose={() => setComposing(null)} onSaved={async () => { await refresh(); setComposing(null); }} /> : null}
  </section>;
}

export function MessageCard({ message, workspace, refresh, onSelect, onReply, onThread }: PanelProps & {
  message: PeerMessage; onReply: () => void; onThread: () => void;
}) {
  const action = useAction();
  const joinKey = useRef<string | null>(null);
  const run = workspace.runs.find(item => item.messageIds?.includes(message.id));
  const task = workspace.teamTasks?.find(item => item.id === message.taskId);
  const operatorRequest = workspace.operatorRequests?.find(item => item.links.messageId === message.id);
  return <article className={`collaboration-card message-card ${message.senderAgentId === null ? 'message-from-user' : ''}`}>
    <div className="collaboration-row"><div className="collaboration-copy"><h3>{agentName(workspace, message.senderAgentId)}<ArrowRight size={13} />{agentName(workspace, message.recipientAgentId)}</h3>
      <p><DateLabel value={message.createdAt} time />{message.replyToId ? ' · 답장' : ''}</p></div>
      <span className={`tag ${message.status === 'completed' ? 'tag-green' : message.status === 'pending' ? 'tag-amber' : ''}`}>
        {message.status === 'pending' ? '수신 확인 전' : message.status === 'delivered' ? '수신 확인' : '처리 완료'}</span></div>
    <TextContent text={message.content} className="collaboration-body" />
    {task ? <p className="collaboration-meta">관련 과제 · {task.title}</p> : null}
    {message.artifactIds.length ? <div className="collaboration-meta">{message.artifactIds.map(id => <span className="tag" key={id}>
      <FileText size={12} />{workspace.sharedArtifacts?.find(item => item.id === id)?.name ?? id}</span>)}</div> : null}
    <div className="collaboration-message-actions"><button className="text-link" onClick={onThread}>대화 모아보기</button>
      <button className="button" disabled={action.pending} onClick={() => void action.execute(async () => {
        const existing = workspace.conversations?.find(conversation => conversation.legacyThreadId === message.threadId && conversation.scope.type === message.scope.type && conversation.scope.id === message.scope.id);
        joinKey.current ??= crypto.randomUUID();
        const conversation = existing ?? await request<Conversation>('/conversations', 'POST', { scope: message.scope,
          legacyThreadId: message.threadId, title: `${agentName(workspace, message.senderAgentId)}의 동료 대화`, idempotencyKey: joinKey.current });
        await refresh(); window.location.hash = conversationHref(conversation.id);
      })}><MessageSquare size={13} />대화 참여</button>
      {run ? <button className="text-link" onClick={() => onSelect(run.agentId)}>실행 보기 <Status status={run.status} /></button>
        : message.recipientAgentId !== null && message.status !== 'completed' ? <small className="muted">작업 시작 대기</small> : null}
      {message.recipientAgentId === null ? <>
        {message.status === 'pending' ? <button className="button" disabled={action.pending} onClick={() => void action.execute(async () => {
          await post('message_acknowledge', { messageId: message.id }); await refresh();
        })}>수신 확인</button> : null}
        {message.status !== 'completed' ? <button className="button" disabled={action.pending} onClick={() => void action.execute(async () => {
          await post('message_complete', { messageId: message.id }); await refresh();
        })}><Check size={13} />처리 완료</button> : null}
        <button className="button" onClick={onReply}>사용자 답장</button>
        {message.senderAgentId !== null ? operatorRequest ? <a className="text-link" href={operatorRequestHref(operatorRequest.id)}>연결된 대표 요청</a>
          : <button className="button" disabled={action.pending} onClick={() => void action.execute(async () => {
            const created = await request<OperatorRequest>('/operator-requests/from-message', 'POST', { messageId: message.id });
            await refresh(); window.location.hash = operatorRequestHref(created.id);
          })}>대표 요청으로 등록</button> : null}
      </> : null}</div><ErrorNotice message={action.error} />
  </article>;
}

export function MessageForm({ scope, workspace, members, reply, onClose, onSaved }: { scope: CollaborationScope; workspace: Workspace;
  members: Agent[]; reply?: PeerMessage; onClose: () => void; onSaved: () => Promise<void> }) {
  const [recipient, setRecipient] = useState(reply?.senderAgentId ?? '');
  const [content, setContent] = useState('');
  const [budgetProjectId, setBudgetProjectId] = useState('');
  const [teamChoice, setTeamChoice] = useState('');
  const projectId = scope.type === 'project' ? scope.id : budgetProjectId || null;
  const teamId = reply ? reply.budgetTeamId : budgetTeamSelection(workspace, scope, projectId, teamChoice);
  const teamAllowed = !!reply || teamId !== undefined;
  const lastSubmission = useRef<{ payload: string; key: string } | null>(null);
  const action = useAction();
  const ready = workspace.runtime.available && workspace.runtime.authenticated;
  const allowed = members.some(agent => agent.id === recipient);
  return <Modal title={reply ? '사용자 답장' : '사용자 메시지'} onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); if (!teamAllowed) return; void action.execute(async () => {
      const body = { scope, recipientAgentId: recipient, content, ...(reply ? { replyToId: reply.id }
        : { budgetProjectId: projectId, budgetTeamId: teamId }) };
      const payload = JSON.stringify(body);
      if (lastSubmission.current?.payload !== payload) lastSubmission.current = { payload, key: crypto.randomUUID() };
      await post('message_send', { ...body, idempotencyKey: lastSubmission.current.key }); await onSaved();
    }); }}><p className="inline-note"><Send size={15} />발신자는 사용자입니다. 전송하면 받는 에이전트의 독립 작업이 시작되거나 실행 가능한 시점까지 대기합니다.</p>
      <Field label="받는 에이전트"><select required value={recipient} disabled={!!reply || action.pending} onChange={event => setRecipient(event.target.value)}>
        <option value="">에이전트 선택</option>{members.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
      {reply && !allowed ? <ErrorNotice message="원 발신자가 현재 공유 공간의 구성원이 아니므로 답장을 전송할 수 없습니다." /> : null}
      <Field label="메시지"><textarea required autoFocus rows={8} maxLength={8000} value={content} disabled={action.pending}
        onChange={event => setContent(event.target.value)} /></Field>
      {reply ? <p className="inline-note">원래 메시지의 예산 귀속을 이어갑니다. 팀 귀속 · {budgetTeamLabel(workspace, reply.budgetTeamId)} · 실제 실행 에이전트 한도를 함께 적용합니다.</p>
        : <><BudgetProjectSelect workspace={workspace} scope={scope} value={budgetProjectId} onChange={value => { setBudgetProjectId(value); setTeamChoice(''); }} disabled={action.pending} />
          <BudgetTeamSelect workspace={workspace} scope={scope} projectId={projectId} value={teamChoice} onChange={setTeamChoice} disabled={action.pending} /></>}
      {!ready ? <p className="inline-note">현재는 실행 환경 미연결 상태입니다. 저장 후 연결을 기다립니다.</p> : null}
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" disabled={action.pending} onClick={onClose}>취소</button>
        <button className="button primary" type="submit" disabled={action.pending || !allowed || !content.trim() || !teamAllowed}><Send size={14} />
          {action.pending ? '전송 중' : ready ? '전송·작업 시작' : '전송·연결 대기'}</button></div>
    </form>
  </Modal>;
}

export function ProjectsView({ workspace, refresh, onSelect }: Omit<PanelProps, 'scope'>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const projects = workspace.projects ?? [];
  const selected = projects.find(project => project.id === selectedId) ?? projects[0];
  return <><div className="page-heading"><div><span className="eyebrow">SHARED PURPOSE</span><h1>프로젝트 공간</h1>
    <p>여러 팀이 공동 자료와 과제를 함께 다룹니다.</p></div><button className="button primary" disabled={!workspace.teams.length}
      onClick={() => setEditing('new')}><Plus size={16} />프로젝트 만들기</button></div>
    {selected ? <div className="teams-layout"><aside className="team-list" aria-label="프로젝트 선택">{projects.map(project =>
      <button className={`team-list-item ${project.id === selected.id ? 'selected' : ''}`} key={project.id} onClick={() => setSelectedId(project.id)}>
        <span className="team-symbol"><FolderOpen size={20} /></span><span><strong>{project.name}</strong><small>{project.teamIds.length}개 팀 참여</small></span></button>)}</aside>
      <section className="team-detail panel"><div className="team-heading"><div><span className="eyebrow">PROJECT · v{selected.version}</span><h2>{selected.name}</h2>
        <p>{selected.description}</p></div><button className="button" onClick={() => setEditing(selected)}><Pencil size={14} />편집</button></div>
        <div className="collaboration-project-teams">{selected.teamIds.length ? selected.teamIds.map(id => <span className="tag" key={id}><Users size={13} />
          {workspace.teams.find(team => team.id === id)?.name ?? '제외된 팀'}</span>) : <p className="muted">참여 팀이 없습니다.</p>}</div>
        <p className="inline-note">참여 팀의 현재 구성원에게 이 공간의 자료와 협업 도구 접근이 허용됩니다. 개인 기억과 파일은 공개되지 않습니다.</p>
        <CollaborationPanel key={selected.id} scope={{ type: 'project', id: selected.id }} workspace={workspace} refresh={refresh} onSelect={onSelect} />
      </section></div> : <div className="panel"><Empty icon={<FolderOpen size={26} />} title="공동 프로젝트 공간이 없습니다"
        detail={workspace.teams.length ? '참여 팀을 선택하면 팀 사이의 협업 공간을 만들 수 있습니다.' : '팀을 구성한 뒤 프로젝트 공간에 참여시킬 수 있습니다.'} /></div>}
    {editing ? <ProjectForm project={editing === 'new' ? undefined : editing} workspace={workspace} onClose={() => setEditing(null)}
      onSaved={async project => { await refresh(); setSelectedId(project.id); setEditing(null); }} /> : null}
  </>;
}

function ProjectForm({ project, workspace, onClose, onSaved }: { project?: Project; workspace: Workspace; onClose: () => void;
  onSaved: (project: Project) => Promise<void> }) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [teamIds, setTeamIds] = useState(project?.teamIds ?? []);
  const action = useAction();
  return <Modal title={project ? '프로젝트 공간 편집' : '새 프로젝트 공간'} onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
      const saved = await post<Project>(project ? 'project_update' : 'project_create', { name, description, teamIds,
        ...(project ? { projectId: project.id, expectedVersion: project.version } : {}) }); await onSaved(saved);
    }); }}><Field label="프로젝트 이름"><input required autoFocus maxLength={120} value={name} disabled={action.pending}
      onChange={event => setName(event.target.value)} /></Field><Field label="공동 목적·설명"><textarea rows={5} maxLength={8000}
        value={description} disabled={action.pending} onChange={event => setDescription(event.target.value)} /></Field>
      <fieldset className="collaboration-team-picker"><legend>접근을 허용할 팀</legend><div className="member-picker">{workspace.teams.map(team =>
        <label className={teamIds.includes(team.id) ? 'selected' : ''} key={team.id}><input type="checkbox" checked={teamIds.includes(team.id)}
          disabled={action.pending} onChange={event => { const checked = event.target.checked;
            setTeamIds(current => checked ? [...current, team.id] : current.filter(id => id !== team.id)); }} /><Users size={14} />{team.name}</label>)}</div></fieldset>
      <p className="inline-note">선택한 팀 사이에 이 프로젝트의 자료와 협업 권한을 공유합니다. 이 설정은 사용자의 직접 승인으로 저장됩니다.</p>
      <ErrorNotice message={action.error} /><div className="modal-actions"><button type="button" className="button subtle" disabled={action.pending} onClick={onClose}>취소</button>
        <Submit pending={action.pending}>{project ? '변경 저장' : '프로젝트 생성'}</Submit></div>
    </form>
  </Modal>;
}
