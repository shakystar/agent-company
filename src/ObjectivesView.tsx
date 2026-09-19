import { useState } from 'react';
import { ArrowRight, Check, CircleCheck, History, Pause, Pencil, Play, Plus, RefreshCw, Sparkles, Target, Trash2 } from 'lucide-react';
import type { Workspace } from '../shared/types';
import type { CollaborationScope, TeamTask } from '../shared/collaboration';
import type { CreateObjectiveInput, Objective, ObjectiveEvaluation, ObjectiveEvidence } from '../shared/objectives';
import { request, useAction } from './api';
import { DateLabel, Empty, ErrorNotice, Field, Modal, SectionTitle, Status, TextContent } from './ui';
import { conversationHref } from './ConversationView';
import { teamTaskRun } from './CollaborationView';

type Props = { workspace: Workspace; refresh: () => Promise<void>; onSelect: (id: string) => void };
const objectiveLabels: Record<Objective['status'], string> = { active: '진행 중', paused: '일시 정지', completed: '목적 완료 · 대기', cancelled: '중단됨' };
const conditionLabels = { met: '충족', unmet: '미완료', blocked: '진행 불가', needs_user: '사용자 확인 대기' };
const evaluationLabels: Record<ObjectiveEvaluation['status'], string> = { queued: '평가 중·대기', applied: '반영됨', stale: '이전 조건 · 미반영', failed: '평가 실패' };
const scopeName = (workspace: Workspace, scope: CollaborationScope) => scope.type === 'team'
  ? workspace.teams.find(item => item.id === scope.id)?.name ?? '이전 팀'
  : workspace.projects?.find(item => item.id === scope.id)?.name ?? '이전 프로젝트';

export function currentObjectiveEvaluation(objective: Objective, evaluations: ObjectiveEvaluation[]) {
  return evaluations.find(item => item.id === objective.lastEvaluationId && item.objectiveId === objective.id && item.status === 'applied');
}

export function ObjectivesView({ workspace, refresh, onSelect }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Objective | 'new' | null>(null);
  const objectives = workspace.objectives ?? [];
  const selected = objectives.find(item => item.id === selectedId) ?? objectives[0];
  return <><div className="page-heading"><div><span className="eyebrow">PURPOSE & PROGRESS</span><h1>목적</h1>
    <p>완료 조건과 근거를 평가하고 필요한 후속 과제를 이어갑니다.</p></div>
    <button className="button primary" disabled={!workspace.teams.some(team => team.memberIds.length)} onClick={() => setEditing('new')}><Plus size={16} />목적 등록</button></div>
    {objectives.length ? <div className="objectives-layout"><nav className="objectives-list" aria-label="등록한 목적">
      {objectives.map(objective => <button key={objective.id} className={selected?.id === objective.id ? 'selected' : ''}
        aria-pressed={selected?.id === objective.id} onClick={() => setSelectedId(objective.id)}><Target size={17} /><span>
        <strong>{objective.title}</strong><small>{scopeName(workspace, objective.scope)} · {objectiveLabels[objective.status]}</small></span></button>)}
    </nav>{selected ? <ObjectiveDetail key={selected.id} objective={selected} workspace={workspace} refresh={refresh} onSelect={onSelect}
      onEdit={() => setEditing(selected)} /> : null}</div> : <Empty icon={<Target size={27} />} title="등록한 목적이 없습니다"
      detail={workspace.teams.some(team => team.memberIds.length) ? '담당 팀과 완료 조건을 등록하면 평가를 시작합니다.' : '구성원이 있는 담당 팀이 아직 없습니다.'} />}
    {editing ? <ObjectiveForm workspace={workspace} objective={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)}
      onSaved={async objective => { setSelectedId(objective.id); await refresh(); setEditing(null); }} /> : null}
  </>;
}

