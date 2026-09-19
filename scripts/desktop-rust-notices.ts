import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { assertDesktopProviderDirectory, readDesktopProviderFile } from './desktop-provider-files.ts';

export interface DesktopRustNoticeComponent {
  id: string; name: string; version: string; ecosystem: 'cargo'; license: string | null; source: string;
  files: Array<{ path: string; data: Buffer }>; issues: string[];
}
export interface DesktopRustNotices { components: DesktopRustNoticeComponent[]; issues: string[] }
const FILE_LIMIT = 1024 * 1024, TOTAL_LIMIT = 32 * FILE_LIMIT;
const PACKAGE_LIMIT = 4096, EDGE_LIMIT = 65_536, ENTRY_LIMIT = 200_000, CRATE_ENTRY_LIMIT = 20_000, DEPTH_LIMIT = 24;
const invalid = (code = 'DESKTOP_RUST_NOTICES_METADATA_INVALID') => Object.assign(new Error(code), { code });
const identifier = z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/);
const packageSchema = z.object({ id: identifier, name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  version: z.string().min(1).max(128).regex(/^[a-zA-Z0-9.+-]+$/), source: identifier.nullable(),
  license: z.string().min(1).max(4096).regex(/^[a-zA-Z0-9 .+():/_-]+$/).nullable(),
  license_file: z.string().max(4096).nullable(), manifest_path: z.string().min(1).max(4096) });
const metadataSchema = z.object({ version: z.literal(1), packages: z.array(packageSchema).min(1).max(PACKAGE_LIMIT),
  resolve: z.object({ root: identifier, nodes: z.array(z.object({ id: identifier, dependencies: z.array(identifier).max(PACKAGE_LIMIT),
    deps: z.array(z.object({ name: identifier, pkg: identifier })).max(PACKAGE_LIMIT).optional(),
  })).min(1).max(PACKAGE_LIMIT) }) });
type Package = z.infer<typeof packageSchema>;

// Cargo format 1 may add fields. IDs remain opaque graph keys, never local output paths.
function dependencyClosure(input: unknown): Package[] {
  let parsed: ReturnType<typeof metadataSchema.safeParse>;
  try { parsed = metadataSchema.safeParse(input); } catch { throw invalid(); }
  if (!parsed.success) throw invalid();
  const { packages, resolve: graph } = parsed.data, byId = new Map(packages.map(pkg => [pkg.id, pkg]));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (byId.size !== packages.length || nodes.size !== graph.nodes.length || !byId.has(graph.root) || !nodes.has(graph.root)
    || byId.get(graph.root)!.source !== null) throw invalid();
  let edges = 0;
  for (const node of graph.nodes) {
    if (!byId.has(node.id) || new Set(node.dependencies).size !== node.dependencies.length) throw invalid();
    if ((edges += node.dependencies.length) > EDGE_LIMIT) throw invalid();
    for (const dependency of node.dependencies) if (!byId.has(dependency) || !nodes.has(dependency)) throw invalid();
    if (node.deps) {
      const ids = new Set(node.deps.map(dep => dep.pkg)), aliases = new Set(node.deps.map(dep => `${dep.name}\0${dep.pkg}`));
      if (aliases.size !== node.deps.length || ids.size !== node.dependencies.length || node.dependencies.some(id => !ids.has(id))) throw invalid();
    }
  }
  // Iterative traversal bounds stack usage and permits legitimate resolved graph cycles.
  const reached = new Set<string>(), pending = [graph.root];
  while (pending.length) { const id = pending.pop()!; if (reached.has(id)) continue; reached.add(id); pending.push(...nodes.get(id)!.dependencies); }
  const selected = [...reached].filter(id => id !== graph.root).map(id => byId.get(id)!);
  const identities = new Set<string>();
  for (const pkg of selected) {
    if (!pkg.source || !/^(registry|sparse)\+https:\/\//.test(pkg.source)) throw invalid('DESKTOP_RUST_NOTICES_SOURCE_UNSUPPORTED');
    let source: URL; try { source = new URL(pkg.source.slice(pkg.source.indexOf('+') + 1)); } catch { throw invalid('DESKTOP_RUST_NOTICES_SOURCE_UNSUPPORTED'); }
    if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash
      || /[\\\x00-\x20\x7f]/.test(pkg.source)) throw invalid('DESKTOP_RUST_NOTICES_SOURCE_UNSUPPORTED');
    const identity = `${pkg.source}\0${pkg.name}\0${pkg.version}`;
    if (identities.has(identity)) throw invalid(); identities.add(identity);
  }
  return selected.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en') || a.source!.localeCompare(b.source!, 'en'));
}

const noticeName = /^(?:LICEN[CS]ES?|COPYING|NOTICES?|COPYRIGHTS?|AUTHORS?|UNLICENSE)(?:$|[._ -])/i;
function safeRelative(value: string): string | null {
  if (!value || isAbsolute(value) || win32.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]|[. ]$/.test(part)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) return null;
  return parts.join('/');
}
const sameDirectory = (a: BigIntStats, b: BigIntStats) => b.isDirectory() && !b.isSymbolicLink()
  && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const addIssue = (issues: string[], issue: string) => { if (!issues.includes(issue)) issues.push(issue); };

