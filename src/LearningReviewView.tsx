import { BookOpen } from 'lucide-react';
import type { Run } from '../shared/types';
import { DateLabel, TextContent } from './ui';

export function isLearningReviewRun(run: Run): boolean {
  return (!run.kind || run.kind === 'task') && !run.consultationOfRunId && !run.objectiveEvaluationId
    && run.interactionMode !== 'discuss' && run.interactionMode !== 'auto';
}

export function LearningReviewView({ run }: { run: Run }) {
  const review = run.learningReview;
  const pending = ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status);
  return <div className="growth-review" aria-label="작업 학습 검토">
    <div className="growth-row"><BookOpen size={17} /><h3>학습 검토</h3>
      <span className={`tag ${review?.status === 'deferred' ? 'tag-amber' : ''}`}>
        {!review ? '미검토' : review.status === 'deferred' ? '검토 보류' : '검토 완료'}</span>
      {pending ? <span className="tag">최종 반영 대기</span> : null}
    </div>
    {review ? <>
      <TextContent text={review.reason} />
      <p>기억 제안 {review.memoryCount}개 · 스킬 후보 제안 {review.skillCount}개</p>
      <p className="inline-note">제안 수이며, 저장된 기억과 적용 중 스킬 수는 별도로 확인합니다.</p>
      {review.evidence.length ? <details className="growth-comparison-evidence"><summary>학습 검토 근거</summary>
        <ul>{review.evidence.map((item, index) => <li key={`${item.sourceId}-${index}`}>
          <TextContent text={item.quote} /><small className="mono">{item.sourceId}</small>
        </li>)}</ul>
      </details> : null}
      <small><DateLabel value={review.completedAt} time /></small>
    </> : <p className="inline-note">학습 검토 기록이 없습니다. 제안할 내용이 없다고 판정된 상태와 구분합니다.</p>}
  </div>;
}