export function ObjectiveForm({ workspace, objective, onClose, onSaved }: { workspace: Workspace; objective?: Objective;
  onClose: () => void; onSaved: (objective: Objective) => Promise<void> }) {
  // The opening version and draft remain fixed while the workspace polls.
  const [initial] = useState(objective);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [teamId, setTeamId] = useState(initial?.teamId ?? workspace.teams.find(team => team.memberIds.length)?.id ?? '');
  const [projectId, setProjectId] = useState(initial?.scope.type === 'project' ? initial.scope.id : '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const [constraints, setConstraints] = useState(initial?.constraints ?? '');
  const [conditions, setConditions] = useState<Objective['conditions']>(() => initial?.conditions.map(item => ({ ...item }))
    ?? [{ id: crypto.randomUUID(), text: '', requiresUserConfirmation: false }]);
  const action = useAction();
  const projects = (workspace.projects ?? []).filter(item => item.teamIds.includes(teamId));
  const validScope = !!workspace.teams.find(item => item.id === teamId)?.memberIds.length && (!projectId || projects.some(item => item.id === projectId));
  const valid = validScope && !!title.trim() && !!purpose.trim() && conditions.every(item => item.text.trim());
  const updateCondition = (id: string, patch: Partial<Objective['conditions'][number]>) => setConditions(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  return <Modal title={initial ? '목적 편집' : '목적 등록'} onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); if (!valid) return;
      void action.execute(async () => {
        const content = { title: title.trim(), purpose: purpose.trim(), constraints, conditions: conditions.map(item => ({ ...item, text: item.text.trim() })) };
        const result = initial ? await request<Objective>(`/objectives/${initial.id}`, 'PATCH', { expectedVersion: initial.version, ...content })
          : await request<Objective>('/objectives', 'POST', { idempotencyKey, teamId, scope: { type: projectId ? 'project' : 'team', id: projectId || teamId }, ...content } satisfies CreateObjectiveInput);
        await onSaved(result);
      });
    }}><div className="objective-form-scope"><Field label="담당 팀"><select required value={teamId} disabled={!!initial || action.pending}
      onChange={event => { setTeamId(event.target.value); setProjectId(''); }}><option value="">팀 선택</option>
      {workspace.teams.map(team => <option key={team.id} value={team.id} disabled={!team.memberIds.length}>{team.name}{team.memberIds.length ? '' : ' · 구성원 없음'}</option>)}</select></Field>
      <Field label="작업 공간"><select value={projectId} disabled={!!initial || action.pending} onChange={event => setProjectId(event.target.value)}>
        <option value="">담당 팀 공간</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field></div>
      <Field label="목적 이름"><input required autoFocus maxLength={200} disabled={action.pending} value={title} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label="이루려는 결과"><textarea required rows={4} maxLength={8000} disabled={action.pending} value={purpose} onChange={event => setPurpose(event.target.value)} /></Field>
      <Field label="작업 범위·제약"><textarea rows={3} maxLength={8000} disabled={action.pending} value={constraints} onChange={event => setConstraints(event.target.value)} /></Field>
      <fieldset className="objective-condition-fields" disabled={action.pending}><legend>완료 조건</legend>
        {conditions.map((condition, index) => <div className="objective-condition-field" key={condition.id}>
          <Field label={`조건 ${index + 1}`}><textarea required rows={2} maxLength={2000} value={condition.text} onChange={event => updateCondition(condition.id, { text: event.target.value })} /></Field>
          <div><label className="objective-checkbox"><input type="checkbox" checked={condition.requiresUserConfirmation}
            onChange={event => updateCondition(condition.id, { requiresUserConfirmation: event.target.checked })} /><span>완료 시 사용자 확인 필수</span></label>
            <button className="icon-button" type="button" disabled={conditions.length === 1} aria-label={`조건 ${index + 1} 삭제`}
              onClick={() => setConditions(items => items.filter(item => item.id !== condition.id))}><Trash2 size={15} /></button></div>
        </div>)}<button className="button" type="button" disabled={conditions.length >= 20}
          onClick={() => setConditions(items => [...items, { id: crypto.randomUUID(), text: '', requiresUserConfirmation: false }])}><Plus size={14} />조건 추가</button>
      </fieldset><p className="inline-note">등록 후 평가는 모델 사용량에 포함됩니다. 후속 과제의 자동 수행은 담당 팀의 열린 과제 자동 탐색 설정을 따릅니다.</p>
      {initial ? <p className="inline-note">미완료 작업이 없는 일시 정지 상태에서 저장하며 기존 사용자 확인은 초기화됩니다. 다른 변경이 먼저 저장되면 입력을 보존하고 충돌을 표시합니다.</p> : null}
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" disabled={action.pending} onClick={onClose}>취소</button>
        <button className="button primary" type="submit" disabled={action.pending || !valid}>{action.pending ? '저장 중' : initial ? '변경 저장' : '목적 등록·평가 시작'}</button></div>
    </form>
  </Modal>;
}

