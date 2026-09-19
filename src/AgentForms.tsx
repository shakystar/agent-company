import { useState } from 'react';
import { GitFork, Globe, LockKeyhole, Plus } from 'lucide-react';
import type { Agent, Memory, Snapshot, Workspace } from '../shared/types';
import { request, useAction } from './api';
import { Avatar, ColorPicker, colors, ErrorNotice, Field, Modal, Submit } from './ui';

export const starters = [
  { name: '리서처', description: '질문에서 근거까지', persona: '불확실한 질문을 탐구합니다. 자료의 출처와 한계를 확인하고, 서로 다른 관점을 비교해 근거가 있는 결론을 제시합니다.', color: colors[0] },
  { name: '메이커', description: '아이디어에서 결과물까지', persona: '아이디어를 작동하는 결과물로 만듭니다. 목표를 이해하고 적합한 방법을 선택하며, 만든 결과를 검증하고 개선합니다.', color: colors[1] },
  { name: '에디터', description: '초안에서 명료함까지', persona: '글의 의도와 독자를 이해하고 구조와 표현을 다듬습니다. 원래의 목소리를 보존하며 정확하고 명료한 문장을 만듭니다.', color: colors[2] },
];
type AgentDraft = Pick<Agent, 'name' | 'description' | 'persona' | 'color'>;

export function AgentForm({ workspace, agent, starter, onClose, onSaved }: { workspace: Workspace; agent?: Agent; starter?: AgentDraft; onClose: () => void; onSaved: (agent: Agent) => Promise<void> }) {
  const [draft, setDraft] = useState({ name: agent?.name ?? starter?.name ?? '', description: agent?.description ?? starter?.description ?? '', persona: agent?.persona ?? starter?.persona ?? '', color: agent?.color ?? starter?.color ?? colors[0], model: agent?.model ?? workspace.runtime.model, allowWeb: agent?.allowWeb ?? false, repositoryIds: agent?.repositoryIds ?? [] as string[] });
  const action = useAction();
  const patch = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  return <Modal title={agent ? '에이전트 설정' : '새로운 에이전트'} eyebrow={agent ? 'IDENTITY' : 'A NEW BEGINNING'} onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => { const saved = await request<Agent>(agent ? `/agents/${agent.id}` : '/agents', agent ? 'PATCH' : 'POST', draft); await onSaved(saved); }); }}>
      <div className="identity-preview"><Avatar agent={{ name: draft.name || 'A', color: draft.color }} size="large" /><div><span className="field-label">고유한 색상</span><ColorPicker value={draft.color} onChange={value => patch('color', value)} /></div></div>
      <div className="form-columns"><Field label="이름"><input required maxLength={100} value={draft.name} placeholder="에이전트의 이름" onChange={event => patch('name', event.target.value)} autoFocus /></Field><Field label="한 줄 소개"><input maxLength={2000} value={draft.description} placeholder="어떤 일을 함께할지" onChange={event => patch('description', event.target.value)} /></Field></div>
      <Field label="페르소나" hint="관점과 작업 방식을 자유롭게 작성할 수 있습니다."><textarea required rows={6} maxLength={100000} value={draft.persona} placeholder="이 에이전트는 어떤 관점으로 판단하고 작업합니까?" onChange={event => patch('persona', event.target.value)} /></Field>
      <Field label="모델"><input required value={draft.model} maxLength={100} onChange={event => patch('model', event.target.value)} /></Field>
      <div className="permission-block"><div className="permission-label"><Globe size={18} /><div><strong>웹 접근</strong><small>허용된 웹 도구 사용</small></div><input aria-label="웹 접근 허용" type="checkbox" checked={draft.allowWeb} onChange={event => patch('allowWeb', event.target.checked)} /></div>
        {workspace.connections.length ? <div className="connection-options">{workspace.connections.map(connection => <label key={connection.id}><input type="checkbox" checked={draft.repositoryIds.includes(connection.id)} onChange={event => patch('repositoryIds', event.target.checked ? [...draft.repositoryIds, connection.id] : draft.repositoryIds.filter(id => id !== connection.id))} /><span>{connection.repository}</span><small>{connection.access === 'read' ? '읽기' : '읽기·쓰기'}</small></label>)}</div> : <p className="permission-note"><LockKeyhole size={13} />연결된 저장소가 없습니다. 저장소 접근은 자동으로 확대되지 않습니다.</p>}
      </div>
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" onClick={onClose} disabled={action.pending}>취소</button><Submit pending={action.pending}>{agent ? '변경 저장' : <><Plus size={16} />에이전트 생성</>}</Submit></div>
    </form>
  </Modal>;
}

