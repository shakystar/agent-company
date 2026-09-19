import { z } from 'zod';
import type { ArtifactPreviewManifest } from './artifact-preview.ts';

export const artifactPreviewFeedbackSchema = z.object({
  conversationId: z.uuid(), content: z.string().trim().min(1).max(12_000),
  mode: z.enum(['discuss', 'task']).default('discuss'),
  recipientAgentId: z.uuid().optional(), idempotencyKey: z.uuid(),
}).strict().refine(value => value.mode !== 'task' || !!value.recipientAgentId, '수정 작업을 요청할 에이전트를 지정해야 합니다.');

/** Server-owned provenance; the editable feedback cannot replace the selected version. */
export function artifactPreviewFeedbackContent(manifest: ArtifactPreviewManifest, content: string): string {
  return `산출물 검수 의견\n묶음: ${manifest.id}\n공유 공간: ${manifest.scope.type}/${manifest.scope.id}\n경로: ${manifest.prefix}\n소스 SHA-256: ${manifest.sourceHash}\n고정 시각: ${manifest.createdAt}\n이 의견은 위 버전에 대한 검수이며, 최신 버전의 검증이나 새 권한 부여를 뜻하지 않습니다.\n\n${content}`;
}
