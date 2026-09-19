import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, PauseCircle, Play, RefreshCw } from 'lucide-react';
import type { DeploymentStatus } from '../shared/deployment';
import type { Workspace } from '../shared/types';
import { request, useAction } from './api';
import { DateLabel, ErrorNotice, SectionTitle } from './ui';

const labels: Record<DeploymentStatus['phase'], string> = { running: '작업 실행 허용', draining: '배포 준비 중', ready: '배포 준비 완료', blocked: '배포 준비 보류' };
export const deploymentHeld = (status?: DeploymentStatus | null) => !!status && status.phase !== 'running';

/** Deployment status has its own read path: blocked settings requests cannot erase it. */
export function useDeploymentStatus(initial?: DeploymentStatus) {
  const [status, setStatus] = useState<DeploymentStatus | null>(initial ?? null);
  const [error, setError] = useState('');
  const action = useAction();
  const sequence = useRef(0), changing = useRef(false), mounted = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (changing.current) return;
    const token = ++sequence.current;
    try {
      const next = await request<DeploymentStatus>('/deployment', 'GET', undefined, signal);
      if (mounted.current && token === sequence.current && !signal?.aborted) { setStatus(next); setError(''); }
    } catch (failure) {
      if (mounted.current && token === sequence.current && !signal?.aborted) setError(failure instanceof Error ? failure.message : '배포 상태를 확인하지 못했습니다.');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === 'visible') await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    void poll(); document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  const change = (operation: 'prepare' | 'resume', afterChange: () => Promise<void>) => action.execute(async () => {
    changing.current = true; sequence.current++;
    try {
      const next = await request<DeploymentStatus>(`/deployment/${operation}`, 'POST', {});
      if (mounted.current) { setStatus(next); setError(''); }
      await afterChange();
    } finally { changing.current = false; }
  });
  return { status, error: action.error || error, pending: action.pending, refresh, change };
}

export function DeploymentNotice({ status }: { status?: DeploymentStatus }) {
  if (!deploymentHeld(status)) return null;
  return <a className="deployment-notice" href="#settings" role="status"><PauseCircle size={17} /><span><strong>{labels[status!.phase]}</strong> · 새 작업 시작을 보류하고 진행 상태를 보존합니다.</span><span>배포 상태 확인</span></a>;
}

export function DeploymentPanel({ status, error = '', pending = false, workspace, onPrepare, onResume, onRefresh }: {
  status: DeploymentStatus | null; error?: string; pending?: boolean; workspace: Workspace;
  onPrepare: () => void; onResume: () => void; onRefresh: () => void;
}) {
  const holding = deploymentHeld(status);
  const icon: ReactNode = status?.phase === 'ready' ? <CheckCircle2 size={19} /> : status?.phase === 'blocked' ? <CircleAlert size={19} />
    : status?.phase === 'draining' ? <LoaderCircle size={19} className="spin" /> : <PauseCircle size={19} />;
  return <section className="panel deployment-panel" aria-label="작업을 보존하는 배포 준비" aria-busy={pending}>
    <SectionTitle title="배포 준비" detail="현재 턴을 마친 뒤 체크포인트와 대기 작업을 보존합니다."
      action={<button className="button subtle" disabled={pending} onClick={onRefresh}><RefreshCw size={14} />배포 상태 새로고침</button>} />
    <div className={`deployment-phase deployment-phase-${status?.phase ?? 'unknown'}`} role="status" aria-live="polite">{icon}<strong>{status ? labels[status.phase] : '배포 상태 확인 중'}</strong></div>
    {status ? <><dl className="deployment-counts"><div><dt>진행 중인 과제</dt><dd>{status.activeRunIds.length}<small>건</small></dd></div><div><dt>보존된 미완료 작업</dt><dd>{status.pendingRunCount}<small>건</small></dd></div></dl>
      {status.activeRunIds.length ? <details className="deployment-active-runs"><summary>진행 중인 실행 {status.activeRunIds.length}건 확인</summary><ul>{status.activeRunIds.map(id => { const run = workspace.runs.find(item => item.id === id); return <li key={id}>{workspace.agents.find(agent => agent.id === run?.agentId)?.name ?? '실행 기록'} · <span className="mono">{id.slice(0, 8)}</span></li>; })}</ul></details> : null}
      {status.reason ? <p className="deployment-reason" role={status.phase === 'blocked' ? 'alert' : 'status'}>{status.reason}</p> : null}
      {status.phase === 'blocked' ? <p className="inline-note">정리 상태를 자동으로 다시 확인합니다. 진행 중인 과제가 0건이어도 정리 확인이 남을 수 있으며, 배포 준비 완료가 표시되면 전환할 수 있습니다.</p> : null}
      {status.requestedAt ? <p className="deployment-timestamp">준비 요청 · <DateLabel value={status.requestedAt} time />{status.readyAt ? <> · 준비 완료 · <DateLabel value={status.readyAt} time /></> : null}</p> : null}
      <p className="inline-note">{holding ? '새 모델 호출과 후속 자동 실행을 보류합니다. 이 상태는 서버 재시작 후에도 유지되며 작업 재개를 선택하면 해제됩니다.' : '배포 준비를 시작하면 새 모델 호출과 후속 자동 실행을 보류합니다. 진행 중인 현재 턴은 마무리한 뒤 보존합니다.'}</p>
      {status.phase === 'ready' ? <p className="deployment-ready-note">이미지 전환과 서버 재기동을 진행할 수 있습니다. 실제 전환은 별도 정식 배포 절차에서 수행합니다.</p> : null}
      <p className="inline-note">기존 실행은 사용하던 이미지로 이어갑니다. 새 실행은 정식 전환으로 활성화한 이미지를 사용합니다.</p>
      {holding ? <p className="inline-note">배포를 취소하거나 전환을 마친 뒤 작업 재개를 선택합니다. 개별 작업의 사용자 중지와 기존 예산 한도는 유지됩니다.</p> : null}
    </> : null}
    <ErrorNotice message={error} />{error && status ? <p className="inline-note">마지막으로 확인한 상태를 유지합니다. 다시 조회해 현재 상태를 확인할 수 있습니다.</p> : null}
    <div className="deployment-actions">{holding ? <button className="button primary" disabled={pending} onClick={onResume}><Play size={15} />{pending ? '처리 중' : '작업 재개'}</button>
      : <button className="button primary" disabled={pending || !status} onClick={onPrepare}><PauseCircle size={15} />{pending ? '준비 요청 중' : '배포 준비'}</button>}</div>
  </section>;
}