export function ForkForm({ agent, snapshots, initialSnapshotId, onClose, onSaved }: { agent: Agent; snapshots: Snapshot[]; initialSnapshotId?: string; onClose: () => void; onSaved: (agent: Agent) => Promise<void> }) {
  const [name, setName] = useState(`${agent.name} · fork`);
  const [persona, setPersona] = useState(agent.persona);
  const [snapshotId, setSnapshotId] = useState(initialSnapshotId ?? '');
  const action = useAction();
  const selected = snapshots.find(snapshot => snapshot.id === snapshotId);
  return <Modal title="새로운 갈래 만들기" eyebrow="FORK AN AGENT" onClose={onClose} busy={action.pending}>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => { const saved = await request<Agent>(`/agents/${agent.id}/fork`, 'POST', { name, persona, ...(snapshotId ? { snapshotId } : {}) }); await onSaved(saved); }); }}>
      <div className="fork-origin"><Avatar agent={agent} /><div><strong>{agent.name}</strong><span>경험은 이어받고, 이후의 변화는 독립적으로 쌓습니다.</span></div><GitFork size={21} /></div>
      <Field label="복제 시점"><select value={snapshotId} onChange={event => { const id = event.target.value; setSnapshotId(id); setPersona(snapshots.find(snapshot => snapshot.id === id)?.agent.persona ?? agent.persona); }}><option value="">현재 상태 · v{agent.version}</option>{snapshots.map(snapshot => <option value={snapshot.id} key={snapshot.id}>{snapshot.label} · v{snapshot.agentVersion}</option>)}</select></Field>
      {selected ? <div className="inline-note">기억 {selected.memories.length}개 · 스킬 {selected.skills.filter(skill => skill.status === 'active').length}개를 이어받습니다.</div> : null}
      <Field label="새 이름"><input required maxLength={100} value={name} onChange={event => setName(event.target.value)} autoFocus /></Field>
      <Field label="새 페르소나"><textarea required rows={5} maxLength={100000} value={persona} onChange={event => setPersona(event.target.value)} /></Field>
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" onClick={onClose} disabled={action.pending}>취소</button><Submit pending={action.pending}><GitFork size={16} />복제</Submit></div>
    </form>
  </Modal>;
}

export function RestoreForm({ agent, snapshot, onClose, onSaved }: { agent: Agent; snapshot: Snapshot; onClose: () => void; onSaved: () => Promise<void> }) {
  const [memory, setMemory] = useState(true);
  const [skills, setSkills] = useState(true);
  const [files, setFiles] = useState(true);
  const [environment, setEnvironment] = useState(true);
  const action = useAction();
  return <Modal title="이 시점으로 복원" eyebrow="RESTORE A VERSION" onClose={onClose} busy={action.pending}>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => { await request(`/agents/${agent.id}/restore`, 'POST', { snapshotId: snapshot.id, restoreMemory: memory, restoreSkills: skills, restoreFiles: files, restoreEnvironment: environment }); await onSaved(); }); }}>
      <div className="notice"><strong>{snapshot.label} · v{snapshot.agentVersion}</strong><p>페르소나·설정을 선택한 버전으로 되돌립니다. 현재 상태는 복원 전 스냅샷으로 보존되며, 작업 기록은 유지됩니다.</p></div>
      <label className="check-row"><input type="checkbox" checked={memory} onChange={event => setMemory(event.target.checked)} />기억도 복원 ({snapshot.memories.length}개)</label>
      <label className="check-row"><input type="checkbox" checked={skills} onChange={event => setSkills(event.target.checked)} />스킬도 복원 ({snapshot.skills.length}개)</label>
      <label className="check-row"><input type="checkbox" checked={files} onChange={event => setFiles(event.target.checked)} />작업 파일도 복원 ({snapshot.agent.workspaceRunId ? '보존된 파일 버전' : '빈 작업공간'})</label>
      <label className="check-row"><input type="checkbox" checked={environment} onChange={event => setEnvironment(event.target.checked)} />개인 환경도 복원 ({snapshot.agent.environmentRevisionId ? '보존된 패키지·MCP 버전' : '기본 환경'})</label>
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" onClick={onClose} disabled={action.pending}>취소</button><Submit pending={action.pending}>선택한 시점으로 복원</Submit></div>
    </form>
  </Modal>;
}

export function KnowledgeForm({ agent, kind, memory, onClose, onSaved }: { agent: Agent; kind: 'memory' | 'skill'; memory?: Memory; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(memory?.title ?? '');
  const [content, setContent] = useState(memory?.content ?? '');
  const [memoryKind, setMemoryKind] = useState<Memory['kind']>(memory?.kind ?? 'fact');
  const [description, setDescription] = useState('');
  const action = useAction();
  return <Modal title={kind === 'memory' ? memory ? '기억 편집' : '기억 추가' : '스킬 추가'} eyebrow={agent.name} onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
      if (kind === 'memory') await request(memory ? `/memories/${memory.id}` : `/agents/${agent.id}/memories`, memory ? 'PATCH' : 'POST', { kind: memoryKind, title, content });
      else await request(`/agents/${agent.id}/skills`, 'POST', { name: title, description, content });
      await onSaved();
    }); }}>
      <Field label={kind === 'memory' ? '제목' : '스킬 이름'}><input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} autoFocus /></Field>
      {kind === 'memory' ? <Field label="분류"><select value={memoryKind} onChange={event => setMemoryKind(event.target.value as Memory['kind'])}><option value="fact">지식</option><option value="preference">선호</option><option value="procedure">절차</option></select></Field> : <Field label="적용 조건과 설명"><input required maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></Field>}
      <Field label="내용"><textarea required rows={9} maxLength={100000} className={kind === 'skill' ? 'mono' : ''} value={content} onChange={event => setContent(event.target.value)} placeholder={kind === 'skill' ? '# 스킬\n\n적용 조건과 작업 방식' : '다음 작업에서 이어갈 내용'} /></Field>
      <ErrorNotice message={action.error} /><div className="modal-actions"><button className="button subtle" type="button" disabled={action.pending} onClick={onClose}>취소</button><Submit pending={action.pending}>저장</Submit></div>
    </form>
  </Modal>;
}
