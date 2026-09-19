import { useState } from 'react';
import { ArrowUpRight, Camera, Download } from 'lucide-react';
import type { BrowserCapture } from '../shared/browser';
import type { Workspace } from '../shared/types';
import { DateLabel } from './ui';

const recentCaptureLimit = 12;

export function conversationBrowserCaptures(workspace: Workspace, conversationId: string): BrowserCapture[] {
  const linkedRunIds = new Set((workspace.conversationMessages ?? [])
    .filter(message => message.conversationId === conversationId)
    .flatMap(message => [message.sourceRunId, ...message.deliveries.map(delivery => delivery.runId)])
    .filter((id): id is string => typeof id === 'string'));
  const runs = new Map(workspace.runs
    .filter(run => run.conversationId === conversationId || !run.conversationId && linkedRunIds.has(run.id))
    .map(run => [run.id, run]));
  return (workspace.browserCaptures ?? [])
    .filter(capture => runs.get(capture.runId)?.agentId === capture.agentId
      && (capture.conversationId === null || capture.conversationId === conversationId))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export const browserCaptureImageHref = (id: string) => `/api/browser/captures/${encodeURIComponent(id)}/image`;
export const browserCaptureDownloadHref = (id: string) => `/api/browser/captures/${encodeURIComponent(id)}/download`;

export function BrowserEvidence({ workspace, conversationId }: { workspace: Workspace; conversationId: string }) {
  const captures = conversationBrowserCaptures(workspace, conversationId);
  const agents = new Map(workspace.agents.map(agent => [agent.id, agent.name]));
  return <details className="browser-evidence" aria-label="대화의 브라우저 캡처">
    <summary><Camera size={15} aria-hidden="true" /><span>브라우저 캡처</span><span className="tag">{captures.length}개</span></summary>
    <div className="browser-evidence-body">
      <p className="inline-note">실제 작업 실행에서 저장한 화면입니다. 캡처 자체는 검사 통과나 결과물 완성을 뜻하지 않습니다.</p>
      {captures.length ? <>
        <ol className="browser-evidence-grid" aria-label="최근 캡처 이미지">{captures.slice(0, recentCaptureLimit).map(capture =>
          <BrowserCaptureCard key={capture.id} capture={capture} agentName={agents.get(capture.agentId) ?? '이전 에이전트'} />)}</ol>
        {captures.length > recentCaptureLimit ? <p className="inline-note">최근 {recentCaptureLimit}개를 표시합니다. 저장된 캡처는 {captures.length}개입니다.</p> : null}
      </> : <p className="browser-evidence-empty">이 대화의 실행에 연결된 캡처가 없습니다.</p>}
    </div>
  </details>;
}

function BrowserCaptureCard({ capture, agentName }: { capture: BrowserCapture; agentName: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  return <li className="browser-evidence-card"><figure>
    {imageFailed ? <div className="browser-evidence-image-error"><p>캡처 이미지를 불러오지 못했습니다.</p>
      <button type="button" className="text-link" onClick={() => setImageFailed(false)}>다시 불러오기</button></div> :
      <a className="browser-evidence-thumbnail" href={browserCaptureImageHref(capture.id)} target="_blank" rel="noopener noreferrer"
        aria-label={`${agentName}의 캡처 원본 보기`}>
        <img src={browserCaptureImageHref(capture.id)} alt={`${agentName}의 브라우저 캡처 · ${capture.width} × ${capture.height}`}
          width={capture.width} height={capture.height} loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
      </a>}
    <figcaption><div className="browser-evidence-meta"><strong>{agentName}</strong><DateLabel value={capture.createdAt} time /></div>
      <p className="browser-evidence-source" title={capture.url}>{capture.url}</p>
      <p className="browser-evidence-size">{capture.width} × {capture.height} · {Math.ceil(capture.bytes / 1024).toLocaleString()} KiB · {capture.mediaType === 'image/png' ? 'PNG' : 'JPEG'}</p>
      <div className="browser-evidence-provenance mono"><span title={capture.runId}>Run {capture.runId.slice(0, 8)}</span>
        <span title={capture.sourceHash}>소스 {capture.sourceHash.slice(0, 12)}</span><span title={capture.sha256}>이미지 {capture.sha256.slice(0, 12)}</span></div>
      <div className="browser-evidence-actions"><a href={browserCaptureImageHref(capture.id)} target="_blank" rel="noopener noreferrer">원본 보기<ArrowUpRight size={12} aria-hidden="true" /></a>
        <a href={browserCaptureDownloadHref(capture.id)} download><Download size={12} aria-hidden="true" />다운로드</a></div>
    </figcaption>
  </figure></li>;
}
