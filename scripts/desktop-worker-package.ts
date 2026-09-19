import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { desktopImageDistributionSchema as imagesSchema, type DesktopDistributedImage } from '../shared/desktop-worker-images.ts';
import { resolveDesktopWorkerProvider, type DesktopWorkerProvider } from '../server/desktop-worker-provider.ts';
import { canonicalRuntimeJson, requireWorkerRelease, workerSourceFiles } from '../shared/runtime-releases.ts';
import { assertDesktopProviderDirectory, readDesktopProviderFile, verifyPinnedDesktopArchive,
  verifyPinnedDesktopFile, type PinnedDesktopFile } from './desktop-provider-files.ts';

export type { DesktopWorkerPackageImage } from '../shared/desktop-worker-images.ts';
export interface DesktopWorkerPackageReceipt {
  provider: DesktopWorkerProvider;
  images: DesktopDistributedImage[];
  /** Bytes staged under runtimes/codex: archives and the two manifest files. */
  bytes: number;
}
export class DesktopWorkerPackageError extends Error {
  readonly code = 'DESKTOP_WORKER_PACKAGE_INVALID';
  constructor() { super('DESKTOP_WORKER_PACKAGE_INVALID'); this.name = 'DesktopWorkerPackageError'; }
}
const invalid = () => new DesktopWorkerPackageError();
const samePin = (a: PinnedDesktopFile, b: PinnedDesktopFile) => a.bytes === b.bytes && a.sha256 === b.sha256;
const sameProvider = (a: DesktopWorkerProvider | null, b: DesktopWorkerProvider) => a && canonicalRuntimeJson(a) === canonicalRuntimeJson(b);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
type Document = Awaited<ReturnType<typeof readDesktopProviderFile>>;
type Checked = { root: string; receipt: DesktopWorkerPackageReceipt; workerDocument: Document; imagesDocument: Document;
  profiles: Array<{ file: string; pin: PinnedDesktopFile }> };

async function assertSource(checked: Checked): Promise<void> {
  const directory = join(checked.root, 'runtimes', 'codex');
  if (!sameProvider(await resolveDesktopWorkerProvider(checked.root), checked.receipt.provider)) throw invalid();
  await verifyPinnedDesktopFile(join(directory, 'worker.json'), checked.workerDocument.pin);
  await verifyPinnedDesktopFile(join(directory, 'images.json'), checked.imagesDocument.pin);
  for (const profile of checked.profiles) {
    const current = await readDesktopProviderFile(join(checked.root, 'worker', 'security', profile.file), 1024 * 1024);
    if (!samePin(current.pin, profile.pin)) throw invalid();
  }
}
async function inspect(input: string): Promise<Checked> {
  await assertDesktopProviderDirectory(input);
  const root = resolve(input), directory = join(root, 'runtimes', 'codex');
  const workerDocument = await readDesktopProviderFile(join(directory, 'worker.json'), 2 * 1024 * 1024);
  const provider = await resolveDesktopWorkerProvider(root);
  if (!provider) throw invalid();
  const imagesDocument = await readDesktopProviderFile(join(directory, 'images.json'), 16 * 1024);
  const { images } = imagesSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(imagesDocument.data)));
  if (new Set(images.map(item => item.kind)).size !== images.length || new Set(images.map(item => item.image)).size !== images.length
    || images.length !== (provider.browserImage ? 2 : 1)
    || images.find(item => item.kind === 'worker')?.image !== provider.releaseCatalog.active.image
    || images.find(item => item.kind === 'browser')?.image !== provider.browserImage) throw invalid();
  const profiles: Checked['profiles'] = [];
  for (const file of ['codex-userns.json', ...(provider.browserImage ? ['browser-userns.json'] : [])]) {
    const profile = await readDesktopProviderFile(join(root, 'worker', 'security', file), 1024 * 1024);
    if (!profile.pin.bytes) throw invalid();
    profiles.push({ file, pin: profile.pin });
  }
  for (const image of images) if ('file' in image) await verifyPinnedDesktopArchive(join(directory, image.file), image);
  const receipt = freeze({ provider, images, bytes: images.reduce((sum, item) => sum + ('file' in item ? item.bytes : 0), 0)
    + workerDocument.pin.bytes + imagesDocument.pin.bytes });
  const checked = { root, receipt, workerDocument, imagesDocument, profiles };
  await assertSource(checked);
  return checked;
}

