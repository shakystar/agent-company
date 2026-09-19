import { z } from 'zod';
import { collaborationScopeSchema } from './collaboration.ts';

export const ARTIFACT_PREVIEW_MAX_FILES = 200;
export const ARTIFACT_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
export const ARTIFACT_PREVIEW_TTL_MS = 60 * 60 * 1000;

/** Also safe when extracted by Windows archive tools. No URL decoding occurs here. */
export function safeArtifactPreviewPath(path: string): boolean {
  return path.length > 0 && path.length <= 200 && !/[\\:%"<>|?*\u0000-\u001f\u007f]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
const path = z.string().refine(safeArtifactPreviewPath, '안전한 상대 파일 경로가 필요합니다.');
const prefix = z.string().refine(value => value === '' || safeArtifactPreviewPath(value), '안전한 공유 경로가 필요합니다.');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({ artifactId: z.uuid(), version: z.number().int().positive() }).strict();
export const artifactPreviewInputSchema = z.object({
  scope: collaborationScopeSchema,
  prefix,
  versions: z.array(reference).min(1).max(ARTIFACT_PREVIEW_MAX_FILES).optional(),
}).strict();
export const artifactPreviewManifestSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), scope: collaborationScopeSchema, prefix,
  createdAt: z.iso.datetime(), sourceHash: hash,
  totalBytes: z.number().int().nonnegative().max(ARTIFACT_PREVIEW_MAX_BYTES),
  entries: z.array(reference.extend({ path, mediaType: z.string().min(1).max(100),
    bytes: z.number().int().nonnegative().max(ARTIFACT_PREVIEW_MAX_BYTES), sha256: hash,
  }).strict()).min(1).max(ARTIFACT_PREVIEW_MAX_FILES),
  entrypoints: z.array(path).min(1).max(ARTIFACT_PREVIEW_MAX_FILES),
}).strict();
export type ArtifactPreviewInput = z.infer<typeof artifactPreviewInputSchema>;
export type ArtifactPreviewManifest = z.infer<typeof artifactPreviewManifestSchema>;
export interface ArtifactPreviewSession {
  manifestId: string;
  origin: string;
  url: string;
  entrypoint: string;
  expiresAt: string;
}
