import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { prepareDesktopRegistryPackage } from '../scripts/desktop-registry-package.ts';
import { workerSourceFiles, createWorkerReleaseManifest } from '../shared/runtime-releases.ts';

const pin = (value: string) => ({ bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });
const image = `sha256:${'a'.repeat(64)}`, registryDigest = `sha256:${'b'.repeat(64)}`;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-registry-package-'));
  t.after(async () => { const path = relative(tmpdir(), root);
    assert.ok(path.startsWith('ac-registry-package-') && !isAbsolute(path) && !path.includes(sep)); await rm(root, { recursive: true }); });
  const source = join(root, 'source'), destination = join(root, 'prepared');
  await mkdir(join(source, 'worker/security'), { recursive: true }); await mkdir(join(source, 'runtimes/codex'), { recursive: true });
  const sourceHashes: Record<string, string> = {};
  for (const file of workerSourceFiles) { const content = file === 'npm-empty.npmrc' ? '' : `// ${file}`;
    await writeFile(join(source, 'worker', file), content); sourceHashes[file] = pin(content).sha256; }
  await writeFile(join(source, 'worker/security/codex-userns.json'), '{}');
  await writeFile(join(source, 'worker/security/LICENSE.moby'), 'fixture-license');
  const manifest = createWorkerReleaseManifest({ image, runtimeBaseHash: 'c'.repeat(64), sourceHashes });
  await writeFile(join(source, 'runtimes/codex/worker.json'), JSON.stringify({ version: 1, provider: 'codex', codexVersion: '0.154.0', target: 'linux-x64',
    engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
    releaseCatalog: { version: 1, active: { image, manifestId: manifest.id }, manifests: [manifest] } }));
  const content = 'separately checked archive fixture'; await writeFile(join(source, 'runtimes/codex/worker.tar'), content);
  await writeFile(join(source, 'runtimes/codex/images.json'), JSON.stringify({ version: 1, images: [{ kind: 'worker', image, file: 'worker.tar', ...pin(content) }] }));
  let closed = 0, remoteConfig = image;
  const dependencies: NonNullable<Parameters<typeof prepareDesktopRegistryPackage>[1]> = {
    verifyArchive: async () => ({ image, imageIdentity: 'config', configDigest: image, manifestDigest: registryDigest, format: 'docker29-classic',
      archiveBytes: Buffer.byteLength(content), layerBytes: 100, layerFileBytes: 50, layerCount: 1,
      async *chunks() { throw new Error('No archive transfer is permitted'); }, close: async () => { closed++; } }),
    readManifest: async (repository, reference) => { assert.equal(repository, 'fixture/agent-company-worker'); assert.equal(reference, registryDigest);
      return { digest: registryDigest, manifestDigest: registryDigest, configDigest: remoteConfig, downloadBytes: 50, imageIdentity: 'manifest', anonymous: true }; },
  };
  return { source, destination, content, dependencies, options: { source, destination, namespace: 'fixture', references: { worker: registryDigest } },
    get closed() { return closed; }, set remoteConfig(value: string) { remoteConfig = value; } };
}
test('registry preparation preserves classic image IDs, validates public manifest mapping and excludes archives', async t => {
  const f = await fixture(t), result = await prepareDesktopRegistryPackage(f.options, f.dependencies);
  assert.equal(result.images[0].image, image); assert.equal(result.images[0].reference, `docker.io/fixture/agent-company-worker@${registryDigest}`);
  assert.equal(f.closed, 1); assert.equal(result.archivesExcludedBytes, Buffer.byteLength(f.content));
  assert.deepEqual((await readdir(join(f.destination, 'runtimes/codex'))).sort(), ['images.json', 'worker.json']);
  assert.equal(await readFile(join(f.source, 'runtimes/codex/worker.tar'), 'utf8'), f.content);
});
test('registry preparation refuses a public image with another config before creating the package', async t => {
  const f = await fixture(t); f.remoteConfig = registryDigest;
  await assert.rejects(prepareDesktopRegistryPackage(f.options, f.dependencies), /differs from the preserved runtime/);
  assert.equal(f.closed, 1); await assert.rejects(access(f.destination));
});
test('registry preparation rejects missing immutable digests and existing destinations without modifying them', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareDesktopRegistryPackage({ ...f.options, references: {} }, f.dependencies), /Published registry digest required/);
  await mkdir(f.destination); await writeFile(join(f.destination, 'retained'), 'keep');
  await assert.rejects(prepareDesktopRegistryPackage(f.options, f.dependencies));
  assert.equal(await readFile(join(f.destination, 'retained'), 'utf8'), 'keep');
});
