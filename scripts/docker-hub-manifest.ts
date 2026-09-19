import { createHash } from 'node:crypto';
import { z } from 'zod';
import { desktopRegistryReferenceSchema } from '../shared/desktop-worker-images.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const descriptor = z.object({ digest, size: z.number().int().positive().max(8 * 1024 ** 3), mediaType: z.string(),
  urls: z.never().optional() }).passthrough();
const media = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const indices = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const layerTypes = new Set(['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar', 'application/vnd.docker.image.rootfs.diff.tar.gzip']);
const invalid = () => new Error('DOCKER_HUB_MANIFEST_INVALID');

/** Anonymous, repository-scoped metadata verification. No account credentials are read. */
export async function readDockerHubManifest(repository: string, reference: string, fetcher: typeof fetch = fetch) {
  desktopRegistryReferenceSchema.parse(`docker.io/${repository}@sha256:${'a'.repeat(64)}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(reference) && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(reference)) throw invalid();
  const signal = AbortSignal.timeout(60_000);
  async function bytes(url: string, headers: Record<string, string> = {}) {
    const response = await fetcher(url, { headers, signal, redirect: 'error' });
    if (!response.ok || !response.body) throw invalid();
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > 1024 * 1024) throw invalid(); chunks.push(Buffer.from(next.value)); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  const tokenUrl = new URL('https://auth.docker.io/token');
  tokenUrl.searchParams.set('service', 'registry.docker.io'); tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);
  const tokenBody = JSON.parse((await bytes(tokenUrl.href)).toString('utf8'));
  const token = z.string().min(1).max(32 * 1024).regex(/^[A-Za-z0-9._~-]+$/).parse(tokenBody.token ?? tokenBody.access_token);
  async function manifest(ref: string) {
    const raw = await bytes(`https://registry-1.docker.io/v2/${repository}/manifests/${ref}`, {
      Authorization: `Bearer ${token}`, Accept: [...media, ...indices].join(', '),
    });
    const hash = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    if (ref.startsWith('sha256:') && ref !== hash) throw invalid();
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (document.schemaVersion !== 2) throw invalid();
    return { digest: hash, document, bytes: raw.length };
  }
  const top = await manifest(reference); let image = top;
  if (indices.includes(top.document.mediaType)) {
    const entries = z.array(descriptor.extend({ platform: z.object({ os: z.literal('linux'), architecture: z.literal('amd64') }).passthrough() })).length(1).parse(top.document.manifests);
    if (!media.includes(entries[0].mediaType)) throw invalid();
    image = await manifest(entries[0].digest); if (image.bytes !== entries[0].size) throw invalid();
  }
  if (!media.includes(image.document.mediaType)) throw invalid();
  const config = descriptor.parse(image.document.config), layers = z.array(descriptor).min(1).max(256).parse(image.document.layers);
  if (!['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'].includes(config.mediaType)
    || layers.some(layer => !layerTypes.has(layer.mediaType))) throw invalid();
  const downloadBytes = top.bytes + (top === image ? 0 : image.bytes) + config.size + layers.reduce((sum, layer) => sum + layer.size, 0);
  if (downloadBytes > 8 * 1024 ** 3) throw invalid();
  return { digest: top.digest, manifestDigest: image.digest, configDigest: config.digest, downloadBytes,
    imageIdentity: (top === image ? 'manifest' : 'index') as 'manifest' | 'index', anonymous: true as const };
}
