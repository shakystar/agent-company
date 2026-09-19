import { join } from 'node:path';
import { desktopImageDistributionSchema } from '../shared/desktop-worker-images.ts';
import { canonicalRuntimeJson } from '../shared/runtime-releases.ts';
import { resolveDesktopWorkerProvider } from './desktop-worker-provider.ts';
import { assertDesktopProviderDirectory, readDesktopProviderFile, verifyPinnedDesktopFile } from './desktop-provider-files.ts';

/** Small metadata only. Archive semantics and bytes are verified by the installer. */
export async function readDesktopImagePackage(resourceRoot: string) {
  await assertDesktopProviderDirectory(resourceRoot);
  const directory = join(resourceRoot, 'runtimes', 'codex');
  const worker = await readDesktopProviderFile(join(directory, 'worker.json'), 2 * 1024 * 1024);
  const provider = await resolveDesktopWorkerProvider(resourceRoot);
  if (!provider) throw new Error('DESKTOP_IMAGE_PACKAGE_INVALID');
  const document = await readDesktopProviderFile(join(directory, 'images.json'), 16 * 1024);
  const parsed = desktopImageDistributionSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.data)));
  const images = parsed.images;
  if (new Set(images.map(image => image.kind)).size !== images.length
    || new Set(images.map(image => image.image)).size !== images.length
    || images.length !== (provider.browserImage ? 2 : 1)
    || images.find(image => image.kind === 'worker')?.image !== provider.releaseCatalog.active.image
    || images.find(image => image.kind === 'browser')?.image !== provider.browserImage) throw new Error('DESKTOP_IMAGE_PACKAGE_INVALID');
  const profiles = await Promise.all(['codex-userns.json', ...(provider.browserImage ? ['browser-userns.json'] : [])].map(async name => {
    const path = join(resourceRoot, 'worker', 'security', name);
    const file = await readDesktopProviderFile(path, 1024 * 1024);
    if (!file.pin.bytes) throw new Error('DESKTOP_IMAGE_PACKAGE_INVALID');
    return { path, pin: file.pin };
  }));
  const assertUnchanged = async () => {
    if (canonicalRuntimeJson(await resolveDesktopWorkerProvider(resourceRoot)) !== canonicalRuntimeJson(provider)) throw new Error('DESKTOP_IMAGE_PACKAGE_INVALID');
    await verifyPinnedDesktopFile(join(directory, 'worker.json'), worker.pin);
    await verifyPinnedDesktopFile(join(directory, 'images.json'), document.pin);
    for (const profile of profiles) await verifyPinnedDesktopFile(profile.path, profile.pin);
  };
  await assertUnchanged();
  return { provider, images: images.map(image => Object.freeze(image)), directory, assertUnchanged };
}

export async function desktopImagePackageAvailable(resourceRoot: string): Promise<boolean> {
  try { await readDesktopImagePackage(resourceRoot); return true; } catch { return false; }
}
