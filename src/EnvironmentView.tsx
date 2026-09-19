import { useState } from 'react';
import { Check, CircleAlert, Package, Plus, RotateCcw, Square, Trash2 } from 'lucide-react';
import type { Agent, Workspace } from '../shared/types';
import { environmentProposalSchema, type EnvironmentProposal, type EnvironmentRevision } from '../shared/environment';
import { request, useAction } from './api';
import { DateLabel, Empty, ErrorNotice, Field, SectionTitle, TextContent } from './ui';
import { operatorRequestHref } from './OperatorRequestsView';

const statusLabels: Record<EnvironmentRevision['status'], string> = {
  queued: '구축 대기', building: '구축 중', ready: '검증 통과', failed: '검증 실패', blocked: '접근 확대 차단', cancelled: '구축 취소',
};
const inProgress = (status: EnvironmentRevision['status']) => status === 'queued' || status === 'building';

export interface EnvironmentDraft {
  reason: string;
  packages: Array<{ name: string; version: string }>;
  servers: Array<{ name: string; package: string; bin: string; args: string; tool: string; arguments: string }>;
  requestedAccess: string;
}

export function environmentDraft(revision?: Pick<EnvironmentRevision, 'reason' | 'spec' | 'requestedAccess'>): EnvironmentDraft {
  return { reason: revision?.reason ?? '', packages: revision?.spec.packages.map(item => ({ ...item })) ?? [],
    servers: revision?.spec.servers.map(server => ({ name: server.name, package: server.package, bin: server.bin,
      args: JSON.stringify(server.args), tool: server.probe.tool, arguments: JSON.stringify(server.probe.arguments, null, 2) })) ?? [],
    requestedAccess: revision?.requestedAccess.join('\n') ?? '' };
}

/** Parsing never changes the editor draft, including invalid JSON and rejected proposals. */
export function parseEnvironmentDraft(draft: EnvironmentDraft): EnvironmentProposal {
  const spec = { packages: draft.packages.map(item => ({ name: item.name.trim(), version: item.version.trim() })),
    servers: draft.servers.map((server, index) => {
      let args: unknown; let argumentsValue: unknown;
      try { args = JSON.parse(server.args); } catch { throw new Error(`MCP ${index + 1}의 실행 인자는 JSON 배열이어야 합니다.`); }
      try { argumentsValue = JSON.parse(server.arguments); } catch { throw new Error(`MCP ${index + 1}의 검증 입력은 JSON 객체여야 합니다.`); }
      return { name: server.name.trim(), package: server.package.trim(), bin: server.bin.trim(), args,
        probe: { tool: server.tool.trim(), arguments: argumentsValue } };
    }) };
  const parsed = environmentProposalSchema.safeParse({ reason: draft.reason, spec,
    requestedAccess: draft.requestedAccess.split('\n').map(value => value.trim()).filter(Boolean) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`환경 구성 확인: ${issue.path.join('.') || '구성'} · ${issue.message}`);
  }
  return parsed.data;
}

