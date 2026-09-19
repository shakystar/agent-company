import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readlink, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { workspacePath, workspaceMarker, rootDirectory, checkedPath, safeLink } from './workspace.mjs';

const chunkBytes = 64 * 1024, maxFileBytes = 16 * 1024 * 1024, maxEntries = 100_000;
const maxVolumeBytes = 10 * 1024 ** 3;
const runtimeRoots = new Set(['.codex', '.agent-runtime', '.agent-workspace.pending', workspaceMarker]);

function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('/') || value.includes('\\')
    || /[\x00-\x1f\x7f:]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('백업 상대 경로가 올바르지 않습니다.');
  const parts = value.split('/');
  // Credentials live in a separate tmpfs. Never archive any known credential path,
  // nor arbitrary runtime files: only the session tree is needed for continuation.
  if (parts.some(p => ['auth.json', 'credentials.json', '.env'].includes(p)) || parts[0] === '.codex'
    || parts[0] === '.agent-workspace.pending' || parts[0] === workspaceMarker
    || (parts[0] === '.agent-runtime' && parts.length > 1 && parts[1] !== 'sessions')) throw new Error('인증 또는 비보존 실행 경로입니다.');
  return value;
}

function preservePath(path) { try { safeArchivePath(path); return true; } catch { return false; } }
function limit(value = maxVolumeBytes) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxVolumeBytes) throw new Error('볼륨 전송 한도가 올바르지 않습니다.');
  return value;
}
async function* walk(root, folder = '', depth = 0, all = false) {
  if (depth > 128) throw new Error('디렉터리 깊이 한도를 초과했습니다.');
  const names = await readdir(join(root, folder));
  if (names.length > maxEntries) throw new Error('디렉터리 항목 한도를 초과했습니다.');
  for (const name of names.sort()) {
    const path = folder ? `${folder}/${name}` : name;
    if (!all && !preservePath(path)) continue;
    let stat;
    try { stat = await lstat(join(root, path)); }
    catch (error) { if (all && error.code === 'ENOENT') continue; throw error; }
    const entry = { path, mode: stat.mode & 0o777, size: stat.size, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsupported' };
    yield entry;
    if (entry.type === 'directory') yield* walk(root, path, depth + 1, all);
  }
}

export async function measureWorkspace(root) {
  root = await rootDirectory(root);
  let bytes = 0, files = 0;
  for await (const entry of walk(root, '', 0, true)) {
    if (++files > maxEntries) throw new Error('용량 측정 항목 한도를 초과했습니다.');
    if (entry.type !== 'directory') bytes += entry.size;
    if (!Number.isSafeInteger(bytes)) throw new Error('용량 측정값이 올바르지 않습니다.');
  }
  return { bytes, files };
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!bytesWritten) throw new Error('파일 쓰기가 진행되지 않습니다.');
    offset += bytesWritten;
  }
}

