import { z } from 'zod';
import { workerImageSchema } from './runtime-releases.ts';

const fields = { image: workerImageSchema, bytes: z.number().int().positive().max(8 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) };
const imageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('worker'), file: z.literal('worker.tar'), ...fields }).strict(),
  z.object({ kind: z.literal('browser'), file: z.literal('browser.tar'), ...fields }).strict(),
]);
export const desktopWorkerImagesSchema = z.object({ version: z.literal(1),
  images: z.array(imageSchema).min(1).max(2) }).strict();
export type DesktopWorkerPackageImage = z.infer<typeof imageSchema>;

// Public Docker Hub only. Tags, credentials, alternate registries and endpoints
// cannot be supplied by setup input; the installer payload pins this document.
export const desktopRegistryReferenceSchema = z.string().max(300)
  .regex(/^docker\.io\/[a-z0-9][a-z0-9_-]{1,38}\/[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/);
export const desktopRegistryImageSchema = z.object({
  kind: z.enum(['worker', 'browser']), image: workerImageSchema,
  reference: desktopRegistryReferenceSchema,
  imageIdentity: z.enum(['config', 'manifest', 'index']),
  downloadBytes: z.number().int().positive().max(8 * 1024 ** 3),
  layerBytes: z.number().int().positive().max(8 * 1024 ** 3),
}).strict().superRefine((image, ctx) => {
  if (image.imageIdentity !== 'config' && image.reference.split('@')[1] !== image.image)
    ctx.addIssue({ code: 'custom', message: 'Registry digest must preserve the pinned image identity' });
});
export const desktopRegistryImagesSchema = z.object({ version: z.literal(2),
  images: z.array(desktopRegistryImageSchema).min(1).max(2) }).strict();
export const desktopImageDistributionSchema = z.discriminatedUnion('version', [desktopWorkerImagesSchema, desktopRegistryImagesSchema]);
export type DesktopRegistryImage = z.infer<typeof desktopRegistryImageSchema>;
export type DesktopDistributedImage = DesktopWorkerPackageImage | DesktopRegistryImage;
