import { useEffect, useRef, useState } from 'react';
import { ClipboardList, MessageSquare, Pencil, RotateCcw } from 'lucide-react';
import type { Workspace } from '../shared/types';
import type { OperatorRequest, OperatorRequestActor, OperatorRequestContent, OperatorRequestDecisionStatus, OperatorRequestProcessingStatus } from '../shared/operator-requests';
import { operatorRequestContentSchema } from '../shared/operator-requests';
import { request, useAction } from './api';
import { DateLabel, Empty, ErrorNotice, Field, Modal, SectionTitle, TextContent } from './ui';
import { conversationHref } from './ConversationView';

const decisionLabels: Record<OperatorRequestDecisionStatus, string> = { pending: '결정 대기', needs_information: '보완 요청', approved: '승인', rejected: '거절', withdrawn: '철회' };
const processingLabels: Record<OperatorRequestProcessingStatus, string> = { idle: '처리 전', in_progress: '처리 중', verification_pending: '검증 대기', verified: '검증 완료', failed: '처리 실패' };
const categoryLabels: Record<OperatorRequestContent['category'], string> = { connector: '커넥터 연결', environment: '환경 개선', permission: '접근 권한', budget: '예산', other: '기타' };
const historyLabels: Record<OperatorRequest['history'][number]['kind'], string> = { created: '요청 등록', revised: '내용 수정', decision: '대표 결정', processing: '처리 기록', verification: '검증 기록', withdrawn: '요청 철회' };
const actorName = (actor: OperatorRequestActor | null, workspace: Workspace) => !actor ? '기록 없음' : actor.kind === 'operator' ? '대표 · 사용자' : `에이전트 · ${workspace.agents.find(agent => agent.id === actor.agentId)?.name ?? actor.agentId}`;
export const operatorRequestOpen = (item: OperatorRequest) => item.decision.status !== 'rejected' && item.decision.status !== 'withdrawn' && !(item.decision.status === 'approved' && item.decision.contentVersion === item.contentVersion && item.processing.status === 'verified' && item.verification?.passed && item.verification.contentVersion === item.contentVersion);
export const operatorRequestHref = (id: string) => `#requests/${encodeURIComponent(id)}`;
export function operatorRequestLocation(hash: string): { id: string | null } | null {
  if (hash === '#requests') return { id: null };
  const match = /^#requests\/([^/]+)$/.exec(hash);
  if (!match) return null;
  try { return { id: decodeURIComponent(match[1]) }; } catch { return null; }
}

