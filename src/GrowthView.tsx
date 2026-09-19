import { ArrowRight, BookOpen, GitBranch, History, Plus, RefreshCw, Sparkles } from 'lucide-react';
import type { Agent, Skill, Workspace } from '../shared/types';
import type { GrowthReview, RepairJob, SkillRevision } from '../shared/growth';
import { DateLabel, Empty, SectionTitle, TextContent } from './ui';
import { UsageView } from './UsageView';
import { isLearningReviewRun, LearningReviewView } from './LearningReviewView';

const verdictLabels: Record<GrowthReview['verdict'], string> = { improved: '개선', equivalent: '동등', regressed: '회귀', inconclusive: '판정 유보' };
const decisionLabels: Record<GrowthReview['decision'], string> = { activated: '후보 적용', kept: '기존 상태 유지', rolled_back: '정상 버전 복귀' };
const purposeLabels: Record<GrowthReview['purpose'], string> = { candidate: '후보 비교', regression: '회귀 확인', repair: '수정안 비교' };
const repairLabels: Record<RepairJob['status'], string> = { queued: '수정 대기', running: '수정 중', held: '수정만 보류', resolved: '수정 처리 완료' };
const originLabels: Record<SkillRevision['origin'], string> = { legacy: '기존 기록', manual: '직접 등록', candidate: '작업에서 생성', repair: '자동 재수정', fork: '복제에서 계승' };

function EvidenceList({ title, values }: { title: string; values: string[] }) {
  return values.length ? <div className="growth-evidence-list"><h4>{title}</h4><ul>{values.map((value, index) => <li key={index}><TextContent text={value} /></li>)}</ul></div> : null;
}

export function SkillCatalog({ skills, revisions, busy, onAdd, onShowGrowth }: {
  skills: Skill[]; revisions: SkillRevision[]; busy: boolean; onAdd: () => void; onShowGrowth: () => void;
}) {
  const revisionsById = new Map(revisions.map(revision => [revision.id, revision]));
  const active = skills.filter(skill => skill.status === 'active');
  const inactive = skills.filter(skill => skill.status !== 'active');
  return <><SectionTitle title="현재 스킬" detail="현재 적용한 스킬과 미적용 후보를 구분합니다. 생성 개수 자체를 성장으로 판단하지 않습니다."
    action={<button className="button" disabled={busy} onClick={onAdd}><Plus size={15} />스킬 추가</button>} />
    <button className="text-link growth-history-link" onClick={onShowGrowth}><GitBranch size={14} />비교 판정·후보·수정 이력</button>
    {[{ title: '적용 중', items: active }, { title: '미적용 후보·보존 기록', items: inactive }].map(group => group.items.length ? <section className="skill-group" key={group.title} aria-label={group.title}>
      <h3>{group.title} <span className="count">{group.items.length}</span></h3><div className="skill-list">{group.items.map(skill => {
        const revision = skill.activeRevisionId ? revisionsById.get(skill.activeRevisionId) : undefined;
        return <details className="skill-card" key={skill.id}><summary><span className="skill-symbol"><Sparkles size={20} /></span>
          <div><h3>{skill.name}</h3><p>{skill.description}</p></div><span className={`tag ${skill.status === 'active' ? 'tag-green' : ''}`}>
            {skill.status === 'active' ? '적용 중' : skill.status === 'rejected' ? '미적용·보존' : '후보'}</span>
          <span className="mono muted">v{revision?.version ?? skill.version}</span></summary><div className="skill-body">
          <TextContent text={revision?.content ?? skill.content} className="mono" /><div className="evaluation"><BookOpen size={15} /><div>
            <strong>적용·평가 기록</strong><p>{skill.evaluation || '별도 비교 판정 기록을 확인할 수 없습니다.'}</p>
            <small>{revision ? originLabels[revision.origin] : '기존 집계 기록'} · <DateLabel value={skill.updatedAt} /></small>
          </div></div></div></details>;
      })}</div></section> : null)}
    {!skills.length ? <Empty icon={<Sparkles size={25} />} title="아직 등록된 스킬이 없습니다" detail="작업에서 생성된 후보와 평가 근거를 보존합니다."
      action={<button className="button" disabled={busy} onClick={onAdd}><Plus size={15} />첫 스킬 추가</button>} /> : null}
  </>;
}