export function EnvironmentView({ agent, workspace, busy, refresh }: {
  agent: Agent; workspace: Workspace; busy: boolean; refresh: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<{ key: number; draft: EnvironmentDraft } | null>(null);
  const action = useAction();
  const revisions = (workspace.environmentRevisions ?? []).filter(item => item.agentId === agent.id)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const selected = revisions.find(item => item.id === agent.environmentRevisionId);
  const building = revisions.some(item => inProgress(item.status));
  const unavailable = busy || building || action.pending;
  const edit = (revision?: EnvironmentRevision) => setEditor(current => ({ key: (current?.key ?? 0) + 1, draft: environmentDraft(revision) }));
  const select = (revisionId: string | null) => {
    if (unavailable) return;
    void action.execute(async () => { await request(`/agents/${agent.id}/environments/select`, 'POST', { revisionId }); await refresh(); });
  };

  return <div className="environment-view">
    <SectionTitle title="개인 작업 환경" detail="패키지와 MCP를 격리된 환경에서 검증하고 다음 작업부터 적용합니다."
      action={<button className="button" disabled={editor !== null || action.pending} onClick={() => edit()}><Plus size={15} />환경 구성</button>} />
    <div className="environment-current">
      <Package size={20} /><div><span className="eyebrow">NEXT RUN</span><h3>{selected ? `환경 ${selected.id.slice(0, 8)}` : agent.environmentRevisionId ? '선택된 환경 기록 미확인' : '기본 환경'}</h3>
        <p>{selected ? selected.reason : agent.environmentRevisionId ? '선택된 환경을 확인하기 전에는 정상 적용으로 표시하지 않습니다.' : '추가 개인 패키지·MCP 없이 기본 실행 환경을 사용합니다.'}</p>
        {selected ? <span className="environment-meta">패키지 {selected.spec.packages.length}개 · MCP {selected.spec.servers.length}개 · {statusLabels[selected.status]}</span> : null}
      </div>
      {agent.environmentRevisionId ? <button className="button subtle" disabled={unavailable} onClick={() => select(null)}><RotateCcw size={14} />기본 환경으로 복귀</button> : null}
    </div>
    <p className="inline-note">진행 중인 작업의 환경은 바뀌지 않습니다. 실패·차단·취소 시 기존 환경을 유지합니다.</p>
    {busy || building ? <p className="inline-note" role="status">작업이나 환경 구축이 진행 중이므로 환경 적용과 새 구축은 대기합니다. 구성 초안은 작성할 수 있습니다.</p> : null}
    <ErrorNotice message={action.error} />
    {editor ? <EnvironmentProposalForm key={editor.key} agentId={agent.id} initialDraft={editor.draft} busy={unavailable}
      onClose={() => setEditor(null)} onSaved={async () => { await refresh(); setEditor(null); }} /> : null}
    {revisions.length ? <div className="environment-versions">{revisions.map(revision => <article className="environment-revision" key={revision.id}>
      <div className="environment-version-heading"><div><h3><span className="mono">{revision.id.slice(0, 8)}</span>{revision.id === agent.environmentRevisionId ? <span className="tag">다음 작업에 사용</span> : null}</h3>
        <p><DateLabel value={revision.createdAt} time /> · {revision.sourceRunId ? '에이전트 제안' : revision.sourceRevisionId ? '복제한 환경' : '직접 구성'}</p></div>
        <span className={`tag environment-status-${revision.status}`}>{statusLabels[revision.status]}</span></div>
      <TextContent text={revision.reason} />
      <EnvironmentConfiguration revision={revision} />
      {revision.requestedAccess.length ? <div className="environment-access"><strong><CircleAlert size={15} />추가 접근 요청</strong><ul>{revision.requestedAccess.map((access, index) => <li key={index}>{access}</li>)}</ul>
        <p>추가 접근은 대표 요청함에서 결정·처리·검증합니다. 승인만으로 계정 연결이나 권한이 추가되지는 않습니다.</p>
        {(workspace.operatorRequests ?? []).filter(item => item.links.environmentRevisionId === revision.id).map(item => <a className="text-link" key={item.id} href={operatorRequestHref(item.id)}>대표 요청 확인 · {item.title}</a>)}
        {!(workspace.operatorRequests ?? []).some(item => item.links.environmentRevisionId === revision.id) ? <a className="text-link" href="#requests">대표 요청함 확인</a> : null}</div> : null}
      {revision.error ? <ErrorNotice message={revision.error} /> : null}
      {revision.report ? <details className="environment-report" open={revision.status === 'failed'}><summary>검증 결과 · {revision.report.checks.filter(check => check.passed).length}/{revision.report.checks.length} 통과</summary>
        {revision.report.checks.length ? <ul className="environment-checks">{revision.report.checks.map((check, index) => <li key={index} className={check.passed ? 'passed' : 'failed'}>
          {check.passed ? <Check size={15} /> : <CircleAlert size={15} />}<div><strong>{check.name} · {check.passed ? '통과' : '실패'}</strong><TextContent text={check.detail} /></div></li>)}</ul> : <p className="inline-note">개별 검사 기록이 없습니다.</p>}
        <div className="environment-tool-list"><strong>확인된 MCP 도구 · {revision.report.tools.length}개</strong>{revision.report.tools.map(tool => <div key={`${tool.server}/${tool.name}`}><code>{tool.server}/{tool.name}</code><p>{tool.description}</p></div>)}</div>
        <dl className="environment-hashes"><div><dt>실행 이미지</dt><dd>{revision.report.imageId}</dd></div><div><dt>구성 내용 해시</dt><dd>{revision.report.contentHash}</dd></div><div><dt>잠금 파일 해시</dt><dd>{revision.report.lockfileHash}</dd></div></dl>
      </details> : <p className="inline-note">완료된 검증 보고서가 없습니다.</p>}
      <div className="environment-actions">
        {revision.status === 'ready' && revision.id !== agent.environmentRevisionId ? <button className="button" disabled={unavailable} onClick={() => select(revision.id)}>이 환경 사용</button> : null}
        {inProgress(revision.status) ? <button className="button danger-subtle" disabled={action.pending} onClick={() => void action.execute(async () => { await request(`/environments/${revision.id}/cancel`, 'POST', {}); await refresh(); })}><Square size={13} />구축 취소</button> : null}
        <button className="button subtle" disabled={editor !== null || action.pending} onClick={() => edit(revision)}>구성을 복사해 편집</button>
        {revision.baseRevisionId ? <span className="environment-meta">기준 {revision.baseRevisionId.slice(0, 8)}</span> : null}
      </div>
    </article>)}</div> : <Empty icon={<Package size={25} />} title="추가 개인 환경이 없습니다" detail="에이전트의 환경 제안과 직접 구성한 패키지·MCP 버전을 이곳에 보존합니다." />}
  </div>;
}

function EnvironmentConfiguration({ revision }: { revision: EnvironmentRevision }) {
  return <div className="environment-configuration"><div><h4>패키지 · {revision.spec.packages.length}개</h4>
    {revision.spec.packages.length ? <ul>{revision.spec.packages.map(item => <li key={item.name}><code>{item.name}</code><span className="mono">{item.version}</span></li>)}</ul> : <p>추가 패키지 없음</p>}</div>
    <div><h4>MCP · {revision.spec.servers.length}개</h4>{revision.spec.servers.length ? revision.spec.servers.map(server => <details key={server.name}><summary>{server.name} <span className="environment-meta">{server.probe.tool} 검증</span></summary>
      <p className="mono">{server.package} · {server.bin}</p><TextContent text={`실행 인자: ${JSON.stringify(server.args)}\n검증 입력: ${JSON.stringify(server.probe.arguments, null, 2)}`} className="mono" /></details>) : <p>추가 MCP 없음</p>}</div>
  </div>;
}

export function EnvironmentProposalForm({ agentId, initialDraft, busy, onClose, onSaved }: {
  agentId: string; initialDraft: EnvironmentDraft; busy: boolean; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const action = useAction();
  const patchPackage = (index: number, patch: Partial<EnvironmentDraft['packages'][number]>) => setDraft(current => ({ ...current,
    packages: current.packages.map((item, position) => position === index ? { ...item, ...patch } : item) }));
  const patchServer = (index: number, patch: Partial<EnvironmentDraft['servers'][number]>) => setDraft(current => ({ ...current,
    servers: current.servers.map((item, position) => position === index ? { ...item, ...patch } : item) }));
  const accessRequested = draft.requestedAccess.trim().length > 0;
  return <form className="environment-editor form-stack" onSubmit={event => { event.preventDefault(); if (busy) return;
    void action.execute(async () => { const proposal = parseEnvironmentDraft(draft); await request(`/agents/${agentId}/environments`, 'POST', proposal); await onSaved(); }); }}>
    <h3>환경 구성 초안</h3><p className="inline-note">공개 npm 패키지의 정확한 버전을 사용합니다. 설치 스크립트와 외부 네트워크 MCP는 지원하지 않습니다.</p>
    <fieldset disabled={action.pending} className="environment-fields">
      <Field label="변경 목적"><textarea rows={2} required maxLength={4000} value={draft.reason} onChange={event => setDraft(current => ({ ...current, reason: event.target.value }))} /></Field>
      <div className="environment-editor-heading"><h4>패키지</h4><button type="button" className="button subtle" disabled={draft.packages.length >= 10} onClick={() => setDraft(current => ({ ...current, packages: [...current.packages, { name: '', version: '' }] }))}><Plus size={13} />패키지 추가</button></div>
      {draft.packages.map((item, index) => <div className="environment-package-row" key={index}>
        <Field label={`패키지 ${index + 1} 이름`}><input required maxLength={214} value={item.name} placeholder="패키지 이름" onChange={event => patchPackage(index, { name: event.target.value })} /></Field>
        <Field label={`패키지 ${index + 1} 버전`}><input required maxLength={80} value={item.version} placeholder="정확한 버전" onChange={event => patchPackage(index, { version: event.target.value })} /></Field>
        <button type="button" className="icon-button" aria-label={`패키지 ${index + 1} 삭제`} onClick={() => setDraft(current => ({ ...current, packages: current.packages.filter((_, position) => position !== index) }))}><Trash2 size={15} /></button>
      </div>)}
      <div className="environment-editor-heading"><h4>MCP 서버</h4><button type="button" className="button subtle" disabled={draft.servers.length >= 2} onClick={() => setDraft(current => ({ ...current, servers: [...current.servers,
        { name: '', package: current.packages[0]?.name ?? '', bin: '', args: '[]', tool: '', arguments: '{}' }] }))}><Plus size={13} />MCP 추가</button></div>
      {draft.servers.map((server, index) => <fieldset key={index} className="environment-server-fields"><legend>MCP {index + 1}</legend>
        <div className="form-columns"><Field label={`MCP ${index + 1} 이름`}><input required value={server.name} maxLength={40} onChange={event => patchServer(index, { name: event.target.value })} /></Field>
          <Field label={`MCP ${index + 1} 패키지`}><input required value={server.package} maxLength={214} onChange={event => patchServer(index, { package: event.target.value })} /></Field></div>
        <Field label={`MCP ${index + 1} 실행 파일`}><input required value={server.bin} maxLength={80} onChange={event => patchServer(index, { bin: event.target.value })} /></Field>
        <Field label={`MCP ${index + 1} 실행 인자`} hint="JSON 문자열 배열입니다. 인자가 없으면 []입니다."><textarea rows={2} className="mono" required maxLength={24000} value={server.args} onChange={event => patchServer(index, { args: event.target.value })} /></Field>
        <Field label={`MCP ${index + 1} 검증 도구`}><input required value={server.tool} maxLength={100} onChange={event => patchServer(index, { tool: event.target.value })} /></Field>
        <Field label={`MCP ${index + 1} 검증 입력`} hint="실제로 호출할 도구 입력입니다. JSON 객체로 작성합니다."><textarea rows={3} className="mono" required maxLength={32768} value={server.arguments} onChange={event => patchServer(index, { arguments: event.target.value })} /></Field>
        <button type="button" className="button subtle" onClick={() => setDraft(current => ({ ...current, servers: current.servers.filter((_, position) => position !== index) }))}><Trash2 size={14} />MCP {index + 1} 삭제</button>
      </fieldset>)}
      <Field label="추가 접근 요청" hint="기존 범위를 넘는 접근만 줄마다 기록합니다. 인증 키·비밀번호는 입력하지 않습니다."><textarea rows={2} maxLength={5100} value={draft.requestedAccess} onChange={event => setDraft(current => ({ ...current, requestedAccess: event.target.value }))} /></Field>
    </fieldset>
    {accessRequested ? <p className="inline-note">추가 접근 요청이 있어 차단 상태로 기록합니다. 설치·검증·권한 변경은 실행하지 않습니다.</p> : null}
    <ErrorNotice message={action.error} /><div className="environment-actions"><button type="button" className="button subtle" disabled={action.pending} onClick={onClose}>작성 닫기</button>
      <button type="submit" className="button primary" disabled={busy || action.pending || !draft.reason.trim()}>{action.pending ? '저장 중' : accessRequested ? '요청 기록' : '구축·검증 시작'}</button></div>
  </form>;
}