async function readControlFile(root, name) {
  let handle;
  try { handle = await open(join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('작업공간 표식이 올바르지 않습니다.');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
function readyMarker(raw, runId) {
  try {
    const marker = JSON.parse(raw);
    return marker?.version === 1 && marker.state === 'ready' && marker.runId === runId
      && (marker.sourceRunId === null || (typeof marker.sourceRunId === 'string' && /^[a-zA-Z0-9-]{1,60}$/.test(marker.sourceRunId))) ? marker : null;
  } catch { return null; }
}

/** JSONL records carry at most one 64KiB chunk; no file or volume is buffered. */
export async function* archiveWorkspace(root, maxBytes = maxVolumeBytes, expectedRunId) {
  root = await rootDirectory(root); limit(maxBytes);
  if (!/^[a-zA-Z0-9-]{1,60}$/.test(expectedRunId)) throw new Error('백업 실행 식별자가 올바르지 않습니다.');
  const rawMarker = await readControlFile(root, workspaceMarker), rawPending = await readControlFile(root, '.agent-workspace.pending');
  const marker = readyMarker(rawMarker, expectedRunId);
  yield `${JSON.stringify({ type: 'header', format: 'agent-company-workspace', version: 1, runId: expectedRunId, marker, rawMarker, rawPending })}\n`;
  let files = 0, contentBytes = 0;
  for await (const entry of walk(root)) {
    if (++files > maxEntries) throw new Error('백업 항목 한도를 초과했습니다.');
    if (entry.type === 'unsupported') throw new Error('특수 파일은 백업하지 않습니다.');
    if (entry.type === 'symlink') {
      if (runtimeRoots.has(entry.path.split('/')[0])) throw new Error('실행 내부 링크를 백업하지 않습니다.');
      entry.link = await readlink(join(root, entry.path));
      await safeLink(root, entry.path, entry.link);
      const destination = resolve(dirname(join(root, entry.path)), entry.link).slice(root.length + 1).replaceAll('\\', '/');
      safeArchivePath(destination);
    }
    if (entry.type === 'file') {
      contentBytes += entry.size;
      if (contentBytes > maxBytes) throw new Error('백업 원본 용량 한도를 초과했습니다.');
    }
    yield `${JSON.stringify({ ...entry, type: 'entry', kind: entry.type })}\n`;
    if (entry.type !== 'file') continue;
    const handle = await open(join(root, entry.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== entry.size) throw new Error('백업 중 원본 파일이 변경됐습니다.');
      const buffer = Buffer.alloc(chunkBytes), hash = createHash('sha256');
      let bytes = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > entry.size) throw new Error('백업 중 원본 파일이 변경됐습니다.');
        hash.update(buffer.subarray(0, bytesRead));
        yield `${JSON.stringify({ type: 'chunk', data: buffer.subarray(0, bytesRead).toString('base64') })}\n`;
      }
      if (bytes !== entry.size) throw new Error('백업 중 원본 파일이 변경됐습니다.');
      yield `${JSON.stringify({ type: 'file-end', sha256: hash.digest('hex') })}\n`;
    } finally { await handle.close(); }
  }
  yield `${JSON.stringify({ type: 'end', files, contentBytes })}\n`;
}

async function* lines(stream) {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    pending += decoder.write(Buffer.from(chunk));
    for (let index; (index = pending.indexOf('\n')) >= 0;) {
      if (index > 128 * 1024) throw new Error('백업 레코드 한도를 초과했습니다.');
      yield JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
    }
    if (Buffer.byteLength(pending) > 128 * 1024) throw new Error('백업 레코드 한도를 초과했습니다.');
  }
  if (pending + decoder.end()) throw new Error('완료되지 않은 백업 레코드입니다.');
}

async function safeParent(root, path, create = false) {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('파일 상위 경로가 실제 디렉터리가 아닙니다.');
  }
  return join(root, path);
}

