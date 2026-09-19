import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertDesktopProviderDirectory, readDesktopProviderFile } from './desktop-provider-files.ts';
import { desktopRuntimeSelectionSchema, type DesktopRuntimeSelection } from './desktop-runtime-settings.ts';

const name = 'desktop-image-install.pending.json';
const maximumBytes = 16 * 1024;
const ownerSchema = z.uuid();
const documentSchema = z.object({
  version: z.literal(1), ownerKey: ownerSchema, selection: desktopRuntimeSelectionSchema,
  images: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1).max(2)
    .refine(images => new Set(images).size === images.length),
}).strict();
type Document = z.infer<typeof documentSchema>;
type Directory = { path: string; stat: BigIntStats };
type Snapshot = { stat: BigIntStats; data: Buffer; fingerprint: string };
type Code = 'DESKTOP_IMAGE_JOURNAL_INVALID' | 'DESKTOP_IMAGE_JOURNAL_CHANGED'
  | 'DESKTOP_IMAGE_JOURNAL_EXISTS' | 'DESKTOP_IMAGE_JOURNAL_WRITE_FAILED';

export class DesktopImageJournalError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'DesktopImageJournalError'; }
}
const invalid = () => new DesktopImageJournalError('DESKTOP_IMAGE_JOURNAL_INVALID');
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stable = (a: BigIntStats, b: BigIntStats) => identity(a, b) && b.isFile() && !b.isSymbolicLink()
  && b.nlink === 1n && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

export interface DesktopImageJournalReceipt {
  readonly selection: Readonly<DesktopRuntimeSelection>;
  readonly images: readonly string[];
  /** SHA-256 of the full stored bytes, including whitespace; suitable for a diagnostic CAS. */
  readonly fingerprint: string;
  assertUnchanged(): Promise<void>;
  clear(): Promise<void>;
}

async function directories(root: string): Promise<Directory[]> {
  // Reuse the provider's local path restrictions, including Windows ADS/reserved names.
  await assertDesktopProviderDirectory(root);
  const entries: Directory[] = []; let cursor = parse(resolve(root)).root;
  for (const part of ['', ...relative(cursor, resolve(root)).split(/[\\/]/).filter(Boolean)]) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw invalid();
    entries.push({ path: cursor, stat });
  }
  await recheckDirectories(entries); return entries;
}
async function recheckDirectories(entries: Directory[]): Promise<void> {
  for (const entry of entries) {
    const stat = await lstat(entry.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !identity(entry.stat, stat)
      || relative(entry.path, await realpath(entry.path))) throw invalid();
  }
}
async function snapshot(path: string, parents: Directory[], expected?: Snapshot): Promise<Snapshot> {
  await recheckDirectories(parents);
  const stat = await lstat(path, { bigint: true });
  if (expected && !stable(expected.stat, stat)) throw invalid();
  const { data, pin } = await readDesktopProviderFile(path, maximumBytes);
  if (!stable(stat, await lstat(path, { bigint: true })) || expected && pin.sha256 !== expected.fingerprint) throw invalid();
  await recheckDirectories(parents);
  return { stat, data, fingerprint: pin.sha256 };
}

/** Small, strict JSON reader: reject duplicate decoded keys and excessive nesting before schema validation. */
function parseDocument(bytes: Buffer): unknown {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0, nodes = 0;
  const white = () => { while (at < source.length && /[\t\r\n ]/.test(source[at])) at++; };
  const string = (): string => {
    const start = at++;
    if (source[start] !== '"') throw invalid();
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at));
    }
    throw invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 8 || ++nodes > 64) throw invalid();
    white();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; white(); const result: Record<string, unknown> = Object.create(null);
      if (source[at] === '}') { at++; return result; }
      while (true) {
        white(); const key = string(); if (Object.hasOwn(result, key)) throw invalid(); white();
        if (source[at++] !== ':') throw invalid();
        result[key] = value(depth + 1); white();
        if (source[at] === '}') { at++; return result; }
        if (source[at++] !== ',') throw invalid();
      }
    }
    if (source[at] === '[') {
      at++; white(); const result: unknown[] = [];
      if (source[at] === ']') { at++; return result; }
      while (true) {
        result.push(value(depth + 1)); white();
        if (source[at] === ']') { at++; return result; }
        if (source[at++] !== ',') throw invalid();
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, at)) { at += token.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    if (!number || !Number.isFinite(Number(number[0]))) throw invalid();
    at += number[0].length; return Number(number[0]);
  };
  const result = value(0); white(); if (at !== source.length) throw invalid(); return result;
}

