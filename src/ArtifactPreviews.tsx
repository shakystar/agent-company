import { useEffect, useRef, useState } from 'react';
import { Download, Monitor, Play, Send, X } from 'lucide-react';
import type { Workspace } from '../shared/types';
import type { CollaborationScope, SharedArtifact } from '../shared/collaboration';
import type { ArtifactPreviewManifest, ArtifactPreviewSession } from '../shared/artifact-preview';
import { request, useAction } from './api';
import { DateLabel, ErrorNotice, Field } from './ui';
import { conversationHref } from './ConversationView';

const sameScope = (a: CollaborationScope, b: { type: string; id: string }) => a.type === b.type && a.id === b.id;
export const artifactPreviewDownloadHref = (id: string) => `/api/artifact-previews/${encodeURIComponent(id)}/download`;
export function previewFolderChoices(artifacts: SharedArtifact[]): string[] {
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (!/\.html?$/i.test(artifact.name)) continue;
    const parts = artifact.name.split('/');
    if (parts.length === 1) paths.add('');
    for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
  }
  return [...paths].sort();
}
export function previewVersionRefs(artifacts: SharedArtifact[], prefix: string) {
  return artifacts.filter(item => !prefix || item.name.startsWith(`${prefix}/`)).map(item => ({ artifactId: item.id, version: item.version }));
}

export function ArtifactPreviews({ workspace, scope, refresh, conversationId }: {
  workspace: Workspace; scope: CollaborationScope; refresh: () => Promise<void>; conversationId?: string;
}) {
  const artifacts = (workspace.sharedArtifacts ?? []).filter(item => sameScope(scope, item.scope));
  const manifests = (workspace.artifactPreviews ?? []).filter(item => sameScope(scope, item.scope));
  const folders = previewFolderChoices(artifacts);
  const [folder, setFolder] = useState<string | null>(null);
  const prefix = folder ?? folders[0] ?? '';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);
  const selected = manifests.find(item => item.id === selectedId) ?? (selectedId ? undefined : manifests[0]);
  const action = useAction();
  return <details className="artifact-previews" aria-label="산출물 미리보기·검수">
    <summary><Monitor size={16} aria-hidden="true" />산출물 미리보기·검수<span className="tag">{manifests.length}개 버전</span></summary>
    <div className="artifact-preview-body">
      <p className="inline-note">공유한 정적 사이트를 직접 조작합니다. 파일 버전을 묶어 보존하며, 새 작업이 이전 검수 화면을 덮어쓰지 않습니다.</p>
      {folders.length ? <form className="preview-controls" onSubmit={event => {
        event.preventDefault(); void action.execute(async () => {
          const created = await request<ArtifactPreviewManifest>('/artifact-previews', 'POST', {
            scope, prefix, versions: previewVersionRefs(artifacts, prefix),
          });
          await refresh(); setSelectedId(created.id);
        });
      }}><Field label="사이트 폴더"><select value={prefix} onChange={event => setFolder(event.target.value)} disabled={action.pending || viewerBusy}>
        {folders.map(path => <option key={path} value={path}>{path || '공유 자료 전체'}</option>)}
      </select></Field><button type="submit" className="button" disabled={action.pending || viewerBusy}>
        {action.pending ? '버전 고정 중' : '현재 파일을 새 검수 버전으로 저장'}</button></form>
        : <p>이 공간에 HTML 공유 자료가 없습니다. 팀이 사이트 파일을 공유하면 미리보기를 만들 수 있습니다.</p>}
      <ErrorNotice message={action.error} />
      {manifests.length ? <Field label="검수 버전"><select value={selected?.id ?? ''} disabled={action.pending || viewerBusy}
        onChange={event => setSelectedId(event.target.value)}>
        {!selected ? <option value="">현재 작업실의 버전 선택</option> : null}
        {manifests.map(item => <option key={item.id} value={item.id}>{item.prefix || '/'} · {item.sourceHash.slice(0, 10)} · {new Date(item.createdAt).toLocaleString('ko-KR')}</option>)}
      </select></Field> : null}
      {selected ? <ArtifactPreviewViewer key={selected.id} manifest={selected} workspace={workspace} refresh={refresh} conversationId={conversationId} onBusyChange={setViewerBusy} /> : null}
    </div>
  </details>;
}