export async function restoreWorkspace(root, stream, runId, maxBytes = maxVolumeBytes) {
  root = await rootDirectory(root); limit(maxBytes);
  if (!/^[a-zA-Z0-9-]{1,60}$/.test(runId) || (await readdir(root)).length) throw new Error('복원 대상은 새 작업공간이어야 합니다.');
  let header, ended = false, files = 0, contentBytes = 0, current;
  const directories = [];
  // A failed transfer intentionally leaves an unready new volume; no prior state is touched.
  const pending = await open(join(root, '.agent-workspace.pending'), 'wx', 0o600);
  await pending.close();
  try {
    for await (const record of lines(stream)) {
      if (ended) throw new Error('백업 종료 뒤 데이터가 있습니다.');
      if (!header) {
        if (record.type !== 'header' || record.format !== 'agent-company-workspace' || record.version !== 1 || record.runId !== runId
          || [record.rawMarker, record.rawPending].some(value => value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 4096))) throw new Error('백업 형식 또는 실행 식별자가 올바르지 않습니다.');
        header = record; continue;
      }
      if (current) {
        if (record.type === 'chunk') {
          if (typeof record.data !== 'string' || record.data.length > Math.ceil(chunkBytes / 3) * 4) throw new Error('백업 청크 한도를 초과했습니다.');
          const buffer = Buffer.from(record.data, 'base64');
          if (buffer.toString('base64') !== record.data || !buffer.length || buffer.length > chunkBytes) throw new Error('백업 청크가 올바르지 않습니다.');
          current.bytes += buffer.length;
          if (current.bytes > current.size) throw new Error('백업 파일 길이가 일치하지 않습니다.');
          current.hash.update(buffer); await writeAll(current.handle, buffer); continue;
        }
        if (record.type !== 'file-end' || current.bytes !== current.size || record.sha256 !== current.hash.digest('hex')) throw new Error('백업 파일 무결성 검증에 실패했습니다.');
        await current.handle.chmod(current.mode); await current.handle.sync(); await current.handle.close(); current = undefined; continue;
      }
      if (record.type === 'end') {
        if (record.files !== files || record.contentBytes !== contentBytes) throw new Error('백업 전체 길이가 일치하지 않습니다.');
        ended = true; continue;
      }
      if (record.type !== 'entry' || !['file', 'directory', 'symlink'].includes(record.kind)
        || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777 || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error('백업 항목이 올바르지 않습니다.');
      safeArchivePath(record.path);
      if (++files > maxEntries || record.path.split('/').length > 129) throw new Error('복원 항목 한도를 초과했습니다.');
      while (directories.length && !join(root, record.path).startsWith(`${directories.at(-1).path}${sep}`)) {
        const directory = directories.pop(); await chmod(directory.path, directory.mode);
      }
      const path = await safeParent(root, record.path);
      if (record.kind === 'directory') { await mkdir(path, { mode: 0o700 }); directories.push({ path, mode: record.mode }); }
      else if (record.kind === 'symlink') {
        if (runtimeRoots.has(record.path.split('/')[0]) || typeof record.link !== 'string') throw new Error('실행 내부 링크를 복원하지 않습니다.');
        await safeLink(root, record.path, record.link);
        safeArchivePath(resolve(dirname(path), record.link).slice(root.length + 1).replaceAll('\\', '/'));
        await symlink(record.link, path);
      } else {
        contentBytes += record.size;
        if (contentBytes > maxBytes) throw new Error('복원 용량 한도를 초과했습니다.');
        current = { handle: await open(path, 'wx', 0o600), bytes: 0, size: record.size, mode: record.mode, hash: createHash('sha256') };
      }
    }
    if (!ended || current) throw new Error('완료되지 않은 백업입니다.');
    for (const directory of directories.toReversed()) await chmod(directory.path, directory.mode);
    const originalMarker = readyMarker(header.rawMarker, runId), ready = Boolean(originalMarker);
    const result = { version: 1, state: ready ? 'ready' : 'incomplete', ready, runId, sourceRunId: originalMarker?.sourceRunId ?? null, files, bytes: contentBytes, reused: false };
    if (header.rawMarker !== null) {
      const marker = await open(join(root, workspaceMarker), 'wx', 0o600);
      try { await marker.writeFile(header.rawMarker); await marker.sync(); } finally { await marker.close(); }
    }
    const pending = await open(join(root, '.agent-workspace.pending'), 'w', 0o600);
    try { await pending.writeFile(header.rawPending ?? JSON.stringify({ state: 'incomplete', runId })); await pending.sync(); } finally { await pending.close(); }
    if (ready && header.rawPending === null) await unlink(join(root, '.agent-workspace.pending'));
    return result;
  } finally { await current?.handle.close(); }
}

