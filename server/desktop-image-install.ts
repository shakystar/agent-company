import { createHash } from 'node:crypto';
import { lstat, statfs } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import type { DesktopRuntimeInstallProgress, DesktopRuntimeRecoveryInfo } from '../shared/desktop-runtime-setup.ts';
import { canonicalRuntimeJson } from '../shared/runtime-releases.ts';
import { desktopRegistryImageSchema, type DesktopRegistryImage } from '../shared/desktop-worker-images.ts';
import { readDesktopImagePackage } from './desktop-image-package.ts';
import { verifyDesktopImageArchive, type VerifiedDesktopImageArchive } from './desktop-image-archive.ts';
import { assertDesktopProviderDirectory } from './desktop-provider-files.ts';
import { createDesktopImageJournal, openDesktopImageJournal, type DesktopImageJournalReceipt } from './desktop-image-journal.ts';
import { resolveDesktopRuntimeSelection, type DesktopRuntimeContextOptions } from './desktop-runtime-factory.ts';
import type { DesktopDockerTarget } from './desktop-docker-target.ts';
import { command, type Command } from './process.ts';

const floor = 20n * 1024n ** 3n;
const journalName = 'desktop-image-install.pending.json';
export class DesktopImageInstallError extends Error {
  constructor(readonly code: 'DESKTOP_RUNTIME_INSTALL_FAILED' | 'DESKTOP_RUNTIME_INSTALL_SPACE'
    | 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' | 'DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE') { super(code); this.name = 'DesktopImageInstallError'; }
}
const uncertain = () => new DesktopImageInstallError('DESKTOP_RUNTIME_INSTALL_UNCERTAIN');
interface Dependencies {
  resolveRuntime: typeof resolveDesktopRuntimeSelection;
  readPackage: typeof readDesktopImagePackage;
  verifyArchive: typeof verifyDesktopImageArchive;
  freeBytes: (path: string) => Promise<bigint>;
}
const defaults: Dependencies = { resolveRuntime: resolveDesktopRuntimeSelection, readPackage: readDesktopImagePackage,
  verifyArchive: verifyDesktopImageArchive, freeBytes: async path => {
    const disk = await statfs(path, { bigint: true }); return disk.bavail * disk.bsize;
  } };

/** Any marker, including a partial or damaged one, blocks treating a restart as a fresh installation. */
export async function hasUnfinishedDesktopImageInstall(appDataRoot: string): Promise<boolean> {
  await assertDesktopProviderDirectory(appDataRoot);
  try { await lstat(join(appDataRoot, journalName)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

type ResolvedRuntime = Awaited<ReturnType<typeof resolveDesktopRuntimeSelection>>;
type ImagePackage = Awaited<ReturnType<typeof readDesktopImagePackage>>;
type InstallOptions = DesktopRuntimeContextOptions & {
  signal: AbortSignal; onProgress: (value: DesktopRuntimeInstallProgress) => void;
};
type RecoveryOptions = Omit<DesktopRuntimeContextOptions, 'selection'> & { signal: AbortSignal };

async function openTarget(resolved: ResolvedRuntime, bundle: ImagePackage, signal: AbortSignal) {
  const selection = { ...resolved.selection,
    wslExecutable: win32.normalize(resolved.selection.wslExecutable).replace(/^[a-z]:/, drive => drive.toUpperCase()) };
  const key = createHash('sha256').update(JSON.stringify([selection.wslExecutable, selection.distro])).digest('hex');
  let initializing = true;
  const openingSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const runner: Command = (file, args, input = {}) => {
    const current = initializing ? input.signal ? AbortSignal.any([openingSignal, input.signal]) : openingSignal : input.signal;
    return (resolved.dependencies.probeCommand ?? command)(file, args, { ...input, signal: current,
      beforeSpawn: () => { current?.throwIfAborted(); input.beforeSpawn?.(); } });
  };
  let target: DesktopDockerTarget;
  try { target = await resolved.dependencies.createTarget({ wslExecutable: selection.wslExecutable,
    distro: selection.distro, dockerConfigDir: join(resolved.paths.appDataRoot, 'setup-images', 'docker', key), runner }); }
  finally { initializing = false; }
  signal.throwIfAborted();
  const engine = await target.command('docker', ['version', '--format', '{{.Server.Version}}/{{.Server.Arch}}'], { signal, timeoutMs: 30_000 });
  if (engine.code !== 0 || engine.stdout.trim() !== `${bundle.provider.engine.version}/${bundle.provider.engine.arch}`) throw new Error();
  return { target, selection };
}

function assertRecoveryScope(journal: DesktopImageJournalReceipt, bundle: ImagePackage) {
  if (journal.images.some(image => !bundle.images.some(item => item.image === image))) throw uncertain();
}

/** A diagnosis reads the recorded target and image presence; it is not archive or model verification. */
export async function inspectDesktopImageRecovery(options: RecoveryOptions, supplied: Partial<Dependencies> = {}): Promise<DesktopRuntimeRecoveryInfo> {
  const dependencies = { ...defaults, ...supplied };
  try {
    options.signal.throwIfAborted();
    const journal = await openDesktopImageJournal(options.paths.appDataRoot, options.ownerKey);
    if (!journal) throw uncertain();
    const resolved = await dependencies.resolveRuntime({ ...options, selection: { ...journal.selection } }, {});
    const bundle = await dependencies.readPackage(resolved.paths.resourceRoot);
    if (canonicalRuntimeJson(resolved.provider) !== canonicalRuntimeJson(bundle.provider)) throw uncertain();
    assertRecoveryScope(journal, bundle); await journal.assertUnchanged();
    const { target } = await openTarget(resolved, bundle, options.signal);
    const images: DesktopRuntimeRecoveryInfo['images'] = [];
    for (const item of bundle.images) images.push({ kind: item.kind, status: await present(target, item.image, options.signal) ? 'present' : 'missing' });
    await bundle.assertUnchanged(); await journal.assertUnchanged(); options.signal.throwIfAborted();
    return { fingerprint: journal.fingerprint, selection: { ...journal.selection }, images };
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw uncertain();
  }
}

/** The completion capability is returned only after a full replay and descriptor cleanup.
 * Its caller must commit the matching settings before finishing the journal. */
export async function recoverDesktopRuntimeImages(options: RecoveryOptions & {
  info: DesktopRuntimeRecoveryInfo; onProgress: InstallOptions['onProgress'];
}, supplied: Partial<Dependencies> = {}) {
  options.signal.throwIfAborted();
  let journal: DesktopImageJournalReceipt | null;
  try {
    journal = await openDesktopImageJournal(options.paths.appDataRoot, options.ownerKey);
    if (!journal || journal.fingerprint !== options.info.fingerprint
      || canonicalRuntimeJson(journal.selection) !== canonicalRuntimeJson(options.info.selection)) throw uncertain();
  } catch { throw uncertain(); }
  const finish = await performInstall({ ...options, selection: { ...journal.selection } }, supplied, journal);
  if (!finish) throw uncertain();
  return { fingerprint: journal.fingerprint, selection: { ...journal.selection }, finish };
}

async function present(target: DesktopDockerTarget, image: string, signal?: AbortSignal): Promise<boolean> {
  const result = await target.command('docker', ['image', 'inspect', image, '--format', '{{json .}}'], { signal, timeoutMs: 30_000 });
  if (result.code !== 0) {
    // A transport/daemon error must not be interpreted as an absent image.
    if (result.code === 1 && /^Error response from daemon: No such image: sha256:[a-f0-9]{64}\s*$/.test(result.stderr)
      && result.stderr.includes(image)) return false;
    throw new DesktopImageInstallError('DESKTOP_RUNTIME_INSTALL_FAILED');
  }
  const value = JSON.parse(result.stdout);
  if (value.Id !== image || value.Os !== 'linux' || value.Architecture !== 'amd64') throw new DesktopImageInstallError('DESKTOP_RUNTIME_INSTALL_FAILED');
  return true;
}

/** First configuration only; the setup manager owns installation/deployment admission.
 * Registry packages pull only their pinned public digests. No tag, model, account
 * mutation, container or image deletion is performed. */
export async function installDesktopRuntimeImages(options: InstallOptions, supplied: Partial<Dependencies> = {}): Promise<void> {
  await performInstall(options, supplied);
}

async function performInstall(options: InstallOptions, supplied: Partial<Dependencies>, recovery?: DesktopImageJournalReceipt) {
  const dependencies = { ...defaults, ...supplied }, verified: VerifiedDesktopImageArchive[] = [];
  const signal = options.signal;
  let clearJournal: (() => Promise<void>) | undefined, uncertainLoad = false;
  try {
    signal.throwIfAborted();
    if (recovery) await recovery.assertUnchanged();
    else if (await hasUnfinishedDesktopImageInstall(options.paths.appDataRoot)) throw uncertain();
    const resolved = await dependencies.resolveRuntime(options, {});
    const bundle = await dependencies.readPackage(resolved.paths.resourceRoot);
    if (canonicalRuntimeJson(resolved.provider) !== canonicalRuntimeJson(bundle.provider)) throw new Error();
    if (recovery) assertRecoveryScope(recovery, bundle);
    options.onProgress({ stage: 'verifying', completed: 0, total: bundle.images.length });
    const prepared: Array<VerifiedDesktopImageArchive | DesktopRegistryImage> = [];
    for (const item of bundle.images) {
      signal.throwIfAborted();
      if ('file' in item) {
        const archive = await dependencies.verifyArchive(join(bundle.directory, item.file), item, signal);
        verified.push(archive); prepared.push(archive);
      } else prepared.push(desktopRegistryImageSchema.parse(item));
      options.onProgress({ stage: 'verifying', completed: prepared.length, total: bundle.images.length });
    }
    await bundle.assertUnchanged(); signal.throwIfAborted();
    options.onProgress({ stage: 'checking', completed: 0, total: bundle.images.length });
    const { target, selection } = await openTarget(resolved, bundle, signal);
    const info = await target.command('docker', ['info', '--format', '{{json .DriverStatus}}'], { signal, timeoutMs: 30_000 });
    if (info.code !== 0) throw new Error();
    const rows: unknown = JSON.parse(info.stdout);
    if (rows !== null && (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== 'string')))) throw new Error();
    const driverTypes = (rows as string[][] | null)?.filter(row => row[0] === 'driver-type') ?? [];
    if (driverTypes.length > 1 || driverTypes.length === 1 && driverTypes[0][1] !== 'io.containerd.snapshotter.v1') throw new Error();
    const containerd = driverTypes.length === 1;
    if (prepared.some(archive => containerd === (archive.imageIdentity === 'config'))) {
      // Classic stores identify images by config hash; containerd stores use the
      // manifest/index target. Importing across this boundary changes runtime pins.
      throw new DesktopImageInstallError('DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE');
    }
    const missing: typeof prepared = [];
    for (const archive of prepared) {
      signal.throwIfAborted();
      const exists = await present(target, archive.image, signal);
      if (recovery) {
        // Presence alone cannot establish that an interrupted import finished unpacking.
        // Replay every recorded image, and never enlarge the interrupted operation's scope.
        if (recovery.images.includes(archive.image)) missing.push(archive);
        else if (!exists) throw uncertain();
      } else if (!exists) missing.push(archive);
      options.onProgress({ stage: 'checking', completed: prepared.indexOf(archive) + 1, total: prepared.length });
    }
    // This is a host preflight, not a quota or proof about a custom Docker storage filesystem.
    const required = missing.reduce((sum, item) => sum + BigInt('reference' in item ? item.downloadBytes : item.archiveBytes)
      + 2n * BigInt(item.layerBytes), 64n * 1024n ** 2n);
    if (missing.length) for (const path of new Set([resolved.paths.appDataRoot, win32.parse(selection.wslExecutable).root])) {
      if (await dependencies.freeBytes(path) - required < floor) throw new DesktopImageInstallError('DESKTOP_RUNTIME_INSTALL_SPACE');
    }
    await bundle.assertUnchanged(); signal.throwIfAborted();
    for (let index = 0; index < missing.length; index++) {
      signal.throwIfAborted();
      if (recovery) await recovery.assertUnchanged();
      else if (!clearJournal) {
        try { const journal = await createDesktopImageJournal(options.paths.appDataRoot, options.ownerKey, options.selection, missing.map(item => item.image));
          clearJournal = () => journal.clear(); }
        catch { uncertainLoad = true; throw uncertain(); }
      }
      const archive = missing[index];
      const stage = 'reference' in archive ? 'downloading' : 'loading';
      options.onProgress({ stage, completed: index, total: missing.length });
      let submitted = false, loadConfirmed = false, unexpectedOutput = false, outputBytes = 0;
      try {
        // Once submitted, user cancellation waits for the real CLI response. Killing
        // wsl.exe cannot prove that Docker's daemon-side import has finished.
        if ('reference' in archive) {
          const result = await target.command('docker', ['image', 'pull', '--platform=linux/amd64', '--quiet', archive.reference], {
            timeoutMs: 1_800_000, captureStdout: false,
            beforeSpawn: () => { signal.throwIfAborted(); submitted = true; },
            onStdout: bytes => { outputBytes += bytes.length; if (outputBytes > 64 * 1024) throw uncertain(); },
          });
          if (result.code !== 0) throw uncertain();
          const inspected = await target.command('docker', ['image', 'inspect', archive.reference, '--format', '{{json .}}'], { timeoutMs: 30_000 });
          if (inspected.code !== 0) throw uncertain();
          const image = JSON.parse(inspected.stdout), expectedDigest = archive.reference.split('@')[1];
          // The reference and the runtime ID must resolve to the same linux image.
          // RepoDigests may omit the docker.io prefix; compare the digest and repository.
          const canonical = (value: string) => value.replace(/^docker\.io\//, '');
          if (image.Id !== archive.image || image.Os !== 'linux' || image.Architecture !== 'amd64'
            || !Array.isArray(image.RepoDigests) || !image.RepoDigests.some((value: unknown) => typeof value === 'string'
              && canonical(value) === canonical(archive.reference) && value.endsWith(`@${expectedDigest}`))) throw uncertain();
        } else {
        const result = await target.command('docker', ['image', 'load', '--platform=linux/amd64', '--quiet'], {
          timeoutMs: 1_800_000, inputStream: archive.chunks(), captureStdout: false,
          beforeSpawn: () => { signal.throwIfAborted(); submitted = true; },
          onStdout: bytes => { outputBytes += bytes.length; if (outputBytes > 16 * 1024) throw uncertain(); },
          onLine: value => {
            const line = value.trim(); if (!line) return;
            if (line === `Loaded image ID: ${archive.image}` && !loadConfirmed) loadConfirmed = true;
            else unexpectedOutput = true;
          },
        });
        // Docker 29's containerd loader can print an unpack error and still exit 0.
        if (result.code !== 0 || !loadConfirmed || unexpectedOutput) { uncertainLoad = true; throw uncertain(); }
        }
      } catch (error) {
        if (submitted) { uncertainLoad = true; throw uncertain(); }
        throw error;
      }
      // Re-inspection runs even after cancellation. Completion and the exact immutable
      // ID must be known before the pending marker can be removed.
      try { if (!await present(target, archive.image)) throw new Error(); }
      catch { uncertainLoad = true; throw uncertain(); }
      options.onProgress({ stage, completed: index + 1, total: missing.length });
    }
    await bundle.assertUnchanged();
    signal.throwIfAborted();
    if (recovery) {
      await recovery.assertUnchanged();
      return async () => { await bundle.assertUnchanged(); await recovery.clear(); };
    }
  } catch (error) {
    if (error instanceof DesktopImageInstallError || signal.aborted) throw error;
    throw new DesktopImageInstallError('DESKTOP_RUNTIME_INSTALL_FAILED');
  } finally {
    const closed = await Promise.allSettled(verified.map(archive => archive.close()));
    if (closed.some(result => result.status === 'rejected')) uncertainLoad = true;
    if (clearJournal && !uncertainLoad) {
      try { await clearJournal(); } catch { uncertainLoad = true; }
    }
    if (uncertainLoad) throw uncertain();
  }
}