export function ArtifactPreviewViewer({ manifest, workspace, refresh, conversationId, onBusyChange }: {
  manifest: ArtifactPreviewManifest; workspace: Workspace; refresh: () => Promise<void>; conversationId?: string; onBusyChange?: (busy: boolean) => void;
}) {
  const [entrypoint, setEntrypoint] = useState(manifest.entrypoints.includes('index.html') ? 'index.html' : manifest.entrypoints[0] ?? '');
  const [session, setSession] = useState<ArtifactPreviewSession | null>(null);
  const [expired, setExpired] = useState(false);
  const [width, setWidth] = useState('100%');
  const action = useAction();
  const mounted = useRef(true);
  useEffect(() => { onBusyChange?.(action.pending); return () => onBusyChange?.(false); }, [action.pending, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Sessions are shared by manifest; passive viewers leave them to explicit close or expiry.
    };
  }, [manifest.id]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  return <section className="artifact-preview-viewer" aria-label="선택한 산출물 검수">
    <div className="preview-provenance"><span className="mono" title={manifest.sourceHash}>소스 {manifest.sourceHash.slice(0, 16)}</span>
      <span>{manifest.entries.length}개 파일 · {Math.ceil(manifest.totalBytes / 1024).toLocaleString()} KiB</span><DateLabel value={manifest.createdAt} time />
      <a className="text-link" href={artifactPreviewDownloadHref(manifest.id)} download><Download size={14} />전체 ZIP 다운로드</a>
    </div>
    <details><summary>포함된 파일·버전</summary><ul className="preview-file-list">{manifest.entries.map(file =>
      <li key={file.artifactId}><span>{file.path}</span><span>v{file.version}</span><code title={file.sha256}>{file.sha256.slice(0, 12)}</code></li>)}</ul></details>
    <form className="preview-controls" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
      const opened = await request<ArtifactPreviewSession>(`/artifact-previews/${manifest.id}/open`, 'POST', { entrypoint });
      if (!mounted.current) { await request(`/artifact-previews/${manifest.id}/session`, 'DELETE'); return; }
      setExpired(false); setSession(opened);
    }); }}><Field label="열 페이지"><select value={entrypoint} disabled={action.pending} onChange={event => setEntrypoint(event.target.value)}>
      {manifest.entrypoints.map(path => <option key={path} value={path}>{path}</option>)}
    </select></Field><button type="submit" className="button primary" disabled={action.pending || !entrypoint}>
      <Play size={14} />{action.pending ? '여는 중' : '미리보기 열기'}</button>
      <button type="button" className="button subtle" disabled={action.pending} onClick={() => void action.execute(async () => {
        await request(`/artifact-previews/${manifest.id}/session`, 'DELETE'); setSession(null); setExpired(false);
      })}><X size={14} />미리보기 종료</button></form>
    <ErrorNotice message={action.error} />
    <p className="inline-note">별도 로컬 주소에서 실행합니다. 외부 자료·서버 연동은 제한되며 실제 개인정보는 입력하지 않습니다. 데모 저장은 이 주소의 브라우저 저장소에 남으며 백업에 포함되지 않습니다.</p>
    {session ? <>
      <div className="preview-controls"><Field label="화면 너비"><select value={width} onChange={event => setWidth(event.target.value)}>
        <option value="100%">화면에 맞춤</option><option value="1440px">PC 1440px</option><option value="768px">태블릿 768px</option><option value="390px">모바일 390px</option>
      </select></Field><span className="muted">{session.entrypoint} · 세션 만료 <DateLabel value={session.expiresAt} time /></span></div>
      {expired ? <p role="status">미리보기 세션이 만료됐습니다. 다시 열어 동일 소스를 확인할 수 있습니다.</p> :
        <div className="preview-frame-scroll"><iframe key={session.url} title={`${manifest.prefix || '/'} · ${session.entrypoint} 검수 미리보기`}
          src={session.url} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="strict-origin" style={{ width }} /></div>}
    </> : <p className="preview-not-open">미리보기를 열면 선택한 버전이 표시됩니다. 열기만으로 에이전트가 실행되지는 않습니다.</p>}
    <ArtifactPreviewFeedback key={manifest.id} manifest={manifest} workspace={workspace} refresh={refresh} conversationId={conversationId} />
  </section>;
}

