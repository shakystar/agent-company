import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_FILES = 1000;
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const forbidden = /^(?:agents\.md|auth\.json|credentials?(?:\.json)?|secrets?|cookies?\.json|sessions?\.json|id_rsa|id_ed25519|node_modules)$/i;
const fail = message => { throw new Error(`Browser workspace preview: ${message}`); };

function pathParts(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512 || /[\\:\u0000-\u001f\u007f%?#<>"|*]/.test(path)
    || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(path)) fail('invalid relative path.');
  const parts = path.split('/');
  if (parts.length > 64 || parts.some(part => !part || part.startsWith('.') || forbidden.test(part) || part.trim() !== part
    || part.endsWith('.') || part.endsWith(' '))) fail('hidden, reserved, or traversal paths are not permitted.');
  return parts;
}

const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function directory(path) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) fail('links and non-directory parents are not permitted.');
  const handle = await open(path, noFollow | (constants.O_DIRECTORY ?? 0));
  try {
    const after = await handle.stat();
    if (!after.isDirectory() || !sameFile(before, after)) fail('directory changed while opening.');
    return { handle, path, identity: after };
  } catch (error) { await handle.close(); throw error; }
}

async function directoryPath(parent) {
  // Linux worker reads stay anchored to opened directory descriptors even if a
  // sibling command renames a directory or substitutes a symlink during capture.
  if (process.platform === 'linux') return `/proc/self/fd/${parent.handle.fd}`;
  const current = await lstat(parent.path);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(current, parent.identity)) fail('directory changed during capture.');
  return parent.path;
}

/** Captures only a bounded static tree from this worker's own workspace. */
export async function collectWorkspacePreview(source, { workspaceRoot = '/workspace', signal } = {}) {
  if (!source || source.kind !== 'workspace' || Object.keys(source).some(key => !['kind', 'path'].includes(key))) fail('invalid source.');
  const parts = pathParts(source.path);
  const rootPath = resolve(workspaceRoot);
  const root = await directory(rootPath);
  const opened = [root];
  const files = [], normalized = new Set();
  let bytes = 0, entries = 0;
  const check = () => signal?.throwIfAborted();
  try {
    check();
    // The production root is the container mount /workspace, never a caller path.
    if (await realpath(rootPath) !== rootPath) fail('workspace root must not contain links.');
    let selected = root;
    for (const part of parts) {
      check();
      selected = await directory(join(await directoryPath(selected), part));
      opened.push(selected);
    }
    async function walk(parent, prefix = '') {
      check();
      const reader = await opendir(await directoryPath(parent));
      for await (const entry of reader) {
        check();
        if (++entries > MAX_ENTRIES) fail('directory entry count limit exceeded.');
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        pathParts(path);
        const key = path.normalize('NFC').toLowerCase();
        if (normalized.has(key)) fail('duplicate normalized paths are not permitted.');
        normalized.add(key);
        const target = join(await directoryPath(parent), entry.name);
        const before = await lstat(target);
        if (before.isSymbolicLink()) fail('symbolic links are not permitted.');
        if (before.isDirectory()) {
          const child = await directory(target);
          try { await walk(child, path); } finally { await child.handle.close(); }
          continue;
        }
        if (!before.isFile() || before.nlink !== 1) fail('only single-link regular files are permitted.');
        if (files.length >= MAX_FILES || before.size > MAX_FILE_BYTES || bytes + before.size > MAX_TOTAL_BYTES) fail('file count or byte limit exceeded.');
        const handle = await open(target, noFollow);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || !sameFile(stat, before) || stat.size !== before.size) fail('file changed while opening.');
          const buffer = Buffer.alloc(stat.size + 1);
          let length = 0;
          while (length < buffer.length) {
            check();
            const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          const after = await handle.stat();
          if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
            || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) fail('file changed during capture.');
          check();
          bytes += length;
          files.push({ path, contentBase64: buffer.subarray(0, length).toString('base64') });
        } finally { await handle.close(); }
      }
    }
    await walk(selected);
    check();
    if (!files.length) fail('source contains no regular files.');
    return { source: { kind: 'workspace', path: source.path }, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  } finally {
    for (const item of opened.reverse()) await item.handle.close();
  }
}
