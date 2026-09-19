import { useEffect, useState } from 'react';
import { Archive, CheckCircle2, HardDrive, PauseCircle, Pin, Play, RefreshCw, RotateCcw } from 'lucide-react';
import type { RestoreRecord, StorageStatus } from '../shared/storage';
import { request, useAction } from './api';
import { DateLabel, Empty, ErrorNotice, Modal, SectionTitle } from './ui';
import { formatBytes } from './FileTransfer';

export function StorageView({ refresh }: { refresh: () => Promise<void> }) {
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<RestoreRecord | null>(null);
  const action = useAction();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<StorageStatus>('/storage', 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) { setStorage(next); setError(''); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '저장공간 정보를 확인하지 못했습니다.');
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 15_000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const changed = async () => { setRevision(value => value + 1); await refresh(); };
  const disabled = action.pending || !storage?.enabled || storage.busy;
  return <section className="panel storage-panel" aria-label="저장공간과 백업"><SectionTitle title="저장공간·백업" detail="공동 예산 안에서 파일과 복원 시점을 보존합니다."
    action={<button className="button" onClick={() => setRevision(value => value + 1)} disabled={action.pending}><RefreshCw size={14} />새로고침</button>} />
    <ErrorNotice message={error || action.error} />
    {!storage && !error ? <p role="status">저장공간을 확인하고 있습니다.</p> : null}
    {storage ? <>
      <div className="storage-meters">{([
        ['운영 데이터', storage.usage.dataBytes, storage.limits.dataBytes],
        ['보관 백업', storage.usage.backupBytes, storage.limits.backupBytes],
        ['임시 작업공간', storage.usage.tempBytes, storage.limits.tempBytes],
      ] as const).map(([label, used, limit]) => <div className="storage-meter" key={label}><span><HardDrive size={15} />{label}</span>
        <strong>{formatBytes(used)} <small>/ {formatBytes(limit)}</small></strong>
        <meter aria-label={`${label} 사용량`} min={0} max={Math.max(limit, 1)} value={Math.min(used, Math.max(limit, 1))} />
      </div>)}</div>
      <dl className="config-list"><div><dt>디스크 여유</dt><dd>{formatBytes(storage.usage.freeBytes)} · 최소 {formatBytes(storage.limits.minFreeBytes)} 유지</dd></div>
        <div><dt>백업 위치</dt><dd className="mono">{storage.backupDir || '미설정'}</dd></div>
        <div><dt>마지막 백업</dt><dd>{storage.lastBackupAt ? <DateLabel value={storage.lastBackupAt} time /> : '아직 없음'}</dd></div></dl>
      <p className="inline-note">디스크 사용량은 시작 전 검사와 5초 주기 감시로 관리합니다. OS가 강제하는 저장공간 할당량은 아닙니다.</p>
      {storage.reason ? <p className="storage-notice" role="status">{storage.reason}</p> : null}
      {!storage.enabled ? <p className="inline-note">저장·백업 기능이 비활성 상태입니다. 사용량은 확인 가능한 범위만 표시합니다.</p> : null}
      {storage.paused ? <div className="storage-notice"><PauseCircle size={16} /><span>복원된 작업은 일시정지 상태입니다. 재개하면 보존된 대기 작업의 실행이 허용됩니다.</span>
        <button className="button primary" disabled={disabled} onClick={() => void action.execute(async () => { await request('/storage/resume', 'POST', {}); await changed(); })}><Play size={14} />작업 재개 허용</button></div> : null}
      <SectionTitle title="검증된 백업" detail="하루 한 번 작업이 없는 시점에 백업합니다. 최근 검증본 3개와 보존 고정본을 유지합니다."
        action={<button className="button" disabled={disabled} onClick={() => void action.execute(async () => { await request('/storage/backups', 'POST', {}); await changed(); })}>
          <Archive size={14} />{storage.busy ? '처리 중' : '지금 백업'}</button>} />
      <p className="inline-note">지금 만든 백업도 최근 3개 순환 관리 대상입니다. 보존 고정본은 삭제하지 않습니다. 새 백업 검증 성공 후 초과분만 정리하며 기억·스킬·작업 파일은 자동 삭제하지 않습니다.</p>
      {storage.backups.length ? <div className="storage-backups">{storage.backups.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).map(backup => <article className="storage-backup" key={backup.id}>
        <CheckCircle2 size={18} /><div className="file-copy"><strong><DateLabel value={backup.createdAt} time /></strong><small>{formatBytes(backup.bytes)} · 생성 시 무결성 검증</small><small className="mono">{backup.id}</small></div>
        <button className={`button ${backup.pinned ? 'primary' : ''}`} aria-pressed={backup.pinned} disabled={disabled}
          onClick={() => void action.execute(async () => { await request(`/storage/backups/${backup.id}`, 'PATCH', { pinned: !backup.pinned }); await changed(); })}>
          <Pin size={14} />{backup.pinned ? '보존 고정 해제' : '보존 고정'}</button>
        <button className="button" disabled={disabled} onClick={() => void action.execute(async () => {
          const prepared = await request<RestoreRecord>('/storage/restores', 'POST', { backupId: backup.id }); setSelected(prepared); await changed();
        })}><RotateCcw size={14} />복원 준비</button>
      </article>)}</div> : <Empty icon={<Archive size={24} />} title="아직 검증된 백업이 없습니다" />}
      {storage.restores.length ? <div className="storage-restores"><h3>전환 대기 중인 복원본</h3>{storage.restores.map(restore => <div className="storage-backup" key={restore.id}>
        <div className="file-copy"><strong><DateLabel value={restore.createdAt} time /></strong><small className="mono">백업 {restore.backupId}</small></div>
        <button className="button" disabled={disabled} onClick={() => setSelected(restore)}>전환 검토</button></div>)}</div> : null}
    </> : null}
    {selected ? <Modal title="검증된 복원본으로 전환" onClose={() => setSelected(null)} busy={action.pending}>
      <div className="form-stack"><p>현재 데이터는 보존됩니다. 선택한 백업의 별도 복원본으로 전환하며, 과거 작업은 자동 실행하지 않습니다.</p>
        <p className="mono storage-id">백업 {selected.backupId}</p><ErrorNotice message={action.error} />
        <div className="modal-actions"><button className="button subtle" disabled={action.pending} onClick={() => setSelected(null)}>닫기</button>
          <button className="button primary" disabled={disabled} onClick={() => void action.execute(async () => {
            await request(`/storage/restores/${selected.id}/activate`, 'POST', {}); await changed(); setSelected(null);
          })}>전환·일시정지로 열기</button></div></div>
    </Modal> : null}
  </section>;
}