export function GrowthView({ agent, workspace }: { agent: Agent; workspace: Workspace }) {
  const skills = workspace.skills.filter(skill => skill.agentId === agent.id);
  const revisions = (workspace.skillRevisions ?? []).filter(revision => revision.agentId === agent.id);
  const reviews = (workspace.growthReviews ?? []).filter(review => review.agentId === agent.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const repairs = (workspace.repairJobs ?? []).filter(job => job.agentId === agent.id).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const skillNames = new Map(skills.map(skill => [skill.id, skill.name]));
  const revisionById = new Map(revisions.map(revision => [revision.id, revision]));
  const activeIds = new Set(skills.filter(skill => skill.status === 'active').map(skill => skill.activeRevisionId).filter(Boolean));
  const runIds = new Set(workspace.runs.filter(run => run.agentId === agent.id).map(run => run.id));
  const attempts = (workspace.modelAttempts ?? []).filter(attempt => runIds.has(attempt.runId));
  const learningRuns = workspace.runs.filter(run => run.agentId === agent.id && isLearningReviewRun(run));
  const reviewedRuns = learningRuns.filter(run => run.learningReview).toSorted((a, b) => b.learningReview!.completedAt.localeCompare(a.learningReview!.completedAt));
  const unreviewedCount = learningRuns.length - reviewedRuns.length;
  const versionName = (id: string | null) => id === null ? '스킬 미적용 기준' : revisionById.has(id) ? `v${revisionById.get(id)!.version}` : '버전 기록 미확인';
  return <div className="growth-view"><SectionTitle title="성장 기록" detail="완료와 품질을 기준으로 판정합니다. 시간·토큰 기록은 아래에서 별도로 확인합니다." />
    <section className="growth-section" aria-label="작업 후 학습 검토"><SectionTitle title="작업 후 학습 검토" detail="각 작업의 최신 검토와 제안하지 않은 이유를 확인합니다. 스킬 후보 제안은 적용 완료와 구분합니다." />
      {unreviewedCount ? <p className="inline-note">미검토 {unreviewedCount}건 · 학습 검토 기록이 없는 작업입니다.</p> : null}
      {reviewedRuns.length ? <div className="growth-reviews">{reviewedRuns.map(run => <article key={run.id}>
        <TextContent text={run.prompt} /><LearningReviewView run={run} />
      </article>)}</div> : <Empty icon={<BookOpen size={24} />} title="학습 검토 기록이 없습니다" detail="검토 보류나 제안 없음 판정이 기록된 상태와 구분합니다." />}
    </section>
    <section className="growth-section" aria-label="현재 적용 버전"><SectionTitle title="현재 적용 버전" />
      {skills.some(skill => skill.status === 'active') ? <div className="growth-current">{skills.filter(skill => skill.status === 'active').map(skill => {
        const revision = skill.activeRevisionId ? revisionById.get(skill.activeRevisionId) : undefined;
        const review = reviews.find(item => (item.candidateRevisionId === skill.activeRevisionId && item.decision === 'activated')
          || (item.baselineRevisionId === skill.activeRevisionId && item.decision === 'rolled_back'));
        return <article className="growth-current-card" key={skill.id}><div className="growth-row"><Sparkles size={17} /><h3>{skill.name}</h3><span className="tag tag-green">v{revision?.version ?? skill.version} 적용</span></div>
          {review?.decision === 'rolled_back' ? <p className="inline-note">정상 버전 복귀 근거 · 아래 판정은 회귀한 후보에 대한 기록입니다.</p> : null}
          <p>{review?.reason || skill.evaluation || '현재 적용 기록입니다. 독립 비교 판정 근거는 아직 없습니다.'}</p>
          <small>{revision ? originLabels[revision.origin] : '기존 버전 기록'} · <DateLabel value={skill.updatedAt} /></small>
        </article>;
      })}</div> : <Empty icon={<Sparkles size={24} />} title="현재 적용한 스킬이 없습니다" />}
    </section>
    <section className="growth-section" aria-label="후보 자동 수정"><SectionTitle title="후보 자동 수정" detail="회귀한 후보는 보존하며 유효한 개선 내용을 유지해 다시 평가합니다. 무진전 반복 시 해당 수정만 보류합니다." />
      {repairs.length ? <div className="growth-repairs">{repairs.map(job => <article className="growth-repair" key={job.id}>
        <div className="growth-row"><RefreshCw size={17} /><h3>{skillNames.get(job.skillId) ?? revisionById.get(job.candidateRevisionId)?.name ?? '스킬 후보'}</h3>
          <span className={`tag ${job.status === 'held' ? 'tag-amber' : job.status === 'resolved' ? 'tag-green' : ''}`}>{repairLabels[job.status]}</span></div>
        <p>{job.reason}</p><div className="growth-repair-meta"><span>수정 시도 {job.attempts}회</span><span>무진전 기록 {job.noProgressCount}회</span><span>{versionName(job.candidateRevisionId)} 후보</span></div>
        {job.status === 'held' ? <p className="inline-note">이 후보의 자동 수정만 보류됩니다. 에이전트의 다른 작업을 중지하는 상태가 아닙니다.</p> : null}
        <EvidenceList title="보존할 개선 내용" values={job.preservedUsefulChanges} /><EvidenceList title="수정할 실패" values={job.failures} />
        <small><DateLabel value={job.updatedAt} time /></small>
      </article>)}</div> : <Empty icon={<RefreshCw size={24} />} title="진행 중이거나 보존된 수정 작업이 없습니다" />}
    </section>
    <section className="growth-section" aria-label="완료·품질 판정"><SectionTitle title="완료·품질 판정" detail="판정과 실제 적용 결과를 분리해 표시합니다. 근거가 부족한 비교는 판정 유보로 남습니다." />
      {reviews.length ? <div className="growth-reviews">{reviews.map(review => <article className="growth-review" key={review.id}>
        <div className="growth-row"><History size={17} /><h3>{skillNames.get(review.skillId) ?? revisionById.get(review.candidateRevisionId)?.name ?? '스킬 비교'}</h3>
          <span className={`tag ${review.verdict === 'regressed' ? 'tag-red' : review.verdict === 'improved' ? 'tag-green' : 'tag-amber'}`}>{verdictLabels[review.verdict]}</span>
          <span className="tag">{decisionLabels[review.decision]}</span></div>
        <div className="growth-comparison"><span>{versionName(review.baselineRevisionId)}</span><ArrowRight size={14} /><span>{versionName(review.candidateRevisionId)}</span><small>{purposeLabels[review.purpose]}</small></div>
        <TextContent text={review.reason} className="growth-reason" />
        <EvidenceList title="유효한 변경" values={review.usefulChanges} /><EvidenceList title="실패·회귀 근거" values={review.failures} />
        <details className="growth-comparison-evidence"><summary>비교 근거 · {review.comparison?.verified ? '검증된 비교 실행 기록' : '확인되지 않음'}</summary>
          {review.comparison ? <><dl className="config-list"><div><dt>기존 비교 실행</dt><dd>{review.comparison.baseline.completed ? '완료' : '미완료'}</dd></div>
            <div><dt>후보 비교 실행</dt><dd>{review.comparison.candidate.completed ? '완료' : '미완료'}</dd></div>
            <div><dt>모델</dt><dd className="mono">{review.comparison.fingerprint.model}</dd></div><div><dt>실행 이미지</dt><dd className="mono">{review.comparison.fingerprint.image}</dd></div>
            <div><dt>입력 지문</dt><dd className="mono">{review.comparison.fingerprint.inputHash}</dd></div>
            <div><dt>목표 지문</dt><dd className="mono">{review.comparison.fingerprint.promptHash}</dd></div></dl>
            <EvidenceList title="관측 근거" values={review.comparison.evidence} />
          </> : <p className="inline-note">독립 비교 실행 근거가 기록되지 않았습니다.</p>}
        </details><small><DateLabel value={review.createdAt} time /></small>
      </article>)}</div> : <Empty icon={<History size={24} />} title="완료·품질 비교 기록이 없습니다" detail="현재 스킬 적용 여부만으로 성능 개선을 확인한 것으로 표시하지 않습니다." />}
    </section>
    <section className="growth-section" aria-label="보존된 스킬 버전"><SectionTitle title="보존된 스킬 버전" detail="미적용 후보와 이전 본문을 지우지 않고 보존합니다." />
      {revisions.length ? <div className="growth-revisions">{revisions.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).map(revision => <details className="growth-revision" key={revision.id}>
        <summary><GitBranch size={16} /><strong>{revision.name}</strong><span className="mono">v{revision.version}</span>
          <span className={`tag ${activeIds.has(revision.id) ? 'tag-green' : ''}`}>{activeIds.has(revision.id) ? '현재 적용' : '보존본'}</span><small>{originLabels[revision.origin]}</small></summary>
        <div className="growth-revision-body"><p>{revision.description}</p><TextContent text={revision.content} className="mono" />
          <small>{revision.parentRevisionId ? `${versionName(revision.parentRevisionId)}에서 변경 · ` : ''}<DateLabel value={revision.createdAt} time /></small>
          {revision.inheritedFrom ? <p className="inline-note">복제 시 계승한 버전이며 이후 변경은 현재 에이전트에 별도로 기록됩니다.</p> : null}
        </div>
      </details>)}</div> : <Empty icon={<GitBranch size={24} />} title="보존된 스킬 버전이 없습니다" />}
    </section>
    <section className="growth-section growth-usage"><UsageView attempts={attempts} /></section>
  </div>;
}
