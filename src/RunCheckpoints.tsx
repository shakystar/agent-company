import { Download, FileText } from 'lucide-react';
import type { Artifact, Run } from '../shared/types';
import { DateLabel, TextContent } from './ui';

export function RunCheckpoints({ run }: { run: Run }) {
  if (!run.checkpointResults?.length) return null;
  const download = (artifact: Artifact) => {
    const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mediaType || 'text/plain' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = artifact.name.replace(/[\\/]/g, '_');
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="conversation-artifacts" aria-label="대기 중 보존한 결과">
    <h3>대기 중 보존한 결과</h3><p className="inline-note">각 대기 시점의 답변과 파일입니다. 최종 결과나 과제 완료를 의미하지 않습니다.</p>
    {run.checkpointResults.map(checkpoint => <details key={checkpoint.id} open={run.status === 'waiting'}>
      <summary>{checkpoint.attempt}번째 실행 결과 · <DateLabel value={checkpoint.createdAt} time /></summary>
      <TextContent text={checkpoint.result} className="conversation-run-result" />
      {checkpoint.artifacts.map(artifact => <details key={artifact.id}>
        <summary><FileText size={14} />{artifact.name}</summary><TextContent text={artifact.content} className="conversation-artifact-content mono" />
        <button className="button" onClick={() => download(artifact)}><Download size={13} />다운로드</button>
      </details>)}
    </details>)}
  </section>;
}
