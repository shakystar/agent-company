import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readDockerHubManifest } from '../scripts/docker-hub-manifest.ts';
import { desktopImageDistributionSchema } from '../shared/desktop-worker-images.ts';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const configDigest = `sha256:${'a'.repeat(64)}`;
function fixture(overrides: Record<string, unknown> = {}) {
  const body = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: 500 },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${'b'.repeat(64)}`, size: 2000 }], ...overrides });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    if (url.startsWith('https://auth.docker.io/')) {
      assert.equal(new URL(url).searchParams.get('scope'), 'repository:fixture/agent-company-worker:pull');
      assert.deepEqual(init?.headers, {}); return new Response(JSON.stringify({ token: 'anonymous.fixture.token' }));
    }
    assert.ok(url.startsWith('https://registry-1.docker.io/v2/fixture/agent-company-worker/manifests/'));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer anonymous.fixture.token');
    return new Response(body);
  };
  return { body, calls, fetcher, digest: hash(body) };
}

test('anonymous Hub verification pins returned bytes and config identity without accessing account auth', async () => {
  const f = fixture(), result = await readDockerHubManifest('fixture/agent-company-worker', f.digest, f.fetcher);
  assert.equal(result.digest, f.digest); assert.equal(result.configDigest, configDigest);
  assert.equal(result.downloadBytes, Buffer.byteLength(f.body) + 2500); assert.equal(result.anonymous, true);
  assert.equal(f.calls.length, 2);
});
test('Hub metadata rejects changed digests, foreign layer URLs and unsupported platforms', async () => {
  const f = fixture(); await assert.rejects(readDockerHubManifest('fixture/agent-company-worker', `sha256:${'f'.repeat(64)}`, f.fetcher));
  const foreign = fixture({ layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: configDigest, size: 1, urls: ['https://foreign.invalid/layer'] }] });
  await assert.rejects(readDockerHubManifest('fixture/agent-company-worker', foreign.digest, foreign.fetcher));
  const index = fixture({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: configDigest, size: 1, platform: { os: 'windows', architecture: 'amd64' } }] });
  await assert.rejects(readDockerHubManifest('fixture/agent-company-worker', index.digest, index.fetcher));
});
test('Hub metadata blocks invalid repositories, redirects, failed responses and oversized metadata', async () => {
  const f = fixture(); await assert.rejects(readDockerHubManifest('evil.invalid/fixture/worker', f.digest, f.fetcher)); assert.equal(f.calls.length, 0);
  await assert.rejects(readDockerHubManifest('fixture/agent-company-worker', f.digest, async () => new Response('', { status: 429 })));
  await assert.rejects(readDockerHubManifest('fixture/agent-company-worker', f.digest, async () => new Response('x'.repeat(1024 * 1024 + 1))));
});
test('registry package schema accepts separate config and registry IDs while refusing mutable tags or altered manifest IDs', () => {
  const image = { kind: 'worker', image: configDigest, reference: `docker.io/fixture/agent-company-worker@sha256:${'b'.repeat(64)}`,
    imageIdentity: 'config', downloadBytes: 100, layerBytes: 200 };
  assert.ok(desktopImageDistributionSchema.safeParse({ version: 2, images: [image] }).success);
  for (const patch of [{ reference: 'docker.io/fixture/agent-company-worker:latest' }, { imageIdentity: 'manifest' }, { reference: 'https://docker.io/fixture/worker' },
    { downloadBytes: 0 }, { layerBytes: 9 * 1024 ** 3 }, { file: 'worker.tar' }])
    assert.equal(desktopImageDistributionSchema.safeParse({ version: 2, images: [{ ...image, ...patch }] }).success, false);
});
