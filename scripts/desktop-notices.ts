import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import nodeSource from '../desktop/providers/node/24.11.1/source.json' with { type: 'json' };
import { assertDesktopProviderDirectory, inspectDesktopFile, readDesktopProviderFile, verifyPinnedDesktopFile, verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';
import type { DesktopNoticeSupplementSource } from './desktop-notice-supplements.ts';

export interface DesktopNoticeComponent {
  id: string; name: string; version: string; ecosystem: string; license: string | null; source: string;
  files: Array<{ path: string; data: Buffer }>; issues: string[];
  supplementalSources?: DesktopNoticeSupplementSource[];
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const maximumTotal = 32 * 1024 * 1024;
const nameSchema = z.string().regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i);
const dependencySchema = z.record(nameSchema, z.string());
const packageSchema = z.object({ name: nameSchema, version: z.string().min(1).max(100),
  license: z.string().max(1000).optional(), dependencies: dependencySchema.optional() }).passthrough();
const lockSchema = z.object({ lockfileVersion: z.literal(3), packages: z.record(z.string(), z.object({
  version: z.string().optional(), dev: z.boolean().optional(), integrity: z.string().max(1000).optional(),
  dependencies: dependencySchema.optional(), optionalDependencies: dependencySchema.optional(),
}).passthrough()) }).passthrough();
const fail = () => new Error('DESKTOP_NOTICES_INVALID');

/** Collect the locked runtime dependencies, including code bundled into the browser UI.
 * These are installed package documents, not a claim that npm tarballs were reverified. */
export async function collectDesktopNpmNotices(root: string) {
  await assertDesktopProviderDirectory(root);
  const pins: Array<{ path: string; pin: { bytes: number; sha256: string } }> = [];
  const read = async (path: string) => {
    const result = await readDesktopProviderFile(path, 1024 * 1024); pins.push({ path, pin: result.pin }); return result.data;
  };
  const json = (bytes: Buffer) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const app = packageSchema.parse(json(await read(join(root, 'package.json'))));
  const lock = lockSchema.parse(json(await read(join(root, 'package-lock.json'))));
  const dependencies = app.dependencies ?? {};
  if (JSON.stringify(Object.entries(dependencies).sort()) !== JSON.stringify(Object.entries(lock.packages['']?.dependencies ?? {}).sort())) throw fail();
  const selected = new Set<string>(), skipped: string[] = [];
  const locate = (from: string, name: string) => {
    let cursor = resolve(root, from);
    while (cursor === root || cursor.startsWith(root + sep)) {
      const path = relative(root, join(cursor, 'node_modules', name)).replaceAll('\\', '/');
      if (Object.hasOwn(lock.packages, path)) return path;
      if (cursor === root) break; cursor = dirname(cursor);
    }
    return undefined;
  };
  const visit = async (path: string | undefined, optional = false, name = '') => {
    if (!path) { if (optional) { skipped.push(name); return; } throw fail(); }
    if (selected.has(path)) return;
    const spec = lock.packages[path];
    if (!spec || spec.dev || !/^(?:node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+\/)*node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(path)) throw fail();
    try { await assertDesktopProviderDirectory(join(root, path)); }
    catch (error) {
      // Only a genuinely absent optional package may be omitted. Redirected/invalid roots fail.
      try { await lstat(join(root, path)); } catch (missing) {
        if (optional && (missing as NodeJS.ErrnoException).code === 'ENOENT') { skipped.push(name); return; }
      }
      throw error;
    }
    selected.add(path);
    for (const dependency of new Set([...Object.keys(spec.dependencies ?? {}), ...Object.keys(spec.optionalDependencies ?? {})])) {
      await visit(locate(path, dependency), Object.hasOwn(spec.optionalDependencies ?? {}, dependency), dependency);
    }
  };
  for (const name of Object.keys(dependencies).sort()) await visit(locate('', name), false, name);
  const components: DesktopNoticeComponent[] = []; let bytes = 0, entries = 0;
  for (const path of [...selected].sort()) {
    const metadata = packageSchema.parse(json(await read(join(root, path, 'package.json'))));
    const expectedName = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (metadata.name !== expectedName || metadata.version !== lock.packages[path].version) throw fail();
    const component: DesktopNoticeComponent = { id: `npm:${path}`, name: metadata.name, version: metadata.version,
      ecosystem: 'npm', license: metadata.license ?? null, source: `package-lock.json v3; ${lock.packages[path].integrity ?? 'integrity unavailable'}`,
      files: [], issues: [] };
    const walk = async (directory: string, depth: number, attributionDirectory = false) => {
      if (depth > 15) throw fail(); await assertDesktopProviderDirectory(directory);
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > 250_000) throw fail();
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const file = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw fail();
        const noticeName = /^(?:licen[cs]es?|copying|notices?|copyrights?|authors?|unlicense)(?:[._ -].*)?$/i.test(entry.name);
        if (entry.isDirectory()) { await walk(file, depth + 1, attributionDirectory || noticeName); continue; }
        if (!attributionDirectory && !noticeName) continue;
        if (!entry.isFile()) throw fail();
        const data = await read(file); new TextDecoder('utf-8', { fatal: true }).decode(data);
        bytes += data.length; if (bytes > maximumTotal) throw fail();
        if (!data.length) component.issues.push('An attribution document is empty');
        component.files.push({ path: relative(join(root, path), file).replaceAll('\\', '/'), data });
      }
    };
    await walk(join(root, path), 0);
    if (!component.license) component.issues.push('Package license metadata is missing');
    if (!component.files.length) component.issues.push('No license or attribution document is present in the installed package');
    if (!lock.packages[path].integrity) component.issues.push('Package lock integrity is missing');
    components.push(component);
  }
  const assertUnchanged = async () => { for (const item of pins) await verifyPinnedDesktopPayloadFile(item.path, item.pin); };
  await assertUnchanged();
  return { components, skippedOptionalDependencies: [...new Set(skipped)].sort(), packageLockSha256: pins[1].pin.sha256,
    issues: ['Installed package document hashes are recorded; npm tarball contents and bundled native/WASM transitive notices require separate provenance checks'], assertUnchanged };
}

