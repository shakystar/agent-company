import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, RefreshCw } from 'lucide-react';
import { MAX_IMPORTED_FILE_BYTES, validFilePath, type FileImportResult, type FileList, type FileScope } from '../shared/storage';
import { request, useAction } from './api';
import { DateLabel, Empty, ErrorNotice, Field, Modal, SectionTitle } from './ui';

export const formatBytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB`
  : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(2)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} bytes`;

async function fileBase64(file: File): Promise<string> {
  if (file.size > MAX_IMPORTED_FILE_BYTES) throw new Error(`${file.name}: 파일 하나의 한도는 16MiB입니다.`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name}: 파일을 읽지 못했습니다.`));
    reader.onabort = () => reject(new Error('파일 읽기가 중단되었습니다.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') reject(new Error('파일 전송 형식이 올바르지 않습니다.'));
      else resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Keep the modal/input on failure. Successfully imported files are not sent again on retry. */
export function FileImport({ scope, prefix = '', onClose, onSaved }: {
  scope: FileScope; prefix?: string; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [directory, setDirectory] = useState(prefix);
  const [completed, setCompleted] = useState(0);
  const [message, setMessage] = useState('');
  const completedFiles = useRef(new Set<File>());
  const stopRequested = useRef(false);
  const folders = useRef<HTMLInputElement>(null);
  const action = useAction();
  const remaining = files.filter(file => !completedFiles.current.has(file));
  const selectFiles = (selected: globalThis.FileList | null) => {
    setFiles(Array.from(selected ?? [])); completedFiles.current.clear(); setCompleted(0); setMessage('');
  };
  useEffect(() => { folders.current?.setAttribute('webkitdirectory', ''); }, []);
  return <Modal title="파일 복사본 반입" onClose={onClose} busy={action.pending} wide>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.execute(async () => {
      stopRequested.current = false;
      const prefixPath = directory.trim();
      const pending = remaining.map(file => ({ file, path: [prefixPath, file.webkitRelativePath || file.name].filter(Boolean).join('/') }));
      if (!pending.length) throw new Error('반입할 파일을 선택해야 합니다.');
      // Validate the whole selection before making the first write; collisions are checked again by the server.
      const names = new Set<string>();
      for (const { file, path } of pending) {
        if (!validFilePath(path)) throw new Error(`${path}: 반입 경로가 올바르지 않습니다.`);
        if (file.size > MAX_IMPORTED_FILE_BYTES) throw new Error(`${path}: 파일 하나의 한도는 16MiB입니다.`);
        const key = path.normalize('NFC').toLowerCase();
        if (names.has(key)) throw new Error(`${path}: 선택한 파일의 경로가 중복됩니다.`);
        names.add(key);
      }
      for (const { file, path } of pending) {
        if (stopRequested.current) { setMessage('전송을 중단했습니다. 완료된 파일은 보존됩니다.'); return; }
        setMessage(`${path} 반입 중`);
        await request<FileImportResult>('/files/import', 'POST', { scope, path,
          mediaType: file.type && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.type) ? file.type : 'application/octet-stream', base64: await fileBase64(file) });
        completedFiles.current.add(file); setCompleted(completedFiles.current.size);
      }
      if (stopRequested.current) { setMessage('전송을 중단했습니다. 완료된 파일은 보존됩니다.'); return; }
      setMessage('선택한 파일의 반입을 완료했습니다.');
      await onSaved();
    }); }}>
      <p className="inline-note">PC 원본은 수정하지 않습니다. 같은 경로의 기존 파일은 덮어쓰지 않습니다. 폴더는 파일별로 전송하며 빈 폴더는 반입하지 않습니다.</p>
      <Field label="반입할 하위 폴더" hint="비워 두면 선택한 공간의 최상위에 반입합니다.">
        <input maxLength={800} value={directory} onChange={event => setDirectory(event.target.value)} disabled={action.pending || completed > 0} placeholder="inputs" />
      </Field>
      <div className="file-selection"><Field label="파일 선택"><input type="file" multiple disabled={action.pending || completed > 0} onChange={event => selectFiles(event.target.files)} /></Field>
        <Field label="폴더 선택"><input ref={folders} type="file" multiple disabled={action.pending || completed > 0} onChange={event => selectFiles(event.target.files)} /></Field></div>
      {files.length ? <div className="file-selection-summary"><p>{files.length}개 · {formatBytes(files.reduce((sum, file) => sum + file.size, 0))} · 완료 {completed}개</p>
        <ul>{files.slice(0, 30).map((file, index) => <li key={`${file.webkitRelativePath || file.name}:${index}`}>
          <span>{file.webkitRelativePath || file.name}</span><small>{completedFiles.current.has(file) ? '완료' : formatBytes(file.size)}</small></li>)}</ul>
        {files.length > 30 ? <p>나머지 {files.length - 30}개 파일이 선택되어 있습니다.</p> : null}</div> : null}
      <p className="inline-note">파일 하나의 반입 한도는 16MiB입니다. 중단 시 완료된 파일은 유지되며 남은 파일만 다시 전송합니다.</p>
      <p role="status" aria-live="polite">{message}</p><ErrorNotice message={action.error} />
      <div className="modal-actions">{action.pending ? <button className="button subtle" type="button" onClick={() => {
        stopRequested.current = true; setMessage('현재 파일 처리 후 전송을 중단합니다.');
      }}>전송 중단</button> : <button className="button subtle" type="button" onClick={onClose}>{completed ? '닫기' : '취소'}</button>}
        <button type="submit" className="button primary" disabled={action.pending || !remaining.length}><FileUp size={15} />{action.pending ? '반입 중' : completed ? '남은 파일 반입' : '복사본 반입'}</button></div>
    </form>
  </Modal>;
}

export function SharedFiles({ scope }: { scope: FileScope }) {
  const [result, setResult] = useState<FileList | null>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setError(''); setResult(null);
    void request<FileList>(`/files?scopeType=${scope.type}&scopeId=${encodeURIComponent(scope.id)}`, 'GET', undefined, abort.signal)
      .then(value => { if (!abort.signal.aborted) setResult(value); })
      .catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '파일 조회에 실패했습니다.'); });
    return () => abort.abort();
  }, [scope.type, scope.id, revision]);
  return <section className="shared-files" aria-label="공유 파일"><SectionTitle title="공유 파일" detail="선택한 공간의 구성원만 접근하는 파일 복사본입니다."
    action={<div className="file-actions"><button className="button" onClick={() => setRevision(value => value + 1)} aria-label="공유 파일 새로고침"><RefreshCw size={14} /></button>
      <button className="button" onClick={() => setImporting(true)}><FileUp size={14} />파일 반입</button></div>} />
    <ErrorNotice message={error} />{!result && !error ? <p role="status">파일 목록을 확인하고 있습니다.</p> : null}
    {result?.files.length ? <div className="connection-list">{result.files.map(file => <div className="connection-row" key={file.id}>
      <FolderOpen size={17} /><div className="file-copy"><strong>{file.path}</strong><small>{formatBytes(file.bytes)} · <DateLabel value={file.createdAt} /></small></div>
      <a className="button" href={`/api/files/${file.id}/download`} download aria-label={`${file.path} 다운로드`}><Download size={14} />다운로드</a>
    </div>)}</div> : result ? <Empty icon={<FolderOpen size={24} />} title="반입한 공유 파일이 없습니다" /> : null}
    {importing ? <FileImport scope={scope} onClose={() => { setImporting(false); setRevision(value => value + 1); }}
      onSaved={async () => { setRevision(value => value + 1); setImporting(false); }} /> : null}
  </section>;
}