function readFeedbackDraft(id: string): string {
  try { return typeof window === 'undefined' ? '' : window.sessionStorage.getItem(`preview-feedback:v1:${id}`) ?? ''; }
  catch { return ''; }
}
function readFeedbackSubmission(id: string): { payload: string; key: string } | null {
  try {
    const value = typeof window === 'undefined' ? null : JSON.parse(window.sessionStorage.getItem(`preview-submit:v1:${id}`) ?? 'null');
    return value && typeof value.payload === 'string' && typeof value.key === 'string' ? value : null;
  } catch { return null; }
}
function ArtifactPreviewFeedback({ manifest, workspace, refresh, conversationId }: {
  manifest: ArtifactPreviewManifest; workspace: Workspace; refresh: () => Promise<void>; conversationId?: string;
}) {
  const conversations = (workspace.conversations ?? []).filter(item => sameScope(manifest.scope, item.scope));
  const [chosen, setChosen] = useState(conversationId ?? conversations[0]?.id ?? '');
  const conversation = conversations.find(item => item.id === chosen);
  const [recipient, setRecipient] = useState('');
  const [mode, setMode] = useState<'discuss' | 'task'>('discuss');
  const [content, setContent] = useState(() => readFeedbackDraft(manifest.id));
  const [sent, setSent] = useState(false);
  const last = useRef(readFeedbackSubmission(manifest.id));
  const action = useAction();
  const members = workspace.agents.filter(agent => conversation?.participantAgentIds.includes(agent.id));
  const targetValid = !recipient || members.some(agent => agent.id === recipient);
  useEffect(() => {
    try { window.sessionStorage.setItem(`preview-feedback:v1:${manifest.id}`, content); } catch { /* Keep the in-memory draft. */ }
  }, [manifest.id, content]);
  if (!conversations.length) return <p className="inline-note">같은 공간의 대화형 작업실을 만들면 이 버전에 대한 의견을 남길 수 있습니다.</p>;
  return <form className="preview-feedback form-stack" onSubmit={event => { event.preventDefault(); if (!conversation || !targetValid) return;
    void action.execute(async () => {
      const body = { conversationId: conversation.id, content, mode: recipient ? mode : 'discuss', ...(recipient ? { recipientAgentId: recipient } : {}) };
      const payload = JSON.stringify(body);
      if (last.current?.payload !== payload) last.current = { payload, key: crypto.randomUUID() };
      try { window.sessionStorage.setItem(`preview-submit:v1:${manifest.id}`, JSON.stringify(last.current)); } catch { /* Mounted retries keep the same key. */ }
      await request(`/artifact-previews/${manifest.id}/feedback`, 'POST', { ...body, idempotencyKey: last.current.key });
      setContent(''); setSent(true); last.current = null;
      try { window.sessionStorage.removeItem(`preview-submit:v1:${manifest.id}`); window.sessionStorage.removeItem(`preview-feedback:v1:${manifest.id}`); } catch { /* The send succeeded. */ }
      await refresh();
    });
  }}><h3>이 버전에 대한 의견</h3>
    <div className="form-columns"><Field label="전달할 작업실"><select value={chosen} disabled={action.pending} onChange={event => { setChosen(event.target.value); setRecipient(''); setSent(false); }}>
      {!conversation ? <option value="">작업실 선택</option> : null}
      {conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></Field><Field label="의견을 받을 에이전트"><select value={recipient} disabled={action.pending} onChange={event => { setRecipient(event.target.value); setSent(false); }}>
      <option value="">대화에 기록만</option>{members.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
    </select></Field></div>
    {recipient ? <Field label="요청 방식"><select value={mode} disabled={action.pending} onChange={event => setMode(event.target.value as 'discuss' | 'task')}>
      <option value="discuss">상담·검토 답변</option><option value="task">수정 작업 요청</option>
    </select></Field> : null}
    <Field label="검수 의견" hint={`소스 ${manifest.sourceHash.slice(0, 12)}와 묶음 ID가 자동으로 첨부됩니다.`}>
      <textarea rows={4} maxLength={12_000} required value={content} disabled={action.pending}
        onChange={event => { setContent(event.target.value); setSent(false); }} /></Field>
    <p className="inline-note">{recipient ? '선택한 실제 에이전트에게 전달합니다. 응답·수정 실행은 기존 운영 한도를 사용합니다.' : '기록만 남기며 에이전트를 시작하지 않습니다.'}</p>
    <ErrorNotice message={action.error} />
    {sent ? <p role="status">작업실에 의견을 보존했습니다. <a href={conversationHref(chosen)}>대화 보기</a></p> : null}
    <button className="button primary" type="submit" disabled={action.pending || !content.trim() || !conversation || !targetValid}>
      <Send size={14} />{action.pending ? '전달 중' : recipient ? '의견 전달' : '의견 기록'}</button>
  </form>;
}