export function OperatorRequestsView({ workspace, refresh, onSelect }: { workspace: Workspace; refresh: () => Promise<void>; onSelect: (id: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(() => typeof window === 'undefined' ? null : operatorRequestLocation(window.location.hash)?.id ?? null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const items = (workspace.operatorRequests ?? []).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visible = filter === 'all' ? items : items.filter(operatorRequestOpen);
  const selected = items.find(item => item.id === selectedId) ?? visible[0];
  useEffect(() => { const changed = () => setSelectedId(operatorRequestLocation(window.location.hash)?.id ?? null); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  return <><div className="page-heading"><div><span className="eyebrow">OPERATOR REQUESTS</span><h1>대표 요청함</h1><p>에이전트의 요청을 검토하고 실제 처리·검증을 따로 기록합니다.</p></div><span className="tag">미처리 {items.filter(operatorRequestOpen).length}건</span></div>
    <div className="operator-request-toolbar"><div className="filter-tabs" aria-label="대표 요청 필터"><button className={filter === 'open' ? 'active' : ''} aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>미처리</button><button className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>전체·이력</button></div><button className="text-link" onClick={() => void refresh()}>현재 상태 다시 불러오기</button></div>
    {selected ? <div className="operator-requests-layout"><aside className="operator-request-list" aria-label="대표 요청 선택">{visible.map(item => <a key={item.id} href={operatorRequestHref(item.id)} className={selected.id === item.id ? 'selected' : ''} aria-current={selected.id === item.id ? 'true' : undefined}><strong>{item.title}</strong><small>{workspace.agents.find(agent => agent.id === item.requesterAgentId)?.name ?? '이전 에이전트'} · {categoryLabels[item.category]}</small><span>{decisionLabels[item.decision.status]} · {processingLabels[item.processing.status]}</span></a>)}{!visible.length ? <p className="inline-note">이 필터에 해당하는 요청이 없습니다.</p> : null}</aside><OperatorRequestDetail key={selected.id} item={selected} workspace={workspace} refresh={refresh} onSelect={onSelect} /></div>
      : <Empty icon={<ClipboardList size={25} />} title={items.length ? '미처리 요청이 없습니다' : '대표 요청이 없습니다'} detail="에이전트의 요청과 추가 환경 접근 요청을 이곳에서 확인합니다. 직접 메시지도 요청으로 등록할 수 있습니다." />}
  </>;
}

type RequestAction = 'decide' | 'progress' | 'verify' | 'withdraw' | 'consult';
export function OperatorRequestDetail({ item, workspace, refresh, onSelect }: { item: OperatorRequest; workspace: Workspace; refresh: () => Promise<void>; onSelect: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [operation, setOperation] = useState<RequestAction | null>(null);
  const agent = workspace.agents.find(value => value.id === item.requesterAgentId);
  const team = item.scope.type === 'team' ? workspace.teams.find(value => value.id === item.scope.id) : null;
  const project = item.scope.type === 'project' ? workspace.projects?.find(value => value.id === item.scope.id) : null;
  const teams = workspace.teams.filter(value => value.memberIds.includes(item.requesterAgentId));
  const approved = item.decision.status === 'approved' && item.decision.contentVersion === item.contentVersion;
  const withdrawn = item.decision.status === 'withdrawn';
  return <section className="operator-request-detail panel" aria-label="대표 요청 상세"><div className="operator-request-heading"><div><span className="eyebrow">{categoryLabels[item.category]} · 본문 v{item.contentVersion}</span><h2>{item.title}</h2><p><DateLabel value={item.createdAt} time /> · 기록 v{item.version}</p></div><span className="mono">{item.id.slice(0, 8)}</span></div>
    <div className="operator-request-statuses"><div><span>대표 결정</span><strong>{decisionLabels[item.decision.status]}</strong><small>{actorName(item.decision.actor, workspace)}</small><TextContent text={item.decision.reason || '아직 결정하지 않았습니다.'} /></div><div><span>실제 처리</span><strong>{processingLabels[item.processing.status]}</strong><small>{actorName(item.processing.actor, workspace)}</small><TextContent text={item.processing.detail || '처리 기록이 없습니다.'} /></div></div>
    <p className="inline-note">승인은 연결·권한 변경이나 처리 완료를 뜻하지 않습니다. 검증 후에도 사용자 중지·권한·예산 등 기존 실행 조건을 확인합니다.</p>
    <dl className="operator-request-context"><div><dt>요청 에이전트</dt><dd><button className="text-link" onClick={() => onSelect(item.requesterAgentId)} disabled={!agent}>{agent?.name ?? item.requesterAgentId}</button></dd></div><div><dt>소속 팀</dt><dd>{teams.map(value => value.name).join(' · ') || '현재 소속 없음'}</dd></div><div><dt>요청 공간</dt><dd>{team ? `팀 · ${team.name}` : project ? `프로젝트 · ${project.name}` : item.scope.type === 'agent' ? `개인 · ${agent?.name ?? item.scope.id}` : item.scope.id}</dd></div>
      {item.links.objectiveId ? <div><dt>관련 목적</dt><dd><a className="text-link" href="#objectives">{workspace.objectives?.find(value => value.id === item.links.objectiveId)?.title ?? item.links.objectiveId}</a></dd></div> : null}
      {item.links.taskId ? <div><dt>관련 과제</dt><dd>{workspace.teamTasks?.find(value => value.id === item.links.taskId)?.title ?? item.links.taskId}</dd></div> : null}
      {item.links.environmentRevisionId ? <div><dt>원 환경 제안</dt><dd><button className="text-link" onClick={() => onSelect(item.requesterAgentId)}>환경 {item.links.environmentRevisionId.slice(0, 8)} · 에이전트에서 확인</button></dd></div> : null}
    </dl>
    <RequestContent item={item} />
    {item.links.messageId ? <details className="operator-request-source"><summary>원본 직접 메시지</summary><TextContent text={workspace.messages?.find(value => value.id === item.links.messageId)?.content ?? '원본 메시지를 현재 작업실에서 확인하지 못했습니다.'} /></details> : null}
    <div className="operator-request-actions"><button className="button" onClick={() => setOperation('consult')}><MessageSquare size={14} />요청자에게 질문</button>{!withdrawn ? <><button className="button" onClick={() => setOperation('decide')}>승인·보완·거절</button><button className="button subtle" onClick={() => setEditing(true)}><Pencil size={14} />내용 수정</button>{approved ? <><button className="button" onClick={() => setOperation('progress')}>처리 상태 기록</button><button className="button primary" disabled={item.processing.status !== 'verification_pending'} onClick={() => setOperation('verify')}>처리 결과 검증</button></> : null}<button className="button subtle" onClick={() => setOperation('withdraw')}>요청 철회</button></> : null}</div>
    {approved && item.processing.status !== 'verification_pending' ? <p className="inline-note">처리 내용을 기록하고 상태를 검증 대기로 전환하면 결과를 검증할 수 있습니다.</p> : null}
    {item.verification ? <section className="operator-request-verification"><h3>{item.verification.method === 'manual' ? '운영자 확인' : item.verification.method === 'github' ? 'GitHub 실제 확인' : '환경 검증 확인'} · {item.verification.passed ? '통과' : '실패'}</h3><p>본문 v{item.verification.contentVersion} · {actorName(item.verification.actor, workspace)} · <DateLabel value={item.verification.verifiedAt} time /></p><TextContent text={item.verification.detail} /><TextContent text={item.verification.evidence} />{item.verification.contentVersion !== item.contentVersion ? <p className="inline-note">현재 본문과 다른 버전의 검증입니다.</p> : null}</section> : null}
    {item.verification?.passed ? <section className="operator-request-resume"><h3>관련 과제 재개</h3>{item.resumeBlockReason ? <p className="objective-blocked">{item.resumeBlockReason}</p> : null}{item.resumeReceipts.length ? <ul>{item.resumeReceipts.map(receipt => { const run = workspace.runs.find(value => value.id === (receipt.continuedRunId ?? receipt.runId)); return <li key={`${receipt.runId}/${receipt.at}`}>이전 실행 {receipt.runId.slice(0, 8)}{receipt.continuedRunId ? ` → 새 실행 ${receipt.continuedRunId.slice(0, 8)}` : ' · 재개 처리'} · <DateLabel value={receipt.at} time />{run ? <button className="text-link" onClick={() => onSelect(run.agentId)}>연결 실행 보기</button> : null}</li>; })}</ul> : <p className="inline-note">재개 실행 기록이 없습니다. 검증 완료와 실제 실행 시작은 별도로 확인합니다.</p>}</section> : null}
    <section className="operator-request-history"><SectionTitle title="요청 이력" detail="등록·본문 변경·대표 결정·처리와 검증 기록을 보존합니다." />{item.history.toReversed().map(entry => <details key={entry.id}><summary>{historyLabels[entry.kind]} · 본문 v{entry.contentVersion} · {actorName(entry.actor, workspace)} · <DateLabel value={entry.at} time /></summary>{entry.content ? <RequestContent item={entry.content} /> : null}{entry.decision ? <TextContent text={`${decisionLabels[entry.decision.status]} · ${entry.decision.reason}`} /> : null}{entry.processing ? <TextContent text={`${processingLabels[entry.processing.status]} · ${entry.processing.detail}`} /> : null}{entry.verification ? <><TextContent text={`${entry.verification.method === 'manual' ? '운영자 확인' : entry.verification.method} · ${entry.verification.passed ? '통과' : '실패'} · ${entry.verification.detail}`} /><TextContent text={entry.verification.evidence} /></> : null}</details>)}</section>
    {editing ? <OperatorRequestContentForm workspace={workspace} item={item} onClose={() => setEditing(false)} onSaved={async () => { await refresh(); setEditing(false); }} refresh={refresh} /> : null}
    {operation ? <OperatorRequestActionForm key={operation} operation={operation} item={item} workspace={workspace} onClose={() => setOperation(null)} onSaved={async () => { await refresh(); setOperation(null); }} refresh={refresh} /> : null}
  </section>;
}

function RequestContent({ item }: { item: OperatorRequestContent }) {
  return <dl className="operator-request-content">{[['필요한 대표 조치', item.requestedAction], ['대상·권한 범위', item.requestedScope], ['이유·근거', item.reason], ['해결 확인 기준', item.verificationCriteria]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd><TextContent text={value} /></dd></div>)}</dl>;
}

function DraftFailure({ error, refresh }: { error: string; refresh: () => Promise<void> }) {
  return error ? <><ErrorNotice message={error} /><div className="operator-request-conflict"><p>초안을 보존했습니다. 버전 충돌이면 현재 상태를 다시 불러온 뒤 변경 내용을 확인하고 창을 다시 열어 반영합니다.</p><button type="button" className="text-link" onClick={() => void refresh()}><RotateCcw size={13} />현재 상태 다시 불러오기</button></div></> : null;
}

export function OperatorRequestContentForm({ item, onClose, onSaved, refresh }: { workspace: Workspace; item: OperatorRequest; onClose: () => void; onSaved: (result: OperatorRequest) => Promise<void>; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<OperatorRequestContent>(item);
  const [baseVersion] = useState(item.version);
  const action = useAction();
  const patch = (key: keyof OperatorRequestContent, value: string) => setDraft(current => ({ ...current, [key]: value }));
  return <Modal title="요청 내용 수정" onClose={onClose} busy={action.pending} wide><form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
    const content = operatorRequestContentSchema.parse({ scope: draft.scope, links: draft.links, category: draft.category, title: draft.title, reason: draft.reason, requestedAction: draft.requestedAction, requestedScope: draft.requestedScope, verificationCriteria: draft.verificationCriteria });
    const result = await request<OperatorRequest>(`/operator-requests/${item.id}/revise`, 'POST', { ...content, expectedVersion: baseVersion });
    await onSaved(result);
  }); }}><p className="inline-note">대표 · 사용자 명의로 수정합니다. 본문·대상·범위가 바뀌면 새 버전이 되며 기존 승인·검증은 무효화됩니다.</p>
    <fieldset disabled={action.pending} className="operator-request-fields"><Field label="요청 이름"><input required maxLength={200} value={draft.title} onChange={event => patch('title', event.target.value)} /></Field><Field label="요청 종류"><select value={draft.category} onChange={event => patch('category', event.target.value)}>{Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
      <Field label="필요한 대표 조치"><textarea required rows={3} maxLength={4000} value={draft.requestedAction} onChange={event => patch('requestedAction', event.target.value)} /></Field><Field label="대상·권한 범위"><textarea required rows={3} maxLength={8000} value={draft.requestedScope} onChange={event => patch('requestedScope', event.target.value)} /></Field><Field label="이유·근거"><textarea required rows={4} maxLength={8000} value={draft.reason} onChange={event => patch('reason', event.target.value)} /></Field><Field label="해결 확인 기준"><textarea required rows={3} maxLength={4000} value={draft.verificationCriteria} onChange={event => patch('verificationCriteria', event.target.value)} /></Field></fieldset>
    <DraftFailure error={action.error} refresh={refresh} /><div className="modal-actions"><button type="button" className="button subtle" disabled={action.pending} onClick={onClose}>취소</button><button className="button primary" type="submit" disabled={action.pending || ![draft.title, draft.reason, draft.requestedAction, draft.requestedScope, draft.verificationCriteria].every(value => value.trim())}>{action.pending ? '저장 중' : '새 본문 버전 저장'}</button></div>
  </form></Modal>;
}

export function OperatorRequestActionForm({ operation, item, workspace, onClose, onSaved, refresh }: { operation: RequestAction; item: OperatorRequest; workspace: Workspace; onClose: () => void; onSaved: () => Promise<void>; refresh: () => Promise<void> }) {
  const [baseVersion] = useState(item.version);
  const [baseContentVersion] = useState(item.contentVersion);
  const [decision, setDecision] = useState<'approved' | 'needs_information' | 'rejected'>('needs_information');
  const [processing, setProcessing] = useState<'in_progress' | 'verification_pending' | 'failed'>('in_progress');
  const [method, setMethod] = useState<'github' | 'environment' | 'manual'>(item.category === 'connector' ? 'github' : item.category === 'environment' ? 'environment' : 'manual');
  const [resourceId, setResourceId] = useState('');
  const [detail, setDetail] = useState('');
  const [evidence, setEvidence] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const lastSubmission = useRef<{ content: string; key: string } | null>(null);
  const action = useAction();
  const titles: Record<RequestAction, string> = { decide: '대표 결정 기록', progress: '처리 상태 기록', verify: '처리 결과 검증', withdraw: '요청 철회', consult: '요청자에게 질문' };
  const resources = method === 'github' ? workspace.connections.filter(connection => connection.github?.status === 'connected').map(connection => ({ id: connection.id, label: `${connection.repository} · ${connection.access === 'write' ? '읽기·쓰기' : '읽기'}` })) : (workspace.environmentRevisions ?? []).filter(revision => revision.agentId === item.requesterAgentId && revision.status === 'ready').map(revision => ({ id: revision.id, label: `${revision.id.slice(0, 8)} · ${revision.reason}` }));
  const canVerify = operation !== 'verify' || (!!evidence.trim() && (method === 'manual' ? confirmed : resources.some(value => value.id === resourceId)));
  return <Modal title={titles[operation]} onClose={onClose} busy={action.pending} wide><form className="form-stack" onSubmit={event => { event.preventDefault(); if (!canVerify) return; void action.execute(async () => {
    if (operation === 'consult') {
      if (lastSubmission.current?.content !== detail) lastSubmission.current = { content: detail, key: crypto.randomUUID() };
      const result = await request<{ conversationId: string }>(`/operator-requests/${item.id}/consult`, 'POST', { content: detail, idempotencyKey: lastSubmission.current.key });
      await onSaved(); window.location.hash = conversationHref(result.conversationId); return;
    }
    const body = operation === 'decide' ? { expectedVersion: baseVersion, status: decision, reason: detail } : operation === 'progress' ? { expectedVersion: baseVersion, status: processing, detail } : operation === 'withdraw' ? { expectedVersion: baseVersion, reason: detail } : { expectedVersion: baseVersion, method, ...(method !== 'manual' ? { resourceId } : {}), evidence, detail };
    await request(`/operator-requests/${item.id}/${operation}`, 'POST', body); await onSaved();
  }); }}><p className="inline-note">대표 · 사용자 명의로 기록합니다. {operation === 'consult' ? '요청 내용에 관한 읽기 전용 상담이며 기존 작업의 대기 조건을 유지합니다.' : `현재 본문 v${baseContentVersion} · 기록 v${baseVersion}을 대상으로 합니다.`}</p>
    <fieldset disabled={action.pending} className="operator-request-fields">
      {operation === 'decide' ? <><Field label="결정"><select value={decision} onChange={event => setDecision(event.target.value as typeof decision)}><option value="needs_information">보완 요청</option><option value="approved">승인</option><option value="rejected">거절</option></select></Field><p className="inline-note">승인 후 연결·권한 설정은 기존 관리 화면에서 처리하고 결과를 검증합니다.</p></> : null}
      {operation === 'progress' ? <Field label="처리 상태"><select value={processing} onChange={event => setProcessing(event.target.value as typeof processing)}><option value="in_progress">처리 중</option><option value="verification_pending">검증 대기</option><option value="failed">처리 실패</option></select></Field> : null}
      {operation === 'verify' ? <><Field label="검증 방식"><select value={method} onChange={event => { setMethod(event.target.value as typeof method); setResourceId(''); setConfirmed(false); }}><option value="github">GitHub 실제 연결·접근 확인</option><option value="environment">검증된 환경 확인</option><option value="manual">운영자 확인 · 직접 확인한 결과</option></select></Field>{method === 'manual' ? <><p className="inline-note">운영자가 직접 확인한 사실을 기록합니다. 자동 연결 검사 결과와 구분합니다.</p><label className="objective-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />승인된 범위와 해결 기준을 직접 확인했습니다.</label></> : <><Field label={method === 'github' ? '기존 GitHub 연결' : '검증 통과한 요청자 환경'}><select required value={resourceId} onChange={event => setResourceId(event.target.value)}><option value="">검증 대상 선택</option>{resources.map(resource => <option key={resource.id} value={resource.id}>{resource.label}</option>)}</select></Field>{!resources.length ? <p className="inline-note">선택할 대상이 없습니다. 기존 관리 화면에서 연결 또는 환경 구성을 먼저 확인합니다.</p> : null}<a className="text-link" href={method === 'github' ? '#settings' : '#agents'}>기존 {method === 'github' ? '연결' : '에이전트 환경'} 관리 화면</a></>}
        <Field label="검증 근거" hint="직접 확인한 결과·자료 위치를 기록합니다. 인증 비밀값을 입력하지 않습니다."><textarea required rows={4} maxLength={12000} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field></> : null}
      {operation === 'withdraw' ? <p className="inline-note">요청만 철회합니다. 관련 과제 취소나 이미 부여된 접근 권한 회수는 별도입니다.</p> : null}
      <Field label={operation === 'consult' ? '질문 내용' : operation === 'decide' || operation === 'withdraw' ? '결정 이유' : '처리·확인 내용'}><textarea required rows={4} maxLength={4000} value={detail} onChange={event => setDetail(event.target.value)} /></Field>
    </fieldset><DraftFailure error={action.error} refresh={refresh} /><div className="modal-actions"><button type="button" className="button subtle" disabled={action.pending} onClick={onClose}>취소</button><button type="submit" className="button primary" disabled={action.pending || !detail.trim() || !canVerify}>{action.pending ? '처리 중' : operation === 'consult' ? '상담 전달' : operation === 'verify' ? method === 'manual' ? '운영자 확인 기록' : '실제 상태 검증' : '기록 저장'}</button></div>
  </form></Modal>;
}
