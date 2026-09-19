import { createHash } from 'node:crypto';
import { dirname, join, isAbsolute, win32 } from 'node:path';
import { z } from 'zod';
import type { DesktopNoticeComponent } from './desktop-notices.ts';
import { assertDesktopProviderDirectory, readDesktopProviderFile, verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';

const invalid = () => new Error('DESKTOP_NOTICE_SUPPLEMENT_INVALID');
const line = z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const documentSchema = z.object({ file: line, bytes: z.number().int().positive().max(1024 * 1024), sha256: sha,
  url: line.refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }),
  commit: z.string().regex(/^[a-f0-9]{40}$/).optional(), gitBlob: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  upstreamPath: line.optional() }).strict();
const schema = z.object({ version: z.literal(1), supplements: z.array(z.object({ ecosystem: z.enum(['npm', 'cargo']),
  name: line, version: line, source: line, basis: z.string().min(1).max(8192),
  documents: z.array(documentSchema).min(1).max(64) }).strict()).max(512) }).strict();
type Supplement = z.infer<typeof schema>['supplements'][number];
export type DesktopNoticeSupplementSource = Pick<Supplement, 'basis' | 'documents'>;
const identity = (value: { ecosystem: string; name: string; version: string; source: string }) =>
  JSON.stringify([value.ecosystem, value.name, value.version, value.source]);
const safeFile = (value: string) => !isAbsolute(value) && !win32.isAbsolute(value) && !value.includes('\\')
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f\x7f]|[. ]$/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part));

/** Supplements are reviewed original documents, bound to an exact resolved component.
 * Reading this local index never downloads, rewrites an installed package or grants distribution approval. */
export async function applyDesktopNoticeSupplements(components: DesktopNoticeComponent[], manifestPath: string) {
  const directory = dirname(manifestPath); await assertDesktopProviderDirectory(directory);
  const manifest = await readDesktopProviderFile(manifestPath, 2 * 1024 * 1024);
  let parsed: z.infer<typeof schema>;
  try { parsed = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.data))); } catch { throw invalid(); }
  const pins = [{ path: manifestPath, pin: manifest.pin }], entries = new Set<string>();
  const replacements = new Map<string, { files: DesktopNoticeComponent['files']; provenance: DesktopNoticeSupplementSource }>();
  let totalBytes = 0;
  for (const supplement of parsed.supplements) {
    const key = identity(supplement);
    if (entries.has(key) || !components.some(component => identity(component) === key)) throw invalid();
    entries.add(key); const names = new Set<string>(), files: DesktopNoticeComponent['files'] = [];
    for (const document of supplement.documents) {
      if (!safeFile(document.file) || names.has(document.file.toLowerCase())) throw invalid();
      names.add(document.file.toLowerCase());
      const path = join(directory, document.file), snapshot = await readDesktopProviderFile(path, 1024 * 1024);
      // Check the exact bytes being returned; re-opening a path cannot authenticate this snapshot.
      if (snapshot.pin.bytes !== document.bytes || snapshot.pin.sha256 !== document.sha256) throw invalid();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.data);
      if (text.includes('\0') || (totalBytes += snapshot.data.length) > 32 * 1024 * 1024) throw invalid();
      if (document.gitBlob && createHash('sha1').update(Buffer.from(`blob ${snapshot.data.length}\0`)).update(snapshot.data).digest('hex') !== document.gitBlob) throw invalid();
      pins.push({ path, pin: snapshot.pin }); files.push({ path: `upstream/${document.file}`, data: snapshot.data });
    }
    replacements.set(key, { files, provenance: { basis: supplement.basis, documents: structuredClone(supplement.documents) } });
  }
  const result = components.map(component => {
    const supplement = replacements.get(identity(component));
    const original = { ...component, files: component.files.map(file => ({ path: file.path, data: Buffer.from(file.data) })), issues: [...component.issues] };
    if (!supplement) return original;
    const names = new Set(original.files.map(file => file.path.toLowerCase()));
    if (supplement.files.some(file => names.has(file.path.toLowerCase())) || component.supplementalSources?.length) throw invalid();
    // Resolve only absence of an original. Damaged sources, metadata/provenance and licensing issues remain.
    original.issues = original.issues.filter(issue => issue !== 'NOTICE_FILES_MISSING'
      && issue !== 'No license or attribution document is present in the installed package');
    return { ...original, files: [...original.files, ...supplement.files], supplementalSources: [supplement.provenance] };
  });
  const assertUnchanged = async () => { for (const { path, pin } of pins) await verifyPinnedDesktopPayloadFile(path, pin); };
  await assertUnchanged();
  return { components: result, manifestSha256: manifest.pin.sha256, applied: entries.size, assertUnchanged };
}