export async function inspectDesktopNodeNotices(executable: string, root: string) {
  const binary = await inspectDesktopFile(executable, 512 * 1024 * 1024);
  if (binary.sha256 !== nodeSource.executable.sha256) throw new Error('DESKTOP_NODE_SOURCE_MISMATCH');
  const directory = join(root, 'desktop/providers/node/24.11.1');
  const license = await readDesktopProviderFile(join(directory, nodeSource.license.file), 1024 * 1024);
  // Validate the exact snapshot that will be published, not only a later reopening.
  if (license.pin.bytes !== nodeSource.license.bytes || license.pin.sha256 !== nodeSource.license.sha256) {
    throw new Error('DESKTOP_NODE_SOURCE_MISMATCH');
  }
  await verifyPinnedDesktopFile(join(directory, nodeSource.license.file), nodeSource.license);
  await verifyPinnedDesktopFile(join(directory, nodeSource.checksums.file), nodeSource.checksums);
  const component: DesktopNoticeComponent = { id: 'node:24.11.1:win-x64', name: 'Node.js', version: nodeSource.version,
    ecosystem: 'runtime', license: 'Node.js LICENSE including bundled third-party notices', source: nodeSource.license.url,
    files: [{ path: 'LICENSE', data: license.data }], issues: [] };
  return { binary, component, source: structuredClone(nodeSource), async assertUnchanged() {
    await verifyPinnedDesktopFile(executable, binary, { windowsX64Executable: true });
    await verifyPinnedDesktopFile(join(directory, nodeSource.license.file), nodeSource.license);
    await verifyPinnedDesktopFile(join(directory, nodeSource.checksums.file), nodeSource.checksums);
  } };
}

/** Writes original documents and a machine-readable inventory into a new directory only.
 * Missing notices remain visible; collection never grants distribution approval. */
export async function writeDesktopNotices(directory: string, components: DesktopNoticeComponent[], issues: string[]) {
  const ids = new Set<string>(); let total = 0;
  const sections = ['THIRD-PARTY NOTICES', 'Original dependency documents follow. This file does not change the product license.', ''];
  const inventory = components.map(component => {
    if (!component.id || ids.has(component.id)) throw fail(); ids.add(component.id);
    const names = new Set<string>();
    const files = component.files.map(file => {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.data);
      total += file.data.length; if (total > maximumTotal) throw fail();
      if (!file.path || file.path.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(file.path)
        || file.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(file.path.toLowerCase())) throw fail();
      names.add(file.path.toLowerCase());
      sections.push(`===== ${component.name} ${component.version} / ${file.path} =====`, text, '');
      return { path: file.path, bytes: file.data.length, sha256: hash(file.data) };
    });
    const { files: _files, ...metadata } = component; return { ...metadata, files };
  });
  const report = { version: 1, distributionReady: false, components: inventory, issues,
    documentsComplete: !issues.length && inventory.every(component => component.files.length
      && component.files.every(file => file.bytes > 0) && !component.issues.length) };
  const files = { 'THIRD-PARTY-NOTICES.txt': Buffer.from(sections.join('\n')),
    'inventory.json': Buffer.from(JSON.stringify(report, null, 2) + '\n') };
  await assertDesktopProviderDirectory(dirname(directory)); await mkdir(directory);
  for (const [name, data] of Object.entries(files)) await writeFile(join(directory, name), data, { flag: 'wx' });
  return { components: inventory.length, documentsComplete: report.documentsComplete,
    files: Object.entries(files).map(([path, data]) => ({ path, bytes: data.length, sha256: hash(data) })) };
}
