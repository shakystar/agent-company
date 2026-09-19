import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, Download, FileText, Link, LoaderCircle, MessageSquare, Pause, Play, Plus, Reply, Send, Square, Users, X } from 'lucide-react';
import type { Agent, Artifact, Run, Workspace } from '../shared/types';
import type { Conversation, ConversationDelivery, ConversationMessage, ConversationMode, ConversationScope } from '../shared/conversations';
import { request, useAction } from './api';
import { Avatar, DateLabel, Empty, ErrorNotice, Field, SectionTitle, Status, TextContent } from './ui';
import { UsageView } from './UsageView';
import { WorkspaceFiles } from './WorkspaceFiles';
import { SharedFiles } from './FileTransfer';
import { BrowserEvidence } from './BrowserEvidence';
import { ArtifactPreviews } from './ArtifactPreviews';
import { BudgetProjectSelect, BudgetTeamSelect, RunBudgetNotice, budgetProjects, budgetTeamLabel, budgetTeamSelection, isCurrentBudgetWait } from './ModelBudgetView';
import { RunCheckpoints } from './RunCheckpoints';

type Props = { workspace: Workspace; refresh: () => Promise<void>; onSelectAgent: (id: string) => void;
  scope?: ConversationScope; conversationId?: string | null };
export type ConversationDraft = { content: string; mode: ConversationMode; recipientAgentId: string; replyToId: string };
const emptyDraft = (): ConversationDraft => ({ content: '', mode: 'auto', recipientAgentId: '', replyToId: '' });
const openRun = (run: Run) => ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status);
const sameScope = (a: ConversationScope, b: ConversationScope) => a.type === b.type && a.id === b.id;
const speaker = (workspace: Workspace, id: string | null) => id === null ? '사용자' : workspace.agents.find(agent => agent.id === id)?.name ?? '이전 구성원';
export const conversationHref = (id: string) => `#conversation/${encodeURIComponent(id)}`;
export function conversationLocation(hash: string): { id: string | null } | null {
  if (hash === '#conversations') return { id: null };
  const match = /^#conversation\/([a-zA-Z0-9-]+)$/.exec(hash);
  return match ? { id: match[1] } : null;
}
export function conversationMembers(workspace: Workspace, scope: ConversationScope): Agent[] {
  if (scope.type === 'agent') return workspace.agents.filter(agent => agent.id === scope.id);
  const teams = scope.type === 'team' ? [scope.id] : workspace.projects?.find(project => project.id === scope.id)?.teamIds ?? [];
  const ids = new Set(workspace.teams.filter(team => teams.includes(team.id)).flatMap(team => team.memberIds));
  return workspace.agents.filter(agent => ids.has(agent.id));
}
export function scopeTitle(workspace: Workspace, scope: ConversationScope): string {
  if (scope.type === 'agent') return workspace.agents.find(agent => agent.id === scope.id)?.name ?? '이전 에이전트';
  if (scope.type === 'team') return workspace.teams.find(team => team.id === scope.id)?.name ?? '이전 팀';
  return workspace.projects?.find(project => project.id === scope.id)?.name ?? '이전 프로젝트';
}
export const deliveryLabel = (delivery: ConversationDelivery) => ({ pending: '전달 대기', delivered: '입력 전달됨',
  applied: '반영됨', answered: '응답 완료', cancelled: '전달 취소' })[delivery.status];