function receipt(path: string, parents: Directory[], initial: Snapshot, document: Document): DesktopImageJournalReceipt {
  let cleared = false;
  // Serializes methods on this receipt; the installation lease serializes separate receipts/processes.
  let tail: Promise<void> = Promise.resolve();
  const operate = (clear: boolean): Promise<void> => {
    const result = tail.then(async () => {
      try {
        if (cleared) throw invalid();
        await snapshot(path, parents, initial);
        if (clear) {
          if (!stable(initial.stat, await lstat(path, { bigint: true }))) throw invalid();
          await unlink(path); cleared = true;
        }
      } catch { throw new DesktopImageJournalError('DESKTOP_IMAGE_JOURNAL_CHANGED'); }
    });
    tail = result.catch(() => {}); return result;
  };
  return Object.freeze({
    selection: Object.freeze({ ...document.selection }), images: Object.freeze([...document.images]),
    fingerprint: initial.fingerprint, assertUnchanged: () => operate(false), clear: () => operate(true),
  });
}

/** Caller must hold the installation lease through diagnosis/retry and any receipt operations. No credentials are stored. */
export async function openDesktopImageJournal(appDataRoot: string, ownerKey: string): Promise<DesktopImageJournalReceipt | null> {
  try {
    ownerSchema.parse(ownerKey);
    const parents = await directories(appDataRoot), path = join(resolve(appDataRoot), name);
    try { await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await recheckDirectories(parents); return null;
    }
    const initial = await snapshot(path, parents), document = documentSchema.parse(parseDocument(initial.data));
    if (document.ownerKey !== ownerKey) throw invalid();
    return receipt(path, parents, initial, document);
  } catch { throw invalid(); }
}

/** Exclusive, synced v1 creation. Failed or incomplete files remain for diagnosis and are never overwritten. */
export async function createDesktopImageJournal(appDataRoot: string, ownerKey: string,
  selection: Readonly<DesktopRuntimeSelection>, images: readonly string[]): Promise<DesktopImageJournalReceipt> {
  let document: Document, parents: Directory[], path: string, data: Buffer;
  try {
    // Validate and clone inputs before the first await so callers cannot change the admitted request.
    document = documentSchema.parse({ version: 1, ownerKey, selection, images });
    data = Buffer.from(JSON.stringify(document)); if (data.length > maximumBytes) throw invalid();
    parents = await directories(appDataRoot); path = join(resolve(appDataRoot), name);
  } catch { throw invalid(); }
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    throw new DesktopImageJournalError((error as NodeJS.ErrnoException).code === 'EEXIST'
      ? 'DESKTOP_IMAGE_JOURNAL_EXISTS' : 'DESKTOP_IMAGE_JOURNAL_WRITE_FAILED');
  }
  try {
    let written: BigIntStats;
    try {
      await handle.writeFile(data); await handle.sync(); written = await handle.stat({ bigint: true });
    } finally { await handle.close(); }
    const expected: Snapshot = { stat: written, data, fingerprint: createHash('sha256').update(data).digest('hex') };
    const initial = await snapshot(path, parents, expected);
    return receipt(path, parents, initial, document);
  } catch { throw new DesktopImageJournalError('DESKTOP_IMAGE_JOURNAL_WRITE_FAILED'); }
}