export async function writeWorkspaceFiles(root, files) {
  root = await rootDirectory(root);
  if (!Array.isArray(files) || !files.length || files.length > 1000) throw new Error('반입 파일 수가 올바르지 않습니다.');
  let bytes = 0;
  const names = new Set(), folders = new Map();
  for (const file of files) {
    workspacePath(file.path, false);
    if (names.has(file.path) || typeof file.contentBase64 !== 'string' || file.contentBase64.length > Math.ceil(maxFileBytes / 3) * 4) throw new Error('반입 파일이 중복되거나 한도를 초과했습니다.');
    names.add(file.path);
    let parent = '';
    for (const part of file.path.split('/')) {
      const normalized = part.normalize('NFC').toLowerCase();
      const siblings = folders.get(parent) ?? new Map();
      if (siblings.has(normalized) && siblings.get(normalized) !== part) throw new Error('반입 경로의 대소문자 또는 유니코드 이름이 충돌합니다.');
      siblings.set(normalized, part); folders.set(parent, siblings);
      parent = parent ? `${parent}/${normalized}` : normalized;
    }
    const buffer = Buffer.from(file.contentBase64, 'base64'); bytes += buffer.length;
    if (buffer.toString('base64') !== file.contentBase64 || bytes > maxFileBytes) throw new Error('반입 파일은 합계 16MiB 이하여야 합니다.');
  }
  for (const file of files) {
    let parent = root;
    for (const part of file.path.split('/')) {
      try {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('반입 상위 경로가 실제 디렉터리가 아닙니다.');
        const conflict = (await readdir(parent)).find(name => name.normalize('NFC').toLowerCase() === part.normalize('NFC').toLowerCase() && name !== part);
        if (conflict) throw new Error('기존 폴더의 대소문자 또는 유니코드 이름과 충돌합니다.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      parent = join(parent, part);
    }
    const path = await safeParent(root, file.path, true);
    // Import never replaces an inherited file without a distinct user-selected path.
    const handle = await open(path, 'wx', 0o600);
    try { await writeAll(handle, Buffer.from(file.contentBase64, 'base64')); await handle.sync(); } finally { await handle.close(); }
  }
  return { files: files.length, bytes };
}

export async function downloadWorkspace(root, path, maxBytes = maxFileBytes) {
  root = await rootDirectory(root);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxFileBytes) throw new Error('파일 다운로드 한도는 16MiB입니다.');
  const handle = await open(await checkedPath(root, path, false), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('파일 다운로드 한도를 초과하거나 일반 파일이 아닙니다.');
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) { const read = await handle.read(buffer, bytes, buffer.length - bytes, null); if (!read.bytesRead) break; bytes += read.bytesRead; }
    if (bytes !== stat.size) throw new Error('다운로드 중 파일이 변경됐습니다.');
    return { path, bytes, contentBase64: buffer.subarray(0, bytes).toString('base64') };
  } finally { await handle.close(); }
}

async function requestAndBody(input) {
  const iterator = input[Symbol.asyncIterator]();
  const parts = [];
  let length = 0;
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('스토리지 명령 입력이 없습니다.');
    const buffer = Buffer.from(next.value), index = buffer.indexOf(10);
    if (index >= 0) {
      if (length + index > 24 * 1024 * 1024) throw new Error('스토리지 명령 입력 한도를 초과했습니다.');
      parts.push(buffer.subarray(0, index));
      const request = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const rest = buffer.subarray(index + 1);
      return { request, body: (async function* () { if (rest.length) yield rest; for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value; } })() };
    }
    parts.push(buffer); length += buffer.length;
    if (length > 24 * 1024 * 1024) throw new Error('스토리지 명령 입력 한도를 초과했습니다.');
  }
}

async function main() {
  const { request, body } = await requestAndBody(process.stdin);
  let result;
  if (request.operation === 'measure') result = await measureWorkspace('/workspace');
  else if (request.operation === 'download') result = await downloadWorkspace('/workspace', request.path, request.maxBytes);
  else if (request.operation === 'write') result = await writeWorkspaceFiles('/workspace', request.files);
  else if (request.operation === 'export') {
    let summary;
    const records = (async function* () { for await (const line of archiveWorkspace('/workspace', request.maxBytes, request.runId)) { if (line.startsWith('{"type":"end"')) summary = JSON.parse(line); yield line; } })();
    await pipeline(Readable.from(records), createGzip(), process.stdout);
    process.stderr.write(`${JSON.stringify(summary)}\n`); return;
  } else if (request.operation === 'import') {
    const decompressed = Readable.from(body).pipe(createGunzip());
    try { result = await restoreWorkspace('/workspace', decompressed, request.runId, request.maxBytes); }
    finally { decompressed.destroy(); }
  } else throw new Error('지원하지 않는 스토리지 명령입니다.');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timeout = setTimeout(() => { process.stderr.write('스토리지 명령 제한 시간을 초과했습니다.\n'); process.exit(1); }, 1_800_000);
  timeout.unref();
  main().catch(error => { process.stderr.write(`${String(error.message).slice(0, 1000)}\n`); process.exitCode = 1; });
}