export function conversationRuns(workspace: Workspace, messages: ConversationMessage[]): Run[] {
  const ids = new Set(messages.flatMap(message => [message.sourceRunId, ...message.deliveries.map(delivery => delivery.runId)]).filter(Boolean));
  return workspace.runs.filter(run => ids.has(run.id)).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function conversationRunTitle(run: Run, workspace: Workspace): string {
  return workspace.conversationMessages?.find(message => message.id === run.conversationMessageId
    && (!run.conversationId || message.conversationId === run.conversationId))?.content ?? run.prompt;
}
export function conversationSubmission(draft: ConversationDraft) {
  return { content: draft.content.trim(), mode: draft.mode,
    ...(draft.recipientAgentId ? { recipientAgentId: draft.recipientAgentId } : {}), ...(draft.replyToId ? { replyToId: draft.replyToId } : {}) };
}
export function parseConversationDraft(value: unknown): ConversationDraft {
  if (!value || typeof value !== 'object') return emptyDraft();
  const draft = value as Partial<ConversationDraft>;
  return { content: typeof draft.content === 'string' ? draft.content.slice(0, 20_000) : '',
    mode: draft.mode === 'task' || draft.mode === 'discuss' ? draft.mode : 'auto',
    recipientAgentId: typeof draft.recipientAgentId === 'string' ? draft.recipientAgentId : '',
    replyToId: typeof draft.replyToId === 'string' ? draft.replyToId : '' };
}
function loadDraft(id: string) {
  try { return typeof window === 'undefined' ? emptyDraft() : parseConversationDraft(JSON.parse(window.sessionStorage.getItem(`conversation-draft:v1:${id}`) ?? 'null')); }
  catch { return emptyDraft(); }
}
function loadSubmission(id: string): { payload: string; key: string } | null {
  try {
    if (typeof window === 'undefined') return null;
    const value: unknown = JSON.parse(window.sessionStorage.getItem(`conversation-submit:v1:${id}`) ?? 'null');
    if (value && typeof value === 'object' && 'payload' in value && 'key' in value && typeof value.payload === 'string' && typeof value.key === 'string') {
      return { payload: value.payload, key: value.key };
    }
  } catch { /* The current mounted composer still deduplicates requests. */ }
  return null;
}

export function ConversationWorkspace({ workspace, refresh, onSelectAgent, scope, conversationId }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(() => (workspace.conversations ?? []).filter(item => !scope || sameScope(item.scope, scope))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const conversations = (workspace.conversations ?? []).filter(item => !scope || sameScope(item.scope, scope))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const requestedId = conversationId ?? selectedId;
  const selected = requestedId ? conversations.find(item => item.id === requestedId) : conversations[0];
  const missing = !!requestedId && !selected;
  const create = creating || (!conversations.length && !missing);
  return <section className="conversation-workspace" aria-label="대화형 작업실">
    <SectionTitle title={scope ? '함께하는 대화' : '대화 목록'} detail="같은 작업의 메시지·응답·결과를 이어갑니다."
      action={<button className="button" onClick={() => setCreating(current => !current)}><Plus size={15} />새 대화</button>} />
    {create ? <NewConversation key={scope ? `${scope.type}:${scope.id}` : 'all'} workspace={workspace} scope={scope}
      onClose={() => setCreating(false)} onSaved={async conversation => { await refresh(); setCreating(false); setSelectedId(conversation.id);
        if (conversationId) window.location.hash = conversationHref(conversation.id); }} /> : null}
    {conversations.length ? <nav className="conversation-list" aria-label="대화 선택">{conversations.map(conversation =>
      <a key={conversation.id} className={selected?.id === conversation.id ? 'selected' : ''} href={conversationHref(conversation.id)}
        aria-current={selected?.id === conversation.id ? 'page' : undefined} onClick={event => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (scope) { event.preventDefault(); setSelectedId(conversation.id); setCreating(false); }
        }}><MessageSquare size={16} /><span><strong>{conversation.title}</strong><small>{scopeTitle(workspace, conversation.scope)} · <DateLabel value={conversation.updatedAt} /></small></span></a>)}</nav> : null}
    {missing ? <Empty icon={<MessageSquare size={25} />} title="대화를 찾지 못했습니다" detail="현재 작업실에 이 ID의 대화가 없습니다. 다른 대화나 현재 연결 상태를 확인할 수 있습니다."
      action={<a className="button" href="#conversations">대화 목록</a>} /> : selected ?
      <ConversationView key={selected.id} conversation={selected} workspace={workspace} refresh={refresh} onSelectAgent={onSelectAgent} /> : null}
  </section>;
}

function NewConversation({ workspace, scope, onClose, onSaved }: { workspace: Workspace; scope?: ConversationScope;
  onClose: () => void; onSaved: (conversation: Conversation) => Promise<void> }) {
  const [target, setTarget] = useState(scope ? `${scope.type}:${scope.id}` : '');
  const [title, setTitle] = useState('');
  const [budgetProjectId, setBudgetProjectId] = useState('');
  const [teamChoice, setTeamChoice] = useState('');
  const action = useAction();
  const last = useRef<{ payload: string; key: string } | null>(null);
  const options = [...workspace.agents.map(agent => ({ value: `agent:${agent.id}`, label: `개인 · ${agent.name}` })),
    ...workspace.teams.map(team => ({ value: `team:${team.id}`, label: `팀 · ${team.name}` })),
    ...(workspace.projects ?? []).map(project => ({ value: `project:${project.id}`, label: `프로젝트 · ${project.name}` }))];
  const chosen = options.find(option => option.value === target);
  const [scopeType, scopeId] = target.split(':');
  const targetScope: ConversationScope | null = chosen ? { type: scopeType as ConversationScope['type'], id: scopeId } : null;
  const attributionAllowed = !budgetProjectId || !!targetScope && budgetProjects(workspace, targetScope).some(project => project.id === budgetProjectId);
  const projectId = targetScope?.type === 'project' ? targetScope.id : budgetProjectId || null;
  const teamId = targetScope ? budgetTeamSelection(workspace, targetScope, projectId, teamChoice) : undefined;
  return <form className="conversation-new form-stack" onSubmit={event => { event.preventDefault(); if (!chosen || !attributionAllowed || teamId === undefined) return;
    void action.execute(async () => { const [type, id] = target.split(':');
      const body = { scope: { type, id }, title: title.trim() || `${chosen.label.replace(/^.* · /, '')} 대화`,
        budgetProjectId: projectId, budgetTeamId: teamId };
      const payload = JSON.stringify(body);
      if (last.current?.payload !== payload) last.current = { payload, key: crypto.randomUUID() };
      const conversation = await request<Conversation>('/conversations', 'POST', { ...body, idempotencyKey: last.current.key });
      await onSaved(conversation);
    }); }}>
    <div className="form-columns"><Field label="대화 공간"><select value={target} required disabled={!!scope || action.pending} onChange={event => { setTarget(event.target.value); setBudgetProjectId(''); setTeamChoice(''); }}>
      <option value="">에이전트·팀·프로젝트 선택</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></Field><Field label="대화 제목"><input value={title} maxLength={160} disabled={action.pending} onChange={event => setTitle(event.target.value)} placeholder="새 과제 또는 이어갈 논의" /></Field></div>
    {targetScope ? <><BudgetProjectSelect workspace={workspace} scope={targetScope} value={budgetProjectId} onChange={value => { setBudgetProjectId(value); setTeamChoice(''); }} disabled={action.pending} />
      <BudgetTeamSelect workspace={workspace} scope={targetScope} projectId={projectId} value={teamChoice} onChange={setTeamChoice} disabled={action.pending} /></> : null}
    {!attributionAllowed ? <ErrorNotice message="선택한 프로젝트가 현재 대화 공간에 연결돼 있지 않습니다. 예산 귀속 선택을 확인할 수 있습니다." /> : null}
    <p className="inline-note">대화 생성만으로 모델을 실행하지 않습니다. 현재 공간의 에이전트가 참여하며 개인 기억은 공개되지 않습니다.</p>
    <ErrorNotice message={action.error} /><div className="conversation-new-actions"><button type="button" className="button subtle" onClick={onClose} disabled={action.pending}>닫기</button>
      <button type="submit" className="button primary" disabled={action.pending || !chosen || !attributionAllowed || teamId === undefined}>{action.pending ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}대화 만들기</button></div>
  </form>;
}

export function ConversationView({ conversation, workspace, refresh, onSelectAgent }: { conversation: Conversation; workspace: Workspace;
  refresh: () => Promise<void>; onSelectAgent: (id: string) => void }) {
  const [draft, setDraft] = useState<ConversationDraft>(() => loadDraft(conversation.id));
  const messages = (workspace.conversationMessages ?? []).filter(message => message.conversationId === conversation.id)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const members = conversationMembers(workspace, conversation.scope).filter(agent => conversation.participantAgentIds.includes(agent.id));
  const runs = conversationRuns(workspace, messages);
  const active = runs.filter(openRun);
  const composer = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [unread, setUnread] = useState(false);
  const latest = messages.at(-1);
  useEffect(() => {
    try {
      if (draft.content || draft.replyToId) window.sessionStorage.setItem(`conversation-draft:v1:${conversation.id}`, JSON.stringify(draft));
      else window.sessionStorage.removeItem(`conversation-draft:v1:${conversation.id}`);
    } catch { /* An unavailable browser store does not discard the in-memory draft. */ }
  }, [conversation.id, draft.content, draft.mode, draft.recipientAgentId, draft.replyToId]);
  useEffect(() => {
    if (followLatest.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
    else setUnread(true);
  }, [latest?.id]);
  const reply = (message: ConversationMessage) => { setDraft(current => ({ ...current, replyToId: message.id,
    recipientAgentId: message.senderAgentId && members.some(member => member.id === message.senderAgentId) ? message.senderAgentId : '' })); composer.current?.focus(); };
  return <div className="conversation-room">
    <header className="conversation-heading"><div><span className="eyebrow">{conversation.scope.type === 'agent' ? 'PERSONAL CONVERSATION' : 'PEER CONVERSATION'}</span>
      <h2>{conversation.title}</h2><p>{scopeTitle(workspace, conversation.scope)} · 사용자와 {members.length}명의 에이전트</p>
      {conversation.budgetProjectId !== undefined ? <p>예산 귀속 · {conversation.budgetProjectId === null ? '프로젝트 없는 개인 작업' : workspace.projects?.find(project => project.id === conversation.budgetProjectId)?.name ?? '이전 프로젝트'} · {budgetTeamLabel(workspace, conversation.budgetTeamId)} · 실제 실행 에이전트 한도 함께 적용</p> : null}</div>
      <a className="button subtle" href={conversationHref(conversation.id)} title="이 대화의 고유 주소"><Link size={14} />대화 링크</a></header>
    <div className="conversation-members">{members.map(agent => <button key={agent.id} onClick={() => onSelectAgent(agent.id)}><Avatar agent={agent} size="small" />{agent.name}<Status status={agent.status} /></button>)}</div>
    {!members.length ? <ErrorNotice message="현재 참여 가능한 에이전트가 없습니다. 기존 대화 기록은 보존됩니다." /> : null}
    <p className="sr-only" role="status" aria-live="polite">{messages.length}개의 메시지{latest ? ` · 마지막 발신자 ${speaker(workspace, latest.senderAgentId)}` : ''}</p>
    <div ref={timeline} className="conversation-timeline" aria-label="실제 작업 대화 기록" tabIndex={0} onScroll={event => {
      const element = event.currentTarget; followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      if (followLatest.current) setUnread(false);
    }}>
      {messages.length ? <ol>{messages.map(message => <li key={message.id}><ConversationMessageCard message={message} messages={messages}
        workspace={workspace} onReply={() => reply(message)} /></li>)}</ol> : <Empty icon={<MessageSquare size={27} />} title="이 대화에서 시작합니다"
        detail="질문과 기획 상담, 작업 지시를 같은 에이전트와 이어갑니다." />}
    </div>
    {unread ? <button className="conversation-latest button subtle" onClick={() => {
      if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; followLatest.current = true; setUnread(false);
    }}>새 메시지 확인</button> : null}
    {active.length ? <section className="conversation-active" aria-label="진행 중인 연결 작업"><h3>진행 중인 작업 <span>{active.length}</span></h3>
      {active.map(run => <ConversationRun key={run.id} run={run} workspace={workspace} refresh={refresh} />)}</section> : null}
    <ConversationComposer key={conversation.id} conversation={conversation} workspace={workspace} members={members} messages={messages}
      draft={draft} setDraft={setDraft} textareaRef={composer} refresh={refresh} />
    <BrowserEvidence workspace={workspace} conversationId={conversation.id} />
    {conversation.scope.type !== 'agent' ? <ArtifactPreviews key={`preview-${conversation.scope.type}-${conversation.scope.id}`} workspace={workspace}
      scope={{ type: conversation.scope.type, id: conversation.scope.id }} refresh={refresh} conversationId={conversation.id} /> : null}
    {runs.some(run => !openRun(run)) ? <section className="conversation-results" aria-label="대화의 결과와 실행 기록"><h3>결과·파일·실행 기록</h3>
      {runs.filter(run => !openRun(run)).map(run => <ConversationRun key={run.id} run={run} workspace={workspace} refresh={refresh} />)}</section> : null}
    <ConversationFiles conversation={conversation} workspace={workspace} members={members} refresh={refresh} />
  </div>;
}

export function ConversationMessageCard({ message, messages, workspace, onReply }: { message: ConversationMessage; messages: ConversationMessage[];
  workspace: Workspace; onReply: () => void }) {
  const agent = workspace.agents.find(item => item.id === message.senderAgentId);
  const parent = messages.find(item => item.id === message.replyToId);
  return <article id={`message-${message.id}`} className={`conversation-message ${message.senderAgentId === null ? 'from-user' : 'from-agent'}`}>
    <div className="conversation-message-heading">{agent ? <Avatar agent={agent} size="small" /> : <span className="conversation-user-icon"><Users size={15} /></span>}
      <strong>{speaker(workspace, message.senderAgentId)}</strong><span className="tag">{message.senderAgentId === null ? '사용자' : '실제 에이전트'}</span><DateLabel value={message.createdAt} time /></div>
    {message.replyToId ? <a className="conversation-reply-context" href={`#message-${message.replyToId}`} onClick={event => {
      event.preventDefault(); const element = document.getElementById(`message-${message.replyToId}`); if (element) element.scrollIntoView({ block: 'center' });
    }}><Reply size={12} />{parent ? `${speaker(workspace, parent.senderAgentId)}: ${parent.content.slice(0, 140)}` : '이전 메시지에 대한 답장'}</a> : null}
    <TextContent text={message.content} className="conversation-message-body" />
    <div className="conversation-message-footer"><span>{message.recordOnly ? '기록만' : { auto: '자동 판단', discuss: '상담', task: '작업 지시' }[message.mode]}</span>
      {message.sourcePeerMessageId ? <span>기존 동료 대화 연결</span> : null}
      {message.consultationOfRunId ? <span>별도 상담 답변 · 원래 작업 대기 유지</span> : null}
      {message.sourceRunId ? <a href={`#conversation-run-${message.sourceRunId}`} onClick={event => {
        event.preventDefault(); const element = document.getElementById(`conversation-run-${message.sourceRunId}`); if (element) { (element as HTMLDetailsElement).open = true; element.scrollIntoView({ block: 'nearest' }); }
      }}>연결 실행 <ArrowUpRight size={12} /></a> : null}<button className="text-link" onClick={onReply}><Reply size={13} />답장</button></div>
    {message.deliveries.length ? <ul className="conversation-deliveries" aria-label="에이전트별 전달 상태">{message.deliveries.map((delivery, index) =>
      <li key={`${delivery.agentId}:${delivery.runId}:${index}`}><span>{speaker(workspace, delivery.agentId)}</span><span className={`delivery-status delivery-${delivery.status}`}>
        {delivery.status === 'answered' || delivery.status === 'applied' ? <Check size={12} /> : null}{deliveryLabel(delivery)}</span>
        {delivery.runId ? <span className="mono" title={delivery.runId}>Run {delivery.runId.slice(0, 8)}</span> : null}
      </li>)}</ul> : null}
  </article>;
}

function ConversationComposer({ conversation, workspace, members, messages, draft, setDraft, textareaRef, refresh }: {
  conversation: Conversation; workspace: Workspace; members: Agent[]; messages: ConversationMessage[]; draft: ConversationDraft;
  setDraft: React.Dispatch<React.SetStateAction<ConversationDraft>>; textareaRef: React.RefObject<HTMLTextAreaElement | null>; refresh: () => Promise<void> }) {
  const action = useAction();
  const id = useId();
  const [initialSubmission] = useState(() => loadSubmission(conversation.id));
  const last = useRef(initialSubmission);
  const parent = messages.find(message => message.id === draft.replyToId);
  const allowed = !draft.recipientAgentId || members.some(member => member.id === draft.recipientAgentId);
  const replyAllowed = !draft.replyToId || !!parent;
  const ready = workspace.runtime.available && workspace.runtime.authenticated;
  return <form className="conversation-composer" onSubmit={event => { event.preventDefault(); if (!members.length || !allowed || !replyAllowed || !draft.content.trim()) return;
    void action.execute(async () => { const body = conversationSubmission(draft);
      const payload = JSON.stringify(body);
      if (last.current?.payload !== payload) last.current = { payload, key: crypto.randomUUID() };
      try { window.sessionStorage.setItem(`conversation-submit:v1:${conversation.id}`, JSON.stringify(last.current)); } catch { /* Keep the in-memory retry key. */ }
      await request<ConversationMessage>(`/conversations/${conversation.id}/messages`, 'POST', { ...body, idempotencyKey: last.current.key });
      setDraft(current => ({ ...current, content: '', replyToId: '' })); last.current = null;
      try { window.sessionStorage.removeItem(`conversation-submit:v1:${conversation.id}`); } catch { /* Successful state is already held in memory. */ }
      await refresh();
    }); }}>
    {draft.replyToId ? <div className="conversation-composer-reply"><Reply size={14} /><span>{parent ? `${speaker(workspace, parent.senderAgentId)}에게 답장 · ${parent.content.slice(0, 120)}` : '답장 대상 메시지 미확인'}</span>
      <button type="button" className="icon-button" disabled={action.pending} aria-label="답장 연결 해제" onClick={() => setDraft(current => ({ ...current, replyToId: '' }))}><X size={14} /></button></div> : null}
    <label className="sr-only" htmlFor={`${id}-message`}>대화 메시지</label><textarea ref={textareaRef} id={`${id}-message`} required rows={4} maxLength={20_000} value={draft.content}
      disabled={action.pending} placeholder="논의에 참여하거나 다음 작업을 전달합니다." onChange={event => setDraft(current => ({ ...current, content: event.target.value }))}
      onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
    <div className="conversation-composer-controls"><label htmlFor={`${id}-recipient`}>받는 사람<select id={`${id}-recipient`} value={draft.recipientAgentId} disabled={action.pending}
      onChange={event => setDraft(current => ({ ...current, recipientAgentId: event.target.value }))}><option value="">{conversation.scope.type === 'agent' ? '이 에이전트' : '공동 논의'}</option>
      {!allowed ? <option value={draft.recipientAgentId}>현재 참여하지 않는 에이전트</option> : null}
      {members.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label>
      <label htmlFor={`${id}-mode`}>전달 방식<select id={`${id}-mode`} value={draft.mode} disabled={action.pending} onChange={event => setDraft(current => ({ ...current, mode: event.target.value as ConversationMode }))}>
        <option value="auto">자동 판단</option><option value="discuss">상담만</option><option value="task">작업 지시</option></select></label>
      <button className="button primary" type="submit" disabled={action.pending || !members.length || !allowed || !replyAllowed || !draft.content.trim()}>
        {action.pending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{action.pending ? '전송 중' : '보내기'}</button></div>
    <div className="conversation-composer-notes"><span>Ctrl / ⌘ + Enter 전송 · Enter 줄바꿈</span><span>진행 중 작업에는 다음 처리 경계에서 반영됩니다.</span></div>
    {draft.mode === 'discuss' ? <p className="inline-note">상담 응답에도 모델 사용량이 기록됩니다. 실행 작업으로 전환하지 않습니다. 같은 팀·프로젝트의 대기 중 작업은 대기 조건을 유지하며 별도 상담합니다.</p> : null}
    {!ready ? <p className="inline-note">실행 환경 미연결 상태입니다. 메시지를 저장하고 연결 가능한 시점을 기다립니다.</p> : null}
    {!allowed ? <ErrorNotice message="선택한 에이전트는 현재 대화에 참여하지 않습니다. 초안은 보존됩니다." /> : null}
    <ErrorNotice message={action.error} />
  </form>;
}

export function ConversationRun({ run, workspace, refresh }: { run: Run; workspace: Workspace; refresh: () => Promise<void> }) {
  const action = useAction();
  const paused = run.status === 'paused';
  const working = openRun(run);
  const ordinary = !run.kind || run.kind === 'task';
  const events = workspace.activities.filter(item => item.runId === run.id).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const waitingResources = workspace.resources?.waiting.find(item => item.ownerId === run.id);
  const control = (operation: 'pause' | 'continue' | 'cancel' | 'resume') => void action.execute(async () => { await request(`/runs/${run.id}/${operation}`, 'POST', {}); await refresh(); });
  return <details id={`conversation-run-${run.id}`} className="conversation-run" open={working}>
    <summary><Status status={run.status} /><strong>{speaker(workspace, run.agentId)}</strong><span>{conversationRunTitle(run, workspace).slice(0, 150)}</span></summary>
    <div className="conversation-run-body"><div className="conversation-run-meta"><span className="mono" title={run.id}>Run {run.id.slice(0, 8)} · v{run.agentVersion}</span><DateLabel value={run.createdAt} time /></div>
      {working && run.pauseRequestedAt && !paused ? <p className="conversation-notice" role="status">일시정지 요청됨 · 안전한 처리 경계까지 기다립니다.</p> : null}
      {paused ? <p className="conversation-notice">사용자 일시정지 상태입니다. 진행 상태를 보존하며 직접 재개하기 전에는 이어가지 않습니다.</p> : null}
      <RunBudgetNotice run={run} workspace={workspace} />
      {waitingResources ? <p className="conversation-notice">공유 자원 대기 · 최소 {waitingResources.minimum.memoryMiB.toLocaleString()} MiB / CPU {waitingResources.minimum.cpus}개가 확보되면 이어갑니다.</p> : null}
      {working && !paused && (!workspace.runtime.available || !workspace.runtime.authenticated) ? <p className="conversation-notice">실행 환경 연결 대기 · {workspace.runtime.message}</p> : null}
      {run.cleanupPending ? <p className="conversation-notice">이전 실행 환경 정리 대기 · {run.cleanupPending}</p> : null}
      {run.waitingFor ? <p className="conversation-notice">동료 응답 대기 · {run.waitingFor.reason}</p> : null}
      {run.consultationOfRunId ? <p className="conversation-notice">대기 중인 작업의 별도 상담입니다. 원래 작업의 대기 조건과 완료 상태는 유지됩니다. <span className="mono">Run {run.consultationOfRunId.slice(0, 8)}</span></p> : null}
      {run.continuedByRunId ? <p className="conversation-notice">검증된 환경에서 새 실행으로 이어졌습니다. <a href={`#conversation-run-${run.continuedByRunId}`} onClick={event => {
        event.preventDefault(); const target = document.getElementById(`conversation-run-${run.continuedByRunId}`); if (target) { (target as HTMLDetailsElement).open = true; target.scrollIntoView({ block: 'nearest' }); }
      }}>이어진 실행 확인</a></p> : null}
      {run.nextAttemptAt ? <p className="conversation-notice">재개 예정 · <DateLabel value={run.nextAttemptAt} time /></p> : null}
      {run.progress ? <p className="conversation-progress" role="status">{run.progress.message}</p> : null}
      <ErrorNotice message={run.error ?? ''} />
      {run.result ? <TextContent text={run.result} className="conversation-run-result" /> : !working ? <p className="muted">저장된 결과가 없습니다.</p> : null}
      <RunCheckpoints run={run} />
      {run.artifacts.length ? <div className="conversation-artifacts">{run.artifacts.map(artifact => <details key={artifact.id}><summary><FileText size={14} />{artifact.name}</summary>
        <TextContent text={artifact.content} className="conversation-artifact-content mono" /><button className="button" onClick={() => downloadArtifact(artifact)}><Download size={13} />다운로드</button></details>)}</div> : null}
      {events.length ? <details className="conversation-events"><summary>실행 기록 {events.length}</summary><ol>{events.map(event => <li key={event.id}><strong>{event.title}</strong><DateLabel value={event.createdAt} time />{event.detail ? <TextContent text={event.detail} /> : null}</li>)}</ol></details> : null}
      <details className="conversation-events"><summary>실행 입력 상세</summary><TextContent text={run.prompt} className="conversation-run-result" /></details>
      <UsageView attempts={(workspace.modelAttempts ?? []).filter(attempt => attempt.runId === run.id)} legacy={run} />
      {working ? <div className="conversation-run-actions">
        {ordinary && !paused ? <button className="button" disabled={action.pending || !!run.pauseRequestedAt} onClick={() => control('pause')}><Pause size={13} />{run.pauseRequestedAt ? '일시정지 대기' : '일시정지'}</button> : null}
        {paused ? <button className="button primary" disabled={action.pending} onClick={() => control('continue')}><Play size={13} />작업 재개</button> : null}
        {isCurrentBudgetWait(run) ? <button className="button" disabled={action.pending} onClick={() => control('resume')}><Play size={13} />예산 대기 재개</button> : null}
        <button className="button danger-subtle" disabled={action.pending} onClick={() => control('cancel')}><Square size={13} />작업 취소</button></div> : null}
      <ErrorNotice message={action.error} />
    </div>
  </details>;
}
function ConversationFiles({ conversation, workspace, members, refresh }: { conversation: Conversation; workspace: Workspace; members: Agent[]; refresh: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const selectorId = useId();
  const selected = members.find(member => member.id === selectedId) ?? members[0];
  const scope = conversation.scope;
  const busy = selected ? workspace.runs.some(run => run.agentId === selected.id && openRun(run)) || selected.status === 'running' : false;
  return <section className="conversation-files"><button className="button subtle" aria-expanded={opened} onClick={() => setOpened(current => !current)}><FileText size={14} />작업 폴더·공유 파일</button>
    {opened ? <div className="conversation-file-browser"><p className="inline-note">사용자 전용 파일 열람입니다. 개인 파일을 팀 대화에 자동 공개하지 않습니다. 각 에이전트의 마지막 보존 버전을 표시합니다.</p>
      {members.length > 1 ? <label className="field" htmlFor={selectorId}><span>개인 폴더</span><select id={selectorId} value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label> : null}
      {selected ? <WorkspaceFiles key={selected.id} agent={selected} busy={busy} onSaved={refresh} /> : null}
      {scope.type !== 'agent' ? <SharedFiles scope={{ type: scope.type, id: scope.id }} /> : null}
    </div> : null}
  </section>;
}
function downloadArtifact(item: Artifact) {
  const url = URL.createObjectURL(new Blob([item.content], { type: item.mediaType || 'text/plain' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name.replace(/[\\/]/g, '_'); anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