export function ObjectiveDetail({ objective, workspace, refresh, onSelect, onEdit }: Props & { objective: Objective; onEdit: () => void }) {
  const action = useAction();
  const [confirmation, setConfirmation] = useState<{ conditionId: string; text: string; version: number } | null>(null);
  const evaluations = (workspace.objectiveEvaluations ?? []).filter(item => item.objectiveId === objective.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = currentObjectiveEvaluation(objective, evaluations);
  const team = workspace.teams.find(item => item.id === objective.teamId);
  const taskIds = new Set(evaluations.flatMap(item => item.taskIds));
  const tasks = (workspace.teamTasks ?? []).filter(task => task.objectiveId === objective.id || taskIds.has(task.id));
  const runById = new Map(workspace.runs.map(run => [run.id, run]));
  const pendingWork = tasks.some(task => task.status !== 'done') || workspace.runs.some(run =>
    (run.objectiveId ?? runById.get(run.budgetRootRunId ?? '')?.objectiveId) === objective.id
    && (['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status) || !!run.cleanupPending));
  const control = (next: 'pause' | 'resume' | 'cancel' | 'reevaluate') => void action.execute(async () => {
    await request(`/objectives/${objective.id}/control`, 'POST', { expectedVersion: objective.version, action: next }); await refresh();
  });
  return <article className="objective-detail panel" aria-label="목적 상세"><div className="objective-heading"><div>
    <span className="eyebrow">{objective.scope.type === 'project' ? '프로젝트' : '팀'} · {scopeName(workspace, objective.scope)}</span><h2>{objective.title}</h2>
    <p>담당 · {team?.name ?? '이전 팀'} · <DateLabel value={objective.updatedAt} time /></p></div>
    <span className={`tag ${objective.status === 'completed' ? 'tag-green' : objective.status === 'paused' ? 'tag-amber' : ''}`}>{objectiveLabels[objective.status]}</span></div>
    <TextContent text={objective.purpose} className="objective-purpose" />
    {objective.constraints ? <details className="objective-constraints"><summary>작업 범위·제약</summary><TextContent text={objective.constraints} /></details> : null}
    <div className="objective-actions" aria-label="목적 진행 제어" aria-busy={action.pending}>
      {objective.status === 'active' ? <button className="button" disabled={action.pending} onClick={() => control('pause')}><Pause size={14} />일시 정지</button> : null}
      {objective.status === 'paused' ? <><button className="button primary" disabled={action.pending} onClick={() => control('resume')}><Play size={14} />다시 진행</button>
        <button className="button" disabled={action.pending || pendingWork} onClick={onEdit}><Pencil size={14} />목적 편집</button></> : null}
      {objective.status === 'active' || objective.status === 'completed' ? <button className="button" disabled={action.pending || pendingWork} onClick={() => control('reevaluate')}><RefreshCw size={14} />다시 평가</button> : null}
      {objective.status === 'active' || objective.status === 'paused' ? <button className="button subtle" disabled={action.pending} onClick={() => control('cancel')}>목적 중단</button> : null}
    </div><ErrorNotice message={action.error} />
    {pendingWork && objective.status !== 'cancelled' ? <p className="inline-note">미완료 과제·실행이 있어 편집과 재평가를 기다립니다.</p> : null}
    {objective.blockedReason ? <p className="objective-blocked" role="status">{objective.blockedReason}</p> : null}
    {!team?.autoDiscoverTasks ? <p className="inline-note">담당 팀의 열린 과제 자동 탐색이 꺼져 있습니다. 생성된 과제는 공동 작업판에 보존됩니다. <a href="#teams">팀 설정</a></p> : null}
    <section className="objective-section" aria-label="완료 조건 판정"><SectionTitle title="완료 조건" detail={current ? `최근 반영된 평가 · ${new Date(current.createdAt).toLocaleString('ko-KR')}` : '아직 반영된 평가가 없습니다.'} />
      <ol className="objective-conditions">{objective.conditions.map(condition => {
        const finding = current?.assessment?.conditions.find(item => item.conditionId === condition.id);
        const confirmed = objective.confirmations.find(item => item.conditionId === condition.id);
        return <li key={condition.id}><div className="objective-condition-heading"><strong>{condition.text}</strong>
          <span className={`tag ${finding?.status === 'met' ? 'tag-green' : finding?.status === 'blocked' || finding?.status === 'needs_user' ? 'tag-amber' : ''}`}>{finding ? conditionLabels[finding.status] : '평가 전'}</span></div>
          {finding ? <TextContent text={finding.reason} /> : null}
          {finding?.evidenceIds.length && current ? <ObjectiveEvidenceList evaluation={current} ids={finding.evidenceIds} /> : null}
          {condition.requiresUserConfirmation ? <p className="objective-confirmation-note">사용자 확인 필수{confirmed ? <> · 확인 기록 <DateLabel value={confirmed.createdAt} time /></> : ' · 아직 확인되지 않았습니다.'}</p> : null}
          {confirmed ? <TextContent text={confirmed.note} className="objective-confirmed-note" /> : null}
          {condition.requiresUserConfirmation && !confirmed && (objective.status === 'active' || objective.status === 'paused') ? <button className="button" disabled={action.pending}
            onClick={() => setConfirmation({ conditionId: condition.id, text: condition.text, version: objective.version })}><Check size={14} />이 조건 확인 기록</button> : null}
        </li>;
      })}</ol>
    </section><section className="objective-section" aria-label="연결된 후속 과제"><SectionTitle title="후속 과제" detail="미완료 조건에 연결된 공동 작업과 결과입니다." />
      {tasks.length ? <div className="collaboration-list">{tasks.map(task => <ObjectiveTask key={task.id} task={task} objective={objective} workspace={workspace} onSelect={onSelect} />)}</div>
        : <p className="inline-note">생성된 후속 과제가 없습니다.</p>}
    </section><ObjectiveGrowth workspace={workspace} tasks={tasks} onSelect={onSelect} />
    <section className="objective-section" aria-label="목적 평가 이력"><SectionTitle title="평가 이력" />
      {evaluations.length ? <div className="objective-evaluations">{evaluations.map(evaluation => <ObjectiveHistory key={evaluation.id} evaluation={evaluation} workspace={workspace} onSelect={onSelect} />)}</div>
        : <Empty icon={<History size={22} />} title="아직 평가 기록이 없습니다" />}
    </section>{confirmation ? <ObjectiveConfirmation objectiveId={objective.id} condition={confirmation} onClose={() => setConfirmation(null)}
      onSaved={async () => { await refresh(); setConfirmation(null); }} /> : null}
  </article>;
}

export function ObjectiveConfirmation({ objectiveId, condition, onClose, onSaved }: { objectiveId: string; condition: { conditionId: string; text: string; version: number };
  onClose: () => void; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(''); const action = useAction();
  return <Modal title="완료 조건 확인" onClose={onClose} busy={action.pending}><form className="form-stack" onSubmit={event => {
    event.preventDefault(); if (!note.trim()) return; void action.execute(async () => {
      await request(`/objectives/${objectiveId}/confirm`, 'POST', { expectedVersion: condition.version, conditionId: condition.conditionId, note: note.trim() }); await onSaved();
    });
  }}><TextContent text={condition.text} /><Field label="직접 확인한 내용"><textarea required autoFocus rows={4} maxLength={3000}
    value={note} disabled={action.pending} onChange={event => setNote(event.target.value)} /></Field>
    <p className="inline-note">이 기록을 근거로 다음 평가에서 완료 여부를 판단합니다.</p><ErrorNotice message={action.error} />
    <div className="modal-actions"><button className="button subtle" type="button" disabled={action.pending} onClick={onClose}>취소</button>
      <button className="button primary" type="submit" disabled={action.pending || !note.trim()}><CircleCheck size={15} />{action.pending ? '기록 중' : '사용자 확인 기록'}</button></div>
  </form></Modal>;
}

export function ObjectiveEvidenceList({ evaluation, ids }: { evaluation: ObjectiveEvaluation; ids: string[] }) {
  const [reading, setReading] = useState<ObjectiveEvidence | null>(null);
  const action = useAction();
  const evidence = evaluation.evidence ?? [];
  return <div className="objective-evidence"><span>판정 근거</span>{ids.map(id => {
    const item = evidence.find(entry => entry.id === id);
    return <details key={id}><summary>{item?.title ?? '근거 원문 미확인'}{item ? ` · ${item.kind === 'artifact' ? '공유 자료' : item.kind === 'task_report' ? '작업자 보고' : '사용자 확인'} · v${item.version}` : ''}</summary>
      {item ? <><small>출처 {item.sourceId} · 평가 당시 고정본</small><small className="mono">{item.hashEncoding === 'utf8' ? '원문 SHA-256' : 'JSON 문자열 해시'} {item.sha256}</small>
        <button className="text-link" disabled={action.pending} onClick={() => void action.execute(async () => {
          setReading(await request<ObjectiveEvidence>(`/objectives/${evaluation.objectiveId}/evaluations/${evaluation.id}/evidence/${encodeURIComponent(id)}`));
        })}>{action.pending ? '원문 조회 중' : '평가에 사용한 원문 보기'} <ArrowRight size={12} /></button></>
        : <p className="inline-note">평가에 사용한 고정 원문을 조회하지 못했습니다. 현재 자료로 대체하지 않습니다.</p>}
      <small className="mono">근거 ID {id}</small>
    </details>;
  })}<ErrorNotice message={action.error} />{reading ? <Modal title={reading.title} eyebrow={`평가 당시 고정본 · v${reading.version}`} onClose={() => setReading(null)} wide>
    <TextContent text={reading.content} className="collaboration-document" /><small className="mono">출처 {reading.sourceId} · {reading.hashEncoding === 'utf8' ? '원문 SHA-256' : 'JSON 문자열 해시'} {reading.sha256}</small>
  </Modal> : null}</div>;
}

function ObjectiveTask({ task, objective, workspace, onSelect }: { task: TeamTask; objective: Objective; workspace: Workspace; onSelect: (id: string) => void }) {
  const run = teamTaskRun(task, workspace.runs);
  return <details className="objective-task"><summary><strong>{task.title}</strong><span className={`tag ${task.status === 'done' ? 'tag-green' : ''}`}>
    {task.status === 'done' ? '완료' : task.status === 'claimed' ? '담당 중' : '참여 가능'}</span></summary>
    <TextContent text={task.description} /><small>{scopeName(workspace, task.scope)} · 과제 {task.id}</small>
    {task.objectiveConditionIds?.length ? <div className="collaboration-meta">{task.objectiveConditionIds.map(id => <span className="tag" key={id}>
      연결 조건 · {objective.conditions.find(condition => condition.id === id)?.text ?? '이전 완료 조건'}</span>)}</div> : null}
    {task.outcome ? <div className="collaboration-outcome"><h4>작업 결과</h4><TextContent text={task.outcome} /></div> : null}
    {run ? <div className="collaboration-meta"><Status status={run.status} /><button className="text-link" onClick={() => onSelect(run.agentId)}>실행 에이전트 <ArrowRight size={12} /></button>
      {run.conversationId ? <a className="text-link" href={conversationHref(run.conversationId)}>연결 작업 대화</a> : null}<span className="mono" title={run.id}>Run {run.id.slice(0, 8)}</span></div> : null}
  </details>;
}

function ObjectiveHistory({ evaluation, workspace, onSelect }: { evaluation: ObjectiveEvaluation; workspace: Workspace; onSelect: (id: string) => void }) {
  const run = workspace.runs.find(item => item.id === evaluation.runId);
  return <details className="objective-evaluation"><summary><History size={14} /><DateLabel value={evaluation.createdAt} time />
    <span className={`tag ${evaluation.status === 'failed' ? 'tag-red' : evaluation.status === 'applied' ? 'tag-green' : ''}`}>{evaluationLabels[evaluation.status]}</span></summary>
    <TextContent text={evaluation.reason || evaluation.assessment?.reason || '평가 결과를 기다립니다.'} />
    {run ? <div className="collaboration-meta"><Status status={run.status} /><button className="text-link" onClick={() => onSelect(run.agentId)}>평가 에이전트 <ArrowRight size={12} /></button>
      {run.error ? <TextContent text={run.error} /> : null}</div> : null}
    {evaluation.assessment?.conditions.map(item => <div className="objective-history-condition" key={item.conditionId}><strong>{item.conditionId} · {conditionLabels[item.status]}</strong>
      <TextContent text={item.reason} />{item.evidenceIds.length ? <ObjectiveEvidenceList evaluation={evaluation} ids={item.evidenceIds} /> : null}</div>)}
    <small>목적 v{evaluation.objectiveVersion} · 평가 {evaluation.id}</small><small className="mono">입력 {evaluation.inputHash}</small>
  </details>;
}

export function ObjectiveGrowth({ workspace, tasks, onSelect }: { workspace: Workspace; tasks: TeamTask[]; onSelect: (id: string) => void }) {
  const taskIds = new Set(tasks.map(task => task.id));
  const claimedIds = new Set(tasks.flatMap(task => [...(task.claimRunIds ?? []), ...(task.claimedRunId ? [task.claimedRunId] : [])]));
  const taskRuns = workspace.runs.filter(run => claimedIds.has(run.id) || run.teamTaskId && taskIds.has(run.teamTaskId));
  const rootIds = new Set(taskRuns.map(run => run.budgetRootRunId ?? run.id));
  const runs = workspace.runs.filter(run => taskRuns.includes(run) || run.budgetRootRunId && rootIds.has(run.budgetRootRunId));
  const runIds = new Set(runs.map(run => run.id));
  const snapshotIds = new Set(runs.map(run => run.snapshotId));
  const supplied = new Map(workspace.snapshots.filter(snapshot => snapshotIds.has(snapshot.id)).flatMap(snapshot => snapshot.memories.map(memory => [memory.id, memory] as const)));
  const created = workspace.memories.filter(memory => memory.sourceRunId && runIds.has(memory.sourceRunId));
  const reviews = (workspace.growthReviews ?? []).filter(review => runIds.has(review.sourceRunId));
  return <section className="objective-section" aria-label="목적의 기억·성장 기록"><SectionTitle title="기억·성장 기록" detail="후속 작업에 제공한 기억과 작업에서 남긴 비교 판정을 확인합니다." />
    <div className="objective-growth-counts"><span>작업에 제공한 기존 기억 <strong>{supplied.size}</strong></span><span>작업에서 남긴 기억 <strong>{created.length}</strong></span>
      <span>스킬 비교 판정 <strong>{reviews.length}</strong></span></div>
    <p className="inline-note">기억 제공 기록은 실제 활용이나 품질 개선의 판정과 구분합니다.</p>
    {supplied.size || created.length ? <details className="objective-memory-list"><summary>연결된 기억 출처</summary>
      {[...new Map([...supplied, ...created.map(memory => [memory.id, memory] as const)]).values()].map(memory => <div key={memory.id}><strong>{memory.title}</strong>
        <button className="text-link" onClick={() => onSelect(memory.agentId)}>에이전트 기억 보기 <ArrowRight size={12} /></button>
        <small>{memory.sourceRunId ? `출처 Run ${memory.sourceRunId}` : '사용자 등록·이전 기억'}</small></div>)}
    </details> : null}
    {reviews.map(review => <div className="objective-growth-review" key={review.id}><Sparkles size={14} /><div>
      <strong>{review.verdict === 'improved' ? '개선' : review.verdict === 'equivalent' ? '동등' : review.verdict === 'regressed' ? '회귀' : '판정 유보'}</strong>
      <TextContent text={review.reason} /><button className="text-link" onClick={() => onSelect(review.agentId)}>에이전트 성장 이력 <ArrowRight size={12} /></button>
    </div></div>)}
    {!reviews.length ? <p className="inline-note">이 목적의 후속 작업에 연결된 품질 비교 판정이 없습니다.</p> : null}
  </section>;
}
