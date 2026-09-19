import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './storage.ts';

export class DesktopRuntimeSettingsError extends Error {
  constructor(readonly code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' | 'DESKTOP_RUNTIME_SETTINGS_STALE' | 'DESKTOP_RUNTIME_SETTINGS_BUSY'
    | 'DESKTOP_RUNTIME_SETTINGS_WRITE_FAILED') { super(code); this.name = 'DesktopRuntimeSettingsError'; }
}
const invalid = () => new DesktopRuntimeSettingsError('DESKTOP_RUNTIME_SETTINGS_INVALID');
const wslPath = z.string().max(4000).refine(value => /^[a-z]:[\\/]/i.test(value) && win32.basename(value).toLowerCase() === 'wsl.exe'
  && !/[\x00-\x1f\x7f]/.test(value) && !value.slice(3).split(/[\\/]/).some(part => part === '.' || part === '..'
    || /[<>:"|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)));
export const desktopRuntimeSelectionSchema = z.object({ kind: z.literal('wsl-docker'), wslExecutable: wslPath,
  distro: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
  model: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:/-]+$/) }).strict();
export type DesktopRuntimeSelection = z.infer<typeof desktopRuntimeSelectionSchema>;
const identitySchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop'), channel: z.literal('beta'), workspaceKey: z.uuid() }).strict();
const legacyDocumentSchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop-runtime'), workspaceKey: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), selection: desktopRuntimeSelectionSchema }).strict();
const documentSchema = z.discriminatedUnion('version', [legacyDocumentSchema, legacyDocumentSchema.extend({ version: z.literal(2) })]);
const configuredSchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop-runtime-configured'), workspaceKey: z.uuid() }).strict();
export interface DesktopRuntimeSettingsSnapshot { revision: number; selection: DesktopRuntimeSelection | null }
const writing = new Set<string>();
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stable = (a: BigIntStats, b: BigIntStats) => same(a, b) && b.isFile() && b.nlink === 1n
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function document(path: string, optional = false): Promise<unknown> {
  let before: BigIntStats;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 16_384n
    || relative(path, await realpath(path))) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const bytes = Buffer.alloc(Number(before.size) + 1);
  try {
    if (!stable(before, await handle.stat({ bigint: true }))) throw invalid();
    let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (BigInt(length) !== before.size || !stable(before, await handle.stat({ bigint: true })) || !stable(before, await lstat(path, { bigint: true }))) throw invalid();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { bytes.fill(0); await handle.close(); }
}

/** Installation lease must be held by the caller, including reads that migrate a legacy v1 document.
 * Both documents are outside workspace backups and contain no credentials. */
export function desktopRuntimeSettings(appDataRoot: string, workspaceKey: string) {
  if (!isAbsolute(appDataRoot) || resolve(appDataRoot) === parse(resolve(appDataRoot)).root || /[\x00-\x1f\x7f]/.test(appDataRoot)
    || appDataRoot.split(/[\\/]/).some(part => part === '.' || part === '..') || !z.uuid().safeParse(workspaceKey).success) throw invalid();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(appDataRoot) || appDataRoot.slice(3).split(/[\\/]/).some(part =>
    /[<>:"|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw invalid();
  const root = resolve(appDataRoot), path = join(root, 'desktop-runtime.json');
  const configuredPath = join(root, 'desktop-runtime-configured.json');
  const lockKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const owned = async () => {
    const directories: Array<{ path: string; stat: BigIntStats }> = [];
    let cursor = parse(root).root;
    for (const part of ['', ...relative(cursor, root).split(/[\\/]/).filter(Boolean)]) {
      cursor = join(cursor, part); const stat = await lstat(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw invalid();
      directories.push({ path: cursor, stat });
    }
    const identity = identitySchema.parse(await document(join(root, 'desktop-installation.json')));
    if (identity.workspaceKey !== workspaceKey) throw invalid();
    return async () => {
      for (const entry of directories) {
        const stat = await lstat(entry.path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !same(entry.stat, stat) || relative(entry.path, await realpath(entry.path))) throw invalid();
      }
      if (identitySchema.parse(await document(join(root, 'desktop-installation.json'))).workspaceKey !== workspaceKey) throw invalid();
    };
  };
  const configured = async (optional = false) => {
    const raw = await document(configuredPath, optional);
    if (raw === undefined) return null;
    const value = configuredSchema.parse(raw);
    if (value.workspaceKey !== workspaceKey) throw invalid();
    return value;
  };
  const load = async () => {
    const recheck = await owned(), marker = await configured(true), raw = await document(path, true);
    const value = raw === undefined ? null : documentSchema.parse(raw);
    if (value && value.workspaceKey !== workspaceKey || marker && !value || value?.version === 2 && !marker) throw invalid();
    if (!marker && !value) {
      // A target leaves this path before it can create a worker. Even an empty,
      // redirected or non-directory remnant rules out a brand-new installation.
      const target = await lstat(join(root, 'runtime')).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (target) throw invalid();
    }
    await recheck();
    return { value, marker, recheck };
  };
  const ensureConfigured = async (exists: boolean, recheck: () => Promise<void>) => {
    await recheck();
    if (!exists) {
      // Exclusive creation never replaces an unexpected marker. A partial write
      // stays present and invalid, so a crash cannot revert to a fresh installation.
      const handle = await open(configuredPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, product: 'agent-company-desktop-runtime-configured', workspaceKey }));
        await handle.sync();
      } finally { await handle.close(); }
    }
    await configured(); await recheck();
  };
  const write = async (value: z.infer<typeof legacyDocumentSchema>, exists: boolean, recheck: () => Promise<void>) => {
    try {
      // Commit the durable configured state before creating/replacing settings.
      await ensureConfigured(exists, recheck);
      await atomicJson(path, { ...value, version: 2 });
      await configured(); await recheck();
    } catch { throw new DesktopRuntimeSettingsError('DESKTOP_RUNTIME_SETTINGS_WRITE_FAILED'); }
  };
  const snapshot = (value: z.infer<typeof documentSchema> | null): DesktopRuntimeSettingsSnapshot => ({
    revision: value?.revision ?? 0, selection: value ? structuredClone(value.selection) : null,
  });
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (writing.has(lockKey)) throw new DesktopRuntimeSettingsError('DESKTOP_RUNTIME_SETTINGS_BUSY');
    writing.add(lockKey);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DesktopRuntimeSettingsError) throw error;
      throw invalid();
    } finally { writing.delete(lockKey); }
  };
  const read = (): Promise<DesktopRuntimeSettingsSnapshot> => exclusive(async () => {
    const current = await load();
    if (current.value?.version !== 1) return snapshot(current.value);
    // A valid legacy selection is retained with the same revision. Marker loss
    // after this migration is distinguishable from an unmigrated v1 document.
    await write(current.value, !!current.marker, current.recheck);
    return snapshot((await load()).value);
  });
  return { read, save(raw: DesktopRuntimeSelection, expectedRevision: number): Promise<DesktopRuntimeSettingsSnapshot> {
    return exclusive(async () => {
      let selection: DesktopRuntimeSelection;
      try { selection = desktopRuntimeSelectionSchema.parse(raw); } catch { throw invalid(); }
      const current = await load();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (current.value?.revision ?? 0) || expectedRevision >= Number.MAX_SAFE_INTEGER) {
        throw new DesktopRuntimeSettingsError('DESKTOP_RUNTIME_SETTINGS_STALE');
      }
      await write({ version: 1, product: 'agent-company-desktop-runtime', workspaceKey,
        revision: expectedRevision + 1, selection }, !!current.marker, current.recheck);
      return snapshot((await load()).value);
    });
  } };
}
