import { createHash } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { command, type Command } from '../server/process.ts';
import { atomicJson } from '../server/storage.ts';
import { assertDesktopProviderDirectory, readDesktopProviderFile, verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';
import { assertDesktopPayloadCopySpace, copyDesktopPayload, parseDesktopPayloadManifest, type DesktopPayload } from './desktop-payload.ts';
import { collectDesktopRustNotices } from './desktop-rust-notices.ts';
import { writeDesktopNotices } from './desktop-notices.ts';
import { applyDesktopNoticeSupplements } from './desktop-notice-supplements.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = (code = 'DESKTOP_NATIVE_NOTICES_INVALID') => Object.assign(new Error(code), { code });
const prefix = 'resources/notices/native';
const contains = (parent: string, path: string) => {
  const value = relative(resolve(parent), resolve(path));
  return !value || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};

/** A new, unpublished staging directory only. Space and command injection are fixture seams;
 * production uses the existing 20 GiB floor and standard offline/locked Cargo metadata command. */
export async function stageDesktopNativeNotices(input: {
  projectRoot: string; payload: DesktopPayload; destination: string; additionalBytes: bigint;
}, supplied: { command?: Command; assertSpace?: typeof assertDesktopPayloadCopySpace } = {}) {
  const { projectRoot, destination, additionalBytes } = input;
  const originalBytes = Buffer.from(input.payload.manifestBytes), manifest = parseDesktopPayloadManifest(originalBytes);
  const payload: DesktopPayload = { source: input.payload.source, manifest, manifestBytes: originalBytes,
    copyBytes: manifest.files.reduce((sum, file) => sum + BigInt(file.bytes), BigInt(originalBytes.length)) };
  if (typeof additionalBytes !== 'bigint' || additionalBytes < 0n || !isAbsolute(destination)
    || contains(payload.source, destination) || contains(destination, payload.source)
    || manifest.files.some(file => file.path.toLowerCase() === prefix || file.path.toLowerCase().startsWith(`${prefix}/`))) throw invalid();
  await assertDesktopProviderDirectory(projectRoot); await assertDesktopProviderDirectory(dirname(destination));
  try { await lstat(destination); throw invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const assertSpace = supplied.assertSpace ?? assertDesktopPayloadCopySpace;
  const baseBytes = payload.copyBytes + additionalBytes;
  // No Cargo process or new candidate exists before this first capacity gate.
  await assertSpace(dirname(destination), baseBytes + 4n * 1024n * 1024n);
  const manifestPath = join(projectRoot, 'desktop/src-tauri/Cargo.toml'), lockPath = join(projectRoot, 'desktop/src-tauri/Cargo.lock');
  const cargoManifest = await readDesktopProviderFile(manifestPath, 2 * 1024 * 1024);
  const cargoLock = await readDesktopProviderFile(lockPath, 2 * 1024 * 1024);
  const sources = [{ path: manifestPath, ...cargoManifest, stat: await lstat(manifestPath, { bigint: true }) },
    { path: lockPath, ...cargoLock, stat: await lstat(lockPath, { bigint: true }) }];
  const assertSourcesUnchanged = async () => {
    try {
      for (const source of sources) {
        await verifyPinnedDesktopPayloadFile(source.path, source.pin);
        const current = await lstat(source.path, { bigint: true });
        if (source.stat.dev !== current.dev || source.stat.ino !== current.ino || source.stat.mtimeNs !== current.mtimeNs || source.stat.ctimeNs !== current.ctimeNs) throw invalid();
      }
    } catch { throw invalid('DESKTOP_NATIVE_CARGO_INPUT_CHANGED'); }
  };
  const args = ['metadata', '--format-version', '1', '--offline', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', manifestPath];
  const chunks: Buffer[] = []; let received = 0;
  try {
    const result = await (supplied.command ?? command)('cargo', args, { timeoutMs: 120_000, captureStdout: false, onStdout: chunk => {
      received += chunk.length; if (received > 16 * 1024 * 1024) throw invalid(); chunks.push(Buffer.from(chunk));
    } });
    if (result.code !== 0) throw invalid();
  } catch { throw invalid('DESKTOP_NATIVE_CARGO_METADATA_FAILED'); }
  await assertSourcesUnchanged();
  const metadataBytes = Buffer.concat(chunks); let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)); } catch { throw invalid('DESKTOP_NATIVE_CARGO_METADATA_FAILED'); }
  const notices = await collectDesktopRustNotices(metadata);
  const supplements = await applyDesktopNoticeSupplements(notices.components, join(projectRoot, 'desktop/notices/cargo/supplements.json'));
  // The collector validates this graph before we associate it with this exact manifest snapshot.
  const graph = metadata as { resolve: { root: string }; packages: Array<{ id: string; manifest_path: string }> };
  const project = graph.packages.find(pkg => pkg.id === graph.resolve.root);
  if (!project || relative(manifestPath, project.manifest_path)) throw invalid('DESKTOP_NATIVE_CARGO_METADATA_FAILED');
  await assertSourcesUnchanged();
  // Conservative upper bound for original text, per-document headings and pretty JSON inventory.
  // Count metadata separately from Buffers so a 32 MiB collection is never expanded into JSON byte arrays.
  let noticeBytes = 64 * 1024;
  for (const component of supplements.components) {
    const metadata = { ...component, files: component.files.map(file => ({ path: file.path, bytes: file.data.length, sha256: '0'.repeat(64) })) };
    noticeBytes += 2 * Buffer.byteLength(JSON.stringify(metadata)) + 512;
    for (const file of component.files) noticeBytes += file.data.length + 2 * Buffer.byteLength(`${component.name} ${component.version} ${file.path}`) + 512;
  }
  noticeBytes += 2 * Buffer.byteLength(JSON.stringify(notices.issues));
  await assertSpace(dirname(destination), baseBytes + BigInt(noticeBytes + cargoLock.data.length + 2 * 1024 * 1024));
  await assertSourcesUnchanged();
  await supplements.assertUnchanged();
  await mkdir(destination); await copyDesktopPayload(payload, destination);
  const noticeParent = join(destination, 'resources/notices');
  await mkdir(noticeParent).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  await assertDesktopProviderDirectory(noticeParent);
  await supplements.assertUnchanged();
  const receipt = await writeDesktopNotices(join(destination, prefix), supplements.components, notices.issues);
  if (receipt.files.length !== 2 || receipt.files.map(file => file.path).sort().join('/') !== 'THIRD-PARTY-NOTICES.txt/inventory.json') throw invalid();
  const noticeFiles = receipt.files.map(file => ({ ...file, path: `${prefix}/${file.path}` }));
  for (const file of noticeFiles) await verifyPinnedDesktopPayloadFile(join(destination, file.path), file);
  await assertSourcesUnchanged();
  // Use the bytes that were checked before metadata, never a fresh lockfile copy.
  await writeFile(join(destination, 'native-dependencies.lock'), cargoLock.data, { flag: 'wx' });
  await verifyPinnedDesktopPayloadFile(join(destination, 'native-dependencies.lock'), cargoLock.pin);
  const nativeNotices = { ...receipt, files: noticeFiles, cargoManifestSha256: cargoManifest.pin.sha256,
    cargoLockSha256: cargoLock.pin.sha256, cargoMetadataSha256: hash(metadataBytes),
    supplements: { manifestSha256: supplements.manifestSha256, applied: supplements.applied } };
  const updated = { ...manifest, distributionReady: false, nativeNotices, files: [...manifest.files, ...noticeFiles] };
  const updatedBytes = Buffer.from(JSON.stringify(updated)); parseDesktopPayloadManifest(updatedBytes);
  await verifyPinnedDesktopPayloadFile(join(destination, 'payload-manifest.json'), { bytes: originalBytes.length, sha256: hash(originalBytes) });
  await assertSourcesUnchanged();
  // This replacement is confined to the new candidate created above. Earlier candidates remain untouched.
  await atomicJson(join(destination, 'payload-manifest.json'), updated);
  await verifyPinnedDesktopPayloadFile(join(destination, 'payload-manifest.json'), { bytes: updatedBytes.length, sha256: hash(updatedBytes) });
  return { manifest: parseDesktopPayloadManifest(updatedBytes), payloadManifestSha256: hash(updatedBytes),
    sourcePayloadManifestSha256: hash(originalBytes), cargoLockSha256: cargoLock.pin.sha256, nativeNotices };
}