/** File/hash verification only. Tar semantics, official image provenance and Docker save/load are separate gates. */
export async function inspectDesktopWorkerPackage(packageResourceRoot: string): Promise<DesktopWorkerPackageReceipt> {
  try { return (await inspect(packageResourceRoot)).receipt; }
  catch { throw invalid(); }
}

async function assertDestinationWorker(root: string, checked: Checked): Promise<void> {
  const active = requireWorkerRelease(checked.receipt.provider.releaseCatalog, checked.receipt.provider.releaseCatalog.active);
  for (const file of workerSourceFiles) {
    const actual = await readDesktopProviderFile(join(root, 'worker', file), 1024 * 1024);
    if (actual.pin.sha256 !== active.sourceHashes[file]) throw invalid();
  }
  for (const profile of checked.profiles) {
    const actual = await readDesktopProviderFile(join(root, 'worker', 'security', profile.file), 1024 * 1024);
    if (!samePin(actual.pin, profile.pin)) throw invalid();
  }
}
async function writeDocument(directory: string, name: string, document: Document): Promise<void> {
  await assertDesktopProviderDirectory(directory);
  const path = join(directory, name), output = await open(path, 'wx', 0o600);
  try { await output.writeFile(document.data); await output.sync(); } finally { await output.close(); }
  const actual = await readDesktopProviderFile(path, 2 * 1024 * 1024);
  if (!samePin(actual.pin, document.pin)) throw invalid();
}
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

/** The caller owns the destination payload. All existing files remain untouched on failure.
 * Only the new codex tree is written; worker.json is published after archives and matching worker resources. */
export async function stageDesktopWorkerPackage(inputRoot: string, destinationResourceRoot: string,
  expected?: DesktopWorkerPackageReceipt): Promise<DesktopWorkerPackageReceipt> {
  try {
    await assertDesktopProviderDirectory(inputRoot); await assertDesktopProviderDirectory(destinationResourceRoot);
    const sourceRoot = resolve(inputRoot), destinationRoot = resolve(destinationResourceRoot);
    if (inside(sourceRoot, destinationRoot) || inside(destinationRoot, sourceRoot)) throw invalid();
    const runtimes = join(destinationRoot, 'runtimes'), directory = join(runtimes, 'codex');
    const existing = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (existing) throw invalid();
    const checked = await inspect(sourceRoot);
    if (expected && canonicalRuntimeJson(checked.receipt) !== canonicalRuntimeJson(expected)) throw invalid();
    await assertDestinationWorker(destinationRoot, checked);
    await mkdir(runtimes).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await assertDesktopProviderDirectory(runtimes);
    await mkdir(directory); // Never adopt an existing tree, even if it appears after inspection.
    for (const image of checked.receipt.images) {
      if (!('file' in image)) continue;
      await verifyPinnedDesktopArchive(join(sourceRoot, 'runtimes', 'codex', image.file), image, { destination: join(directory, image.file) });
      await verifyPinnedDesktopArchive(join(directory, image.file), image);
    }
    await assertSource(checked); await assertDestinationWorker(destinationRoot, checked);
    // Copy the already checked byte snapshots, never a second untrusted JSON read.
    await writeDocument(directory, 'images.json', checked.imagesDocument);
    await writeDocument(directory, 'worker.json', checked.workerDocument);
    if (!sameProvider(await resolveDesktopWorkerProvider(destinationRoot), checked.receipt.provider)) throw invalid();
    return checked.receipt;
  } catch { throw invalid(); }
}
