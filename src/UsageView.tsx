import { Clock3, Gauge } from 'lucide-react';
import type { ModelAttempt, ModelUsage } from '../shared/telemetry';
import { DateLabel, Empty, SectionTitle, TextContent } from './ui';

const phaseLabels: Record<ModelAttempt['phase'], string> = { task: '작업', evaluate: '평가', trial: '비교 실행', repair: '재수정' };
const statusLabels: Record<ModelAttempt['status'], string> = { started: '실행 중', succeeded: '호출 완료', failed: '호출 실패', cancelled: '취소' };
const usageLabels: Record<ModelUsage['status'], string> = { unknown: '미확인', partial: '부분 보고', reported: '보고됨' };
export const attemptLabel = (attempt: Pick<ModelAttempt, 'phase' | 'kind'>) => attempt.phase === 'trial'
  ? attempt.kind === 'baseline-trial' ? '기준 비교' : attempt.kind === 'candidate-trial' ? '후보 비교' : phaseLabels.trial
  : phaseLabels[attempt.phase];
export const observedNumber = (value: number | null | undefined) => value == null ? '미확인' : value.toLocaleString();
export function observedDuration(value: number | null | undefined): string {
  if (value == null) return '미확인';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}초`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

export function UsageView({ attempts, legacy }: { attempts: ModelAttempt[]; legacy?: { inputTokens: number; outputTokens: number } }) {
  const ordered = attempts.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  return <section className="usage-view" aria-label="모델 호출 관측"><SectionTitle title="모델 호출 관측"
    detail="시간·토큰은 관측 기록이며 성장 판정에 사용하지 않습니다. 미확인 값은 0으로 표시하거나 합산하지 않습니다." />
    {ordered.length ? <div className="usage-attempts">{ordered.map(attempt => <details className="usage-attempt" key={attempt.id}>
      <summary><span className="usage-phase"><Gauge size={15} />{attemptLabel(attempt)}</span>
        <span className={`tag ${attempt.status === 'failed' ? 'tag-red' : attempt.status === 'started' ? 'tag-amber' : ''}`}>{statusLabels[attempt.status]}</span>
        <span className={`tag ${attempt.usage.status === 'reported' ? '' : 'tag-amber'}`}>{usageLabels[attempt.usage.status]}</span>
        <span className="usage-token-summary">입력 {observedNumber(attempt.usage.inputTokens)} · 출력 {observedNumber(attempt.usage.outputTokens)}</span>
        <span className="usage-time"><Clock3 size={13} />{observedDuration(attempt.durationMs)}</span>
        <DateLabel value={attempt.startedAt} time />
      </summary>
      <div className="usage-attempt-body"><dl className="usage-counts">
        <div><dt>입력 토큰</dt><dd>{observedNumber(attempt.usage.inputTokens)}</dd></div>
        <div><dt>출력 토큰</dt><dd>{observedNumber(attempt.usage.outputTokens)}</dd></div>
        <div><dt>캐시 입력 토큰</dt><dd>{observedNumber(attempt.usage.cachedInputTokens)}</dd></div>
        <div><dt>추론 출력 토큰</dt><dd>{observedNumber(attempt.usage.reasoningOutputTokens)}</dd></div>
      </dl><p className="inline-note">캐시 입력·추론 출력은 별도 관측 항목입니다. 입력·출력에 더하여 총량으로 계산하지 않습니다.</p>
        <dl className="config-list"><div><dt>모델</dt><dd className="mono">{attempt.model}</dd></div>
          <div><dt>호출 분류</dt><dd className="mono">{attempt.kind}</dd></div></dl>
        {attempt.reason ? <TextContent text={attempt.reason} className="usage-reason" /> : null}
        {attempt.error ? <div className="usage-failure"><strong>실패 기록</strong><TextContent text={attempt.error} /></div> : null}
        {attempt.observations.length ? <details className="usage-commands"><summary>관측된 명령 {attempt.observations.length}개</summary>
          {attempt.observations.map(observation => <article key={observation.id}><p><span className="tag">{observation.status === 'completed' ? '명령 종료' : observation.status === 'failed' ? '명령 실패' : '상태 미확인'}</span> 종료 코드 {observedNumber(observation.exitCode)}</p>
            <TextContent text={observation.command} className="mono" />{observation.outputExcerpt ? <TextContent text={observation.outputExcerpt} className="mono usage-command-output" /> : null}</article>)}
        </details> : null}
        {attempt.observationsTruncated ? <p className="inline-note">명령 관측 기록은 일부만 보존되어 있습니다.</p> : null}
      </div>
    </details>)}</div> : <Empty icon={<Gauge size={24} />} title="호출별 관측 기록이 없습니다" detail="기록이 없다는 것은 시간이나 토큰을 사용하지 않았다는 뜻이 아닙니다." />}
    {!ordered.length && legacy && (legacy.inputTokens > 0 || legacy.outputTokens > 0) ? <p className="inline-note">
      이전 집계값 · 입력 {legacy.inputTokens > 0 ? legacy.inputTokens.toLocaleString() : '미확인'} · 출력 {legacy.outputTokens > 0 ? legacy.outputTokens.toLocaleString() : '미확인'} 토큰입니다. 단계별·실패 호출별 완전성을 확인할 수 없습니다.
    </p> : null}
  </section>;
}
