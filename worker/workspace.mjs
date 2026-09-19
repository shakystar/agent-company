import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rename, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceMarker = '.agent-workspace.json';
const pendingMarker = '.agent-workspace.pending';
const excludedRoots = new Set(['.agent', '.agents', '.agent-runtime', '.codex', 'AGENTS.md', workspaceMarker, pendingMarker]);
const maxEntries = 100_000;
const maxCopyBytes = 2 * 1024 * 1024 * 1024;
const maxTextBytes = 1024 * 1024;

export function workspacePath(value = '', allowRoot = true) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(value)
    || value.startsWith('/') || (!allowRoot && !value) || value.split('/').some(part => part === '.' || part === '..' || (!part && value))) {
    throw new Error('작업공간 상대 경로가 올바르지 않습니다.');
  }
  if (excludedRoots.has(value.split('/')[0])) throw new Error('실행 내부 파일은 조회하거나 계승할 수 없습니다.');
  return value;
}

function within(root, path) {
  const offset = relative(root, path);
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`));
}

export async function rootDirectory(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('작업공간 루트가 실제 디렉터리가 아닙니다.');
  return realpath(root);
}

export async function checkedPath(root, value, allowRoot = true) {
  workspacePath(value, allowRoot);
  let current = root;
  for (const part of value ? value.split('/') : []) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('심볼릭 링크를 통해 파일을 읽을 수 없습니다.');
  }
  return current;
}

async function boundedText(path, limit) {
  // O_NONBLOCK prevents a replaced FIFO from blocking before the type check.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('일반 파일만 읽을 수 있습니다.');
    if (stat.size > limit) throw new Error(`텍스트 파일 조회 한도 ${limit}바이트를 초과했습니다.`);
    const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit || length > stat.size) throw new Error('파일이 조회 중 변경되거나 조회 한도를 초과했습니다.');
    const content = buffer.subarray(0, length);
    if (content.includes(0)) throw new Error('바이너리 파일의 텍스트 조회는 지원하지 않습니다.');
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), bytes: length };
  } finally { await handle.close(); }
}

export async function listWorkspace(root, value = '', limit = 1000) {
  root = await rootDirectory(root);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('파일 목록 한도가 올바르지 않습니다.');
  const directory = await checkedPath(root, value);
  if (!(await lstat(directory)).isDirectory()) throw new Error('디렉터리만 목록으로 조회할 수 있습니다.');
  const names = (await readdir(directory)).filter(name => value || !excludedRoots.has(name)).sort();
  const entries = [];
  for (const name of names.slice(0, limit)) {
    const path = value ? `${value}/${name}` : name;
    workspacePath(path, false);
    const stat = await lstat(join(directory, name));
    entries.push({ name, path, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsupported', size: stat.size });
  }
  return { path: value, entries, truncated: names.length > limit };
}

export async function readWorkspace(root, value, limit = 256 * 1024) {
  root = await rootDirectory(root);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxTextBytes) throw new Error('텍스트 조회 한도는 1MiB 이하여야 합니다.');
  const path = await checkedPath(root, value, false);
  return { path: value, ...await boundedText(path, limit) };
}

export async function safeLink(root, path, link) {
  if (isAbsolute(link) || link.includes('\\') || /[\x00-\x1f\x7f:]/.test(link)) throw new Error(`외부 심볼릭 링크는 계승하지 않습니다: ${path}`);
  const destination = resolve(root, dirname(path), link);
  if (!within(root, destination)) throw new Error(`작업공간 바깥 심볼릭 링크입니다: ${path}`);
  workspacePath(relative(root, destination).split(sep).join('/'));
  // Resolve existing ancestors too: a dangling link must not hide an escaping chain.
  let ancestor = destination;
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      if (!within(root, resolved)) throw new Error(`작업공간 바깥 심볼릭 링크입니다: ${path}`);
      workspacePath(relative(root, resolved).split(sep).join('/'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (ancestor === root) throw error;
      ancestor = dirname(ancestor);
    }
  }
}

async function inventory(root) {
  const entries = [];
  let bytes = 0;
  async function visit(folder = '', depth = 0) {
    if (depth > 128) throw new Error('작업공간 디렉터리 깊이 한도를 초과했습니다.');
    for (const name of (await readdir(join(root, folder))).sort()) {
      if (!folder && excludedRoots.has(name)) continue;
      const path = folder ? `${folder}/${name}` : name;
      workspacePath(path, false);
      const stat = await lstat(join(root, path));
      const entry = { path, mode: stat.mode & 0o777, size: stat.size, type: '' };
      if (stat.isSymbolicLink()) {
        entry.type = 'symlink';
        entry.link = await readlink(join(root, path));
        await safeLink(root, path, entry.link);
      } else if (stat.isDirectory()) entry.type = 'directory';
      else if (stat.isFile()) { entry.type = 'file'; bytes += stat.size; }
      else throw new Error(`특수 파일은 계승하지 않습니다: ${path}`);
      entries.push(entry);
      if (entries.length > maxEntries || bytes > maxCopyBytes) throw new Error('작업공간 계승 한도 100000항목·2GiB를 초과했습니다.');
      if (entry.type === 'directory') await visit(path, depth + 1);
    }
  }
  await visit();
  return { entries, bytes };
}

async function copyRegular(source, target, entry) {
  const input = await open(join(source, entry.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let output;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size !== entry.size) throw new Error('계승 원본이 복사 중 변경됐습니다.');
    output = await open(join(target, entry.path), 'wx', 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > entry.size) throw new Error('계승 원본이 복사 중 변경됐습니다.');
      let written = 0;
      while (written < read.bytesRead) written += (await output.write(buffer, written, read.bytesRead - written, null)).bytesWritten;
    }
    if (bytes !== entry.size) throw new Error('계승 원본이 복사 중 변경됐습니다.');
    await output.chmod(entry.mode);
    await output.sync();
  } finally { await input.close(); await output?.close(); }
}

export async function prepareWorkspace(target, source, identity) {
  if (!identity || typeof identity.runId !== 'string' || !/^[a-zA-Z0-9-]{1,60}$/.test(identity.runId)
    || (identity.sourceRunId !== null && (typeof identity.sourceRunId !== 'string' || !/^[a-zA-Z0-9-]{1,60}$/.test(identity.sourceRunId)))
    || identity.sourceRunId === identity.runId || Boolean(source) !== Boolean(identity.sourceRunId)) throw new Error('작업공간 계승 식별자가 올바르지 않습니다.');
  target = await rootDirectory(target);
  const expected = { version: 1, runId: identity.runId, sourceRunId: identity.sourceRunId };
  try {
    const markerPath = join(target, workspaceMarker);
    if ((await lstat(markerPath)).isSymbolicLink()) throw new Error('작업공간 초기화 표식이 올바르지 않습니다.');
    const marker = JSON.parse((await boundedText(markerPath, 4096)).text);
    if (marker.version !== 1 || marker.runId !== expected.runId || marker.sourceRunId !== expected.sourceRunId || marker.state !== 'ready') {
      throw new Error('작업공간 초기화 표식이 실행 정보와 일치하지 않습니다.');
    }
    return { ...marker, reused: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ((await readdir(target)).length) throw new Error('초기화가 끝나지 않았거나 기존 파일이 있는 작업공간입니다. 원본을 보존하고 자동 덮어쓰기를 중단했습니다.');
  if (source) {
    source = await rootDirectory(source);
    if (source === target || within(source, target) || within(target, source)) throw new Error('원본과 대상 작업공간은 분리돼야 합니다.');
  }
  const items = source ? await inventory(source) : { entries: [], bytes: 0 };
  const pending = await open(join(target, pendingMarker), 'wx', 0o600);
  try {
    await pending.writeFile(JSON.stringify({ ...expected, state: 'copying' }));
    await pending.sync();
  } finally { await pending.close(); }
  for (const entry of items.entries) {
    if (entry.type === 'directory') await mkdir(join(target, entry.path), { mode: 0o700 });
    else if (entry.type === 'file') await copyRegular(source, target, entry);
    else await symlink(entry.link, join(target, entry.path));
  }
  for (const entry of items.entries.toReversed()) {
    if (entry.type === 'directory') await chmod(join(target, entry.path), entry.mode);
  }
  const result = { ...expected, state: 'ready', files: items.entries.length, bytes: items.bytes };
  const ready = await open(join(target, pendingMarker), 'w', 0o600);
  try { await ready.writeFile(JSON.stringify(result)); await ready.sync(); }
  finally { await ready.close(); }
  await rename(join(target, pendingMarker), join(target, workspaceMarker));
  return { ...result, reused: false };
}

async function main() {
  let serialized = '';
  for await (const chunk of process.stdin) {
    serialized += chunk;
    if (Buffer.byteLength(serialized) > 16 * 1024) throw new Error('작업공간 명령 입력 한도를 초과했습니다.');
  }
  const request = JSON.parse(serialized);
  let result;
  if (request.operation === 'prepare') result = await prepareWorkspace('/workspace', request.sourceRunId ? '/source' : null, request);
  else if (request.operation === 'list') result = await listWorkspace('/workspace', request.path ?? '');
  else if (request.operation === 'read') result = await readWorkspace('/workspace', request.path, request.maxBytes);
  else throw new Error('지원하지 않는 작업공간 명령입니다.');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timeout = setTimeout(() => { process.stderr.write('작업공간 명령 제한 시간을 초과했습니다.\n'); process.exit(1); }, 300_000);
  timeout.unref();
  main().catch(error => { process.stderr.write(`${String(error.message).slice(0, 1000)}\n`); process.exitCode = 1; });
}
