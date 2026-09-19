import { useEffect, useState } from 'react';
import { Download, FileText, FileUp, Folder, RefreshCw } from 'lucide-react';
import type { Agent } from '../shared/types';
import { request, useAction } from './api';
import { Empty, ErrorNotice, Modal, SectionTitle, TextContent } from './ui';
import { FileImport } from './FileTransfer';

interface Listing { path: string; entries: Array<{ name: string; path: string; type: string; size: number }>; truncated: boolean }

export function WorkspaceFiles({ agent, busy = agent.status === 'running', onSaved }: { agent: Agent; busy?: boolean; onSaved?: () => Promise<void> }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<{ path: string; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const action = useAction();
  useEffect(() => {
    const controller = new AbortController();
    setListing(null); setError('');
    void request<Listing>(`/agents/${agent.id}/files?path=${encodeURIComponent(path)}`, 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setListing(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '파일 목록 조회 실패'); });
    return () => controller.abort();
  }, [agent.id, agent.workspaceRunId, path, refresh]);
  return <section className="panel personal-files">
    <SectionTitle title="개인 작업 파일" detail="마지막 성공 작업과 반입한 파일입니다. 다음 작업·복제·복원은 이 버전을 별도 작업공간으로 계승합니다."
      action={<div className="file-actions"><button className="button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />새로고침</button>
        <button className="button" disabled={busy} onClick={() => setImporting(true)}><FileUp size={14} />파일 반입</button></div>} />
    {busy ? <p className="inline-note">진행 중이거나 대기 중인 작업이 끝나면 파일을 반입할 수 있습니다.</p> : null}
    <p className="mono">/workspace/{path}</p>
    {path ? <button className="button subtle" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>상위 폴더</button> : null}
    <ErrorNotice message={error || action.error} />
    {!listing && !error ? <p role="status">파일 목록을 확인하고 있습니다.</p> : null}
    {listing?.entries.length ? <div className="connection-list">{listing.entries.map(entry => <div className="connection-row" key={entry.path}>
      {entry.type === 'directory' ? <Folder size={17} /> : <FileText size={17} />}
      <button className="text-link" disabled={action.pending || !['file', 'directory'].includes(entry.type)} onClick={() => {
        if (entry.type === 'directory') setPath(entry.path);
        else void action.execute(async () => setSelected(await request(`/agents/${agent.id}/files?read=true&path=${encodeURIComponent(entry.path)}`)));
      }}>{entry.name}</button><small>{entry.type === 'directory' ? '폴더' : `${entry.size.toLocaleString()} bytes`}</small>
      {entry.type === 'file' ? <a className="button" href={`/api/agents/${agent.id}/files/download?path=${encodeURIComponent(entry.path)}`} download aria-label={`${entry.name} 다운로드`}><Download size={14} />다운로드</a> : null}
    </div>)}</div> : listing ? <Empty icon={<Folder size={24} />} title="보존된 작업 파일이 없습니다" /> : null}
    {listing?.truncated ? <p className="inline-note">앞의 1,000개 항목을 표시합니다.</p> : null}
    <p className="inline-note">인증·세션·주입된 지침은 이 목록과 파일 계승에서 제외합니다. 텍스트는 256KiB까지 열람합니다.</p>
    {selected ? <Modal title={selected.path} onClose={() => setSelected(null)} wide><TextContent className="mono" text={selected.text} /></Modal> : null}
    {importing ? <FileImport scope={{ type: 'agent', id: agent.id }} prefix={path}
      onClose={() => { setImporting(false); setRefresh(value => value + 1); void onSaved?.(); }}
      onSaved={async () => { await onSaved?.(); setRefresh(value => value + 1); setImporting(false); }} /> : null}
  </section>;
}
