import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { desktopRegistryImagesSchema, type DesktopRegistryImage } from '../shared/desktop-worker-images.ts';
import { workerSourceFiles } from '../shared/runtime-releases.ts';
import { verifyDesktopImageArchive } from '../server/desktop-image-archive.ts';
import { inspectDesktopWorkerPackage } from './desktop-worker-package.ts';
import { assertDesktopProviderDirectory, readDesktopProviderFile, verifyPinnedDesktopFile, verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';
import { readDockerHubManifest } from './docker-hub-manifest.ts';

/** Prepares a metadata-only package from verified, independently preserved archives.
 * No push, login, Docker mutation or deletion. Publication and anonymous pull are separate checks. */
export async function prepareDesktopRegistryPackage(options: {
  source: string; destination: string; namespace: string; references: Partial<Record<'worker' | 'browser', string>>;
}, supplied: { verifyArchive?: typeof verifyDesktopImageArchive; readManifest?: typeof readDockerHubManifest } = {}) {
  const source = resolve(options.source), destination = resolve(options.destination);
  const inside = (parent: string, child: string) => {
    const part = relative(parent, child); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
  };
  if (!isAbsolute(options.source) || !isAbsolute(options.destination) || inside(source, destination) || inside(destination, source))
    throw new Error('Registry package requires a separate new absolute directory');
  // Validate the namespace before opening any large archive or creating output.
  desktopRegistryImagesSchema.parse({ version: 2, images: [{ kind: 'worker', image: `sha256:${'a'.repeat(64)}`,
    reference: `docker.io/${options.namespace}/agent-company-worker@sha256:${'a'.repeat(64)}`,
    imageIdentity: 'manifest', downloadBytes: 1, layerBytes: 1 }] });
  const receipt = await inspectDesktopWorkerPackage(source), images: DesktopRegistryImage[] = [];
  const runtime = join(source, 'runtimes', 'codex');
  const workerDocument = await readDesktopProviderFile(join(runtime, 'worker.json'), 2 * 1024 * 1024);
  const imageDocument = await readDesktopProviderFile(join(runtime, 'images.json'), 16 * 1024);
  for (const image of receipt.images) {
    if (!('file' in image)) throw new Error('Expected an independently verified archive package');
    const archive = await (supplied.verifyArchive ?? verifyDesktopImageArchive)(join(runtime, image.file), image);
    try {
      const repository = `${options.namespace}/agent-company-${image.kind}`, reference = options.references[image.kind];
      if (!reference || !/^sha256:[a-f0-9]{64}$/.test(reference)) throw new Error('Published registry digest required');
      const remote = await (supplied.readManifest ?? readDockerHubManifest)(repository, reference);
      if (remote.digest !== reference || remote.configDigest !== archive.configDigest
        || archive.imageIdentity !== 'config' && remote.digest !== archive.image) throw new Error('Registry image differs from the preserved runtime');
      images.push({ kind: image.kind, image: image.image, reference: `docker.io/${repository}@${remote.digest}`,
        imageIdentity: archive.imageIdentity, downloadBytes: remote.downloadBytes, layerBytes: archive.layerBytes });
    } finally { await archive.close(); }
  }
  const metadata = desktopRegistryImagesSchema.parse({ version: 2, images });
  const sources = await Promise.all([...workerSourceFiles.map(file => `worker/${file}`),
    'worker/security/codex-userns.json', ...(receipt.provider.browserImage ? ['worker/security/browser-userns.json'] : []),
    'worker/security/LICENSE.moby'].map(async file => ({ file, document: await readDesktopProviderFile(join(source, file), 1024 * 1024) })));
  await assertDesktopProviderDirectory(resolve(destination, '..'));
  await mkdir(destination);
  await mkdir(join(destination, 'worker')); await mkdir(join(destination, 'worker', 'security'));
  await mkdir(join(destination, 'runtimes')); await mkdir(join(destination, 'runtimes', 'codex'));
  for (const { file, document } of sources)
    await verifyPinnedDesktopPayloadFile(join(source, file), document.pin, { destination: join(destination, file) });
  await verifyPinnedDesktopFile(join(runtime, 'worker.json'), workerDocument.pin);
  await verifyPinnedDesktopFile(join(runtime, 'images.json'), imageDocument.pin);
  await writeFile(join(destination, 'runtimes', 'codex', 'images.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
  await writeFile(join(destination, 'runtimes', 'codex', 'worker.json'), workerDocument.data, { flag: 'wx' });
  const prepared = await inspectDesktopWorkerPackage(destination);
  const result = { at: new Date().toISOString(), source, destination, namespace: options.namespace,
    provider: prepared.provider, images, packageBytes: prepared.bytes,
    archivesExcludedBytes: receipt.images.reduce((sum, image) => sum + ('file' in image ? image.bytes : 0), 0),
    sourceImagesManifestSha256: imageDocument.pin.sha256, publicMetadataVerified: true, anonymousPullVerified: false };
  await writeFile(join(destination, 'registry-package.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}