/** Read-only notice collection. Metadata is not a source archive, lockfile or binary provenance attestation.
 * Structural/graph/aggregate-limit failures throw fixed errors. A crate's unreadable, unsafe or missing
 * notices remain explicit component issues; callers must not treat a partial collection as complete. */
export async function collectDesktopRustNotices(metadata: unknown): Promise<DesktopRustNotices> {
  const packages = dependencyClosure(metadata), components: DesktopRustNoticeComponent[] = [];
  const issues = ['CARGO_SOURCE_AND_LOCK_CHECKSUMS_NOT_VERIFIED', 'CARGO_METADATA_CLOSURE_IS_NOT_A_LINKED_BINARY_INVENTORY'];
  let totalBytes = 0, entriesSeen = 0;
  for (const pkg of packages) {
    const component: DesktopRustNoticeComponent = { id: `cargo:${pkg.name}@${pkg.version}#${createHash('sha256').update(pkg.source!).digest('hex')}`,
      name: pkg.name, version: pkg.version, ecosystem: 'cargo', source: pkg.source!, license: pkg.license, files: [], issues: [] };
    components.push(component);
    if (!pkg.license) addIssue(component.issues, 'LICENSE_EXPRESSION_MISSING');
    const root = dirname(pkg.manifest_path), candidates = new Set<string>(), directories: Array<{ path: string; stat: BigIntStats }> = [];
    try {
      if (!isAbsolute(pkg.manifest_path) || basename(pkg.manifest_path) !== 'Cargo.toml') throw invalid();
      await assertDesktopProviderDirectory(root);
      await readDesktopProviderFile(pkg.manifest_path, FILE_LIMIT);
    } catch { addIssue(component.issues, 'CRATE_MANIFEST_OR_ROOT_UNREADABLE'); addIssue(component.issues, 'NOTICE_FILES_MISSING'); continue; }
    if (pkg.license_file !== null) {
      const licenseFile = safeRelative(pkg.license_file);
      if (!licenseFile) addIssue(component.issues, 'DECLARED_LICENSE_FILE_UNSAFE');
      else candidates.add(licenseFile);
    }
    const pending = [{ path: '', noticeDirectory: false, depth: 0 }]; let crateEntries = 0;
    while (pending.length) {
      const current = pending.pop()!, directory = join(root, current.path);
      if (current.depth > DEPTH_LIMIT) { addIssue(component.issues, 'NOTICE_SCAN_DEPTH_LIMIT'); continue; }
      try {
        await assertDesktopProviderDirectory(directory);
        const before = await lstat(directory, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) throw invalid();
        directories.push({ path: directory, stat: before });
        const iterator = await opendir(directory);
        for await (const entry of iterator) {
          if (++entriesSeen > ENTRY_LIMIT) throw invalid('DESKTOP_RUST_NOTICES_LIMIT');
          if (++crateEntries > CRATE_ENTRY_LIMIT) { addIssue(component.issues, 'NOTICE_SCAN_ENTRY_LIMIT'); pending.length = 0; break; }
          const path = safeRelative(current.path ? `${current.path}/${entry.name}` : entry.name);
          if (!path) { addIssue(component.issues, 'NOTICE_TREE_UNSAFE_ENTRY'); continue; }
          if (entry.isSymbolicLink()) { addIssue(component.issues, 'NOTICE_TREE_LINK_REJECTED'); continue; }
          if (entry.isDirectory()) pending.push({ path, noticeDirectory: current.noticeDirectory || noticeName.test(entry.name), depth: current.depth + 1 });
          else if (current.noticeDirectory || noticeName.test(entry.name)) {
            if (!entry.isFile()) addIssue(component.issues, 'NOTICE_SPECIAL_FILE_REJECTED');
            else candidates.add(path);
          }
        }
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'DESKTOP_RUST_NOTICES_LIMIT') throw error;
        addIssue(component.issues, 'NOTICE_DIRECTORY_UNREADABLE');
      }
    }
    for (const path of [...candidates].sort()) {
      try {
        const file = resolve(root, path); if (relative(root, file).split(/[\\/]/).join('/') !== path) throw invalid();
        const { data } = await readDesktopProviderFile(file, FILE_LIMIT);
        if (!data.length) { addIssue(component.issues, 'NOTICE_FILE_EMPTY'); continue; }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        if (text.includes('\0')) throw invalid();
        if (totalBytes + data.length > TOTAL_LIMIT) throw invalid('DESKTOP_RUST_NOTICES_LIMIT');
        totalBytes += data.length; component.files.push({ path, data });
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'DESKTOP_RUST_NOTICES_LIMIT') throw error;
        addIssue(component.issues, pkg.license_file && safeRelative(pkg.license_file) === path ? 'DECLARED_LICENSE_FILE_UNREADABLE' : 'NOTICE_FILE_UNREADABLE');
      }
    }
    // Detect replaced/changed directories across enumeration and file reads, without accepting a new tree.
    try {
      for (const directory of directories) {
        await assertDesktopProviderDirectory(directory.path);
        if (!sameDirectory(directory.stat, await lstat(directory.path, { bigint: true }))) throw invalid();
      }
    } catch { component.files = []; addIssue(component.issues, 'NOTICE_TREE_CHANGED'); }
    if (!component.files.length) addIssue(component.issues, 'NOTICE_FILES_MISSING');
  }
  return { components, issues };
}
