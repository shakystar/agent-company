import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { Command, CommandOptions, CommandResult } from './process.ts';

export interface WorkspaceRuntimeConfig {
  mode: 'docker' | 'kubernetes';
  image: string;
  workspaceKey?: string;
  persistentWorkspaces?: boolean;
}
export interface WorkspaceEntry { name: string; path: string; type: 'file' | 'directory' | 'symlink' | 'unsupported'; size: number }
export interface WorkspaceListing { path: string; entries: WorkspaceEntry[]; truncated: boolean }
export interface WorkspaceText { path: string; text: string; bytes: number }
export interface WorkspacePrepared { version: 1; state: 'ready'; runId: string; sourceRunId: string | null; files: number; bytes: number; reused: boolean }
export interface WorkspaceVolume { runId: string; bytes: number; files: number }
export interface WorkspaceArchive { bytes: number; sha256: string; files: number; contentBytes: number }
export interface WorkspaceArchivePin { bytes: number; sha256: string }
export interface WorkspaceRestored { version: 1; state: 'ready' | 'incomplete'; ready: boolean; runId: string; sourceRunId: string | null; files: number; bytes: number; reused: boolean }
export interface WorkspaceFileInput { path: string; contentBase64: string }
export interface WorkspaceBinary extends WorkspaceFileInput { bytes: number }
const volumeLimit = 10 * 1024 ** 3;
const fileLimit = 16 * 1024 ** 2;

const excluded = new Set(['.agent', '.agents', '.agent-runtime', '.codex', 'AGENTS.md', '.agent-workspace.json', '.agent-workspace.pending']);
const nonnegative = z.number().int().nonnegative();
const preparedSchema = z.object({ version: z.literal(1), state: z.literal('ready'), runId: z.string(), sourceRunId: z.string().nullable(), files: nonnegative, bytes: nonnegative, reused: z.boolean() });
const restoredSchema = preparedSchema.extend({ state: z.enum(['ready', 'incomplete']), ready: z.boolean() }).refine(value => value.ready === (value.state === 'ready'));
const listingSchema = z.object({ path: z.string(), entries: z.array(z.object({ name: z.string(), path: z.string(), type: z.enum(['file', 'directory', 'symlink', 'unsupported']), size: nonnegative })).max(1000), truncated: z.boolean() });
const textSchema = z.object({ path: z.string(), text: z.string().max(1024 * 1024), bytes: nonnegative.max(1024 * 1024) });
const measureSchema = z.object({ bytes: nonnegative.safe(), files: nonnegative.max(100_000) });
const binarySchema = z.object({ path: z.string(), bytes: nonnegative.max(fileLimit), contentBase64: z.string().max(Math.ceil(fileLimit / 3) * 4) });
// Storage monitoring uses forked runtimes and fresh DockerWorkspaces instances.
// Coordinate every workspace helper by generation: inventory mounts must finish
// cleanup before idle checks, and removal must not race a listed volume's mount.
const inventoryOperations = new Map<string, Promise<void>>();

export function validateWorkspacePath(path: string, allowRoot = true): string {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\\') || /[\x00-\x1f\x7f:]/.test(path)
    || path.startsWith('/') || (!allowRoot && !path) || path.split('/').some(part => part === '.' || part === '..' || (!part && path))) throw new Error('작업공간 상대 경로가 올바르지 않습니다.');
  if (excluded.has(path.split('/')[0])) throw new Error('실행 내부 파일은 조회하거나 계승할 수 없습니다.');
  return path;
}

/** The caller supplies only DB-authorized run IDs, never user-supplied volume names.
 * Source runs must be settled before invoking this class. Every helper also checks
 * active mounts, owns a unique name, and is cleaned up independently of CLI exit. */
export class DockerWorkspaces {
  constructor(
    private readonly config: WorkspaceRuntimeConfig,
    private readonly command: Command,
    private readonly volumeFor: (runId: string) => string,
    private readonly onCleanupFailure?: (name: string) => void,
  ) {}

  private volume(runId: string) {
    if (this.config.mode !== 'docker' || !this.config.workspaceKey || !this.config.persistentWorkspaces) throw new Error('Docker 영속 작업공간 설정이 필요합니다.');
    if (!/^[a-zA-Z0-9-]{1,60}$/.test(runId)) throw new Error('잘못된 실행 ID입니다.');
    const volume = this.volumeFor(runId);
    if (!/^ac-[a-f0-9]{16}-[a-f0-9]{24}$/.test(volume)) throw new Error('플랫폼 소유 named volume만 사용할 수 있습니다.');
    return volume;
  }

  private async owned(runId: string, allowMissing = false): Promise<boolean> {
    const volume = this.volume(runId);
    const inspected = await this.command('docker', ['volume', 'inspect', volume, '--format', '{{json .Labels}}'], { timeoutMs: 30_000 });
    if (inspected.code !== 0) {
      if (allowMissing && /(?:no such volume|not found)/i.test(inspected.stderr)) return false;
      throw new Error(`작업공간 볼륨을 확인하지 못했습니다: ${runId}`);
    }
    let labels: Record<string, string>;
    try { labels = JSON.parse(inspected.stdout); } catch { throw new Error('작업공간 소유권 응답이 올바르지 않습니다.'); }
    if (!labels || labels.app !== 'agent-company' || labels['agent-company.workspace'] !== this.config.workspaceKey || labels['agent-company.run'] !== runId) {
      throw new Error('작업공간 볼륨 소유권이 일치하지 않습니다.');
    }
    return true;
  }

  private async idle(runId: string) {
    const active = await this.command('docker', ['ps', '-q', '--filter', `volume=${this.volume(runId)}`], { timeoutMs: 30_000 });
    if (active.code !== 0) throw new Error('작업공간 사용 상태를 확인하지 못했습니다.');
    if (active.stdout.trim()) throw new Error('실행 중인 작업공간은 계승하거나 조회할 수 없습니다. 종료 후 다시 확인할 수 있습니다.');
  }

  withInventoryLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.volume('probe');
    signal?.throwIfAborted();
    const key = this.config.workspaceKey!;
    let entered = false;
    const pending = (inventoryOperations.get(key) ?? Promise.resolve()).then(() => {
      signal?.throwIfAborted();
      entered = true;
      return operation();
    });
    const settled = pending.then(() => undefined, () => undefined);
    inventoryOperations.set(key, settled);
    const completed = pending.finally(() => { if (inventoryOperations.get(key) === settled) inventoryOperations.delete(key); });
    if (!signal) return completed;
    return new Promise<T>((resolve, reject) => {
      // A cancelled queued caller can leave promptly, but its place in the tail
      // still waits for prior helpers. Entered operations own their cleanup and
      // must settle before releasing either the caller or the next operation.
      const aborted = () => { if (!entered) reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      completed.then(value => {
        signal.removeEventListener('abort', aborted); resolve(value);
      }, error => {
        signal.removeEventListener('abort', aborted); reject(error);
      });
    });
  }

  async prepare(runId: string, sourceRunId: string | null = null, signal?: AbortSignal, temporaryFor?: string): Promise<WorkspacePrepared> {
    return this.withInventoryLock(() => this.prepareLocked(runId, sourceRunId, signal, temporaryFor));
  }

  // The caller holds the generation lock, including when importFiles prepares
  // and writes a new workspace as one operation. Never reacquire it here.
  private async prepareLocked(runId: string, sourceRunId: string | null, signal?: AbortSignal, temporaryFor?: string): Promise<WorkspacePrepared> {
    signal?.throwIfAborted();
    const volume = this.volume(runId);
    if (sourceRunId === runId) throw new Error('동일한 실행을 계승 원본으로 사용할 수 없습니다.');
    if (temporaryFor && (!/^[a-zA-Z0-9-]{1,60}$/.test(temporaryFor) || temporaryFor === runId)) throw new Error('임시 비교 작업공간의 소유 실행이 올바르지 않습니다.');
    if (sourceRunId) { await this.owned(sourceRunId); await this.idle(sourceRunId); }
    const exists = await this.owned(runId, true);
    if (temporaryFor && exists) throw new Error('임시 비교는 새 작업공간에만 가능합니다. 기존 볼륨을 보존했습니다.');
    if (!exists) {
      const created = await this.command('docker', ['volume', 'create', '--label', 'app=agent-company', '--label', `agent-company.workspace=${this.config.workspaceKey}`,
        '--label', `agent-company.run=${runId}`, ...(temporaryFor ? ['--label', 'agent-company.workspace-role=trial', '--label', `agent-company.temporary-for=${temporaryFor}`] : []), volume], { timeoutMs: 30_000, signal });
      if (created.code !== 0) throw new Error('영속 작업공간을 준비하지 못했습니다.');
      await this.owned(runId);
    }
    await this.idle(runId);
    const result = preparedSchema.parse(await this.helper(runId, { operation: 'prepare', runId, sourceRunId }, false, sourceRunId, signal));
    if (result.runId !== runId || result.sourceRunId !== sourceRunId) throw new Error('작업공간 준비 결과가 실행 정보와 일치하지 않습니다.');
    return result;
  }

  async list(runId: string, path = ''): Promise<WorkspaceListing> {
    return this.withInventoryLock(() => this.listLocked(runId, path));
  }

  private async listLocked(runId: string, path: string): Promise<WorkspaceListing> {
    validateWorkspacePath(path);
    await this.owned(runId);
    await this.idle(runId);
    const result = listingSchema.parse(await this.helper(runId, { operation: 'list', path }, true));
    if (result.path !== path) throw new Error('작업공간 목록 응답 경로가 일치하지 않습니다.');
    for (const entry of result.entries) validateWorkspacePath(entry.path, false);
    return result;
  }

  async read(runId: string, path: string, maxBytes = 256 * 1024): Promise<WorkspaceText> {
    return this.withInventoryLock(() => this.readLocked(runId, path, maxBytes));
  }

  private async readLocked(runId: string, path: string, maxBytes: number): Promise<WorkspaceText> {
    validateWorkspacePath(path, false);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('텍스트 조회 한도는 1MiB 이하여야 합니다.');
    await this.owned(runId);
    await this.idle(runId);
    const result = textSchema.parse(await this.helper(runId, { operation: 'read', path, maxBytes }, true));
    if (result.path !== path || result.bytes > maxBytes || Buffer.byteLength(result.text, 'utf8') !== result.bytes) throw new Error('작업공간 파일 응답이 올바르지 않습니다.');
    return result;
  }

  async volumes(signal?: AbortSignal): Promise<WorkspaceVolume[]> {
    return this.withInventoryLock(() => this.measureVolumes(signal), signal);
  }

  private async measureVolumes(parentSignal?: AbortSignal): Promise<WorkspaceVolume[]> {
    this.volume('probe');
    const timeout = AbortSignal.timeout(120_000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    signal.throwIfAborted();
    const result = await this.command('docker', ['volume', 'ls', '-q', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${this.config.workspaceKey}`], { timeoutMs: 30_000, signal });
    signal.throwIfAborted();
    if (result.code !== 0) throw new Error('작업공간 볼륨 목록을 확인하지 못했습니다.');
    const volumes = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (volumes.length > 10_000) throw new Error('작업공간 볼륨 수 한도를 초과했습니다.');
    if (new Set(volumes).size !== volumes.length || volumes.some(name => !/^ac-[a-f0-9]{16}-[a-f0-9]{24}$/.test(name))) throw new Error('소유 볼륨 이름이 중복되거나 올바르지 않습니다.');
    const values: WorkspaceVolume[] = [];
    for (let offset = 0; offset < volumes.length; offset += 64) {
      signal.throwIfAborted();
      const metadata = await this.inspectInventoryVolumes(volumes.slice(offset, offset + 64), signal);
      for (const { runId } of metadata) {
        signal.throwIfAborted();
        // Measurement remains sequential and never follows links. Batching only
        // removes repeated host-to-Docker metadata round trips, not file checks.
        const measured = measureSchema.parse(await this.storageJson(runId, { operation: 'measure' }, true, 120_000, signal));
        values.push({ runId, ...measured });
      }
    }
    return values;
  }

  private async inspectInventoryVolumes(names: string[], signal: AbortSignal): Promise<Array<{ name: string; runId: string }>> {
    signal.throwIfAborted();
    const inspected = await this.command('docker', ['volume', 'inspect', ...names, '--format', '{{json .}}'], { timeoutMs: 30_000, signal });
    signal.throwIfAborted();
    const found = new Map<string, { name: string; runId: string }>();
    const expected = new Set(names);
    for (const line of inspected.stdout.trim().split('\n').filter(line => line.trim())) {
      const item = z.object({ Name: z.string(), Labels: z.record(z.string(), z.string()) }).parse(JSON.parse(line));
      const name = item.Name, labels = item.Labels, runId = labels['agent-company.run'];
      if (!expected.has(name) || found.has(name)) throw new Error('작업공간 메타데이터에 알 수 없거나 중복된 볼륨이 있습니다.');
      if (typeof runId !== 'string' || this.volume(runId) !== name) throw new Error('작업공간 볼륨 식별자가 일치하지 않습니다.');
      if (labels.app !== 'agent-company' || labels['agent-company.workspace'] !== this.config.workspaceKey) throw new Error('작업공간 볼륨 소유권이 일치하지 않습니다.');
      found.set(name, { name, runId });
    }
    if (inspected.code === 0) {
      if (found.size !== names.length) throw new Error('작업공간 메타데이터에서 요청한 볼륨이 누락됐습니다.');
      return names.map(name => found.get(name)!);
    }
    // Docker may return partial output if a volume disappeared after listing.
    // Revalidate each requested name, rather than treating every missing row or
    // an unrelated daemon error as an absent owned volume.
    if (names.length > 1 && /no such volume/i.test(inspected.stderr)) {
      const revalidated: Array<{ name: string; runId: string }> = [];
      for (const name of names) revalidated.push(...await this.inspectInventoryVolumes([name], signal));
      return revalidated;
    }
    if (names.length === 1 && !found.size && new RegExp(`^(?:Error(?: response from daemon)?:\\s*)?(?:No such volume(?::\\s*${names[0]})?|(?:get\\s+)?${names[0]}:\\s*no such volume)$`, 'i').test(inspected.stderr.trim())) return [];
    throw new Error(`작업공간 소유권을 확인하지 못했습니다: ${names.join(', ')}. ${inspected.stderr.slice(-500)}`);
  }

  async export(runId: string, archivePath: string, maxBytes = volumeLimit, signal?: AbortSignal): Promise<WorkspaceArchive> {
    return this.withInventoryLock(() => this.exportLocked(runId, archivePath, maxBytes, signal));
  }

  private async exportLocked(runId: string, archivePath: string, maxBytes: number, signal?: AbortSignal): Promise<WorkspaceArchive> {
    signal?.throwIfAborted();
    this.archivePath(archivePath, maxBytes);
    await this.owned(runId); await this.idle(runId);
    const target = await open(archivePath, 'wx', 0o600);
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      const result = await this.storageCommand(runId, true, {
        input: `${JSON.stringify({ operation: 'export', runId, maxBytes })}\n`, captureStdout: false, signal, timeoutMs: 1_810_000,
        onStdout: async chunk => {
          bytes += chunk.length;
          // Compressed data can have slight overhead, but cannot consume unbounded space.
          if (bytes > maxBytes + Math.ceil(maxBytes / 100) + 1024 * 1024) throw new Error('백업 출력 용량 한도를 초과했습니다.');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset, null);
            if (!bytesWritten) throw new Error('백업 파일 쓰기가 진행되지 않습니다.');
            offset += bytesWritten;
          }
        },
      });
      const summary = z.object({ type: z.literal('end'), files: nonnegative.max(100_000), contentBytes: nonnegative.max(maxBytes) }).parse(JSON.parse(result.stderr.trim().split('\n').at(-1)!));
      await target.sync();
      return { bytes, sha256: hash.digest('hex'), files: summary.files, contentBytes: summary.contentBytes };
    } finally { await target.close(); }
  }

  async import(runId: string, archivePath: string, maxBytes = volumeLimit, signal?: AbortSignal, expectedArchive?: WorkspaceArchivePin): Promise<WorkspaceRestored> {
    const pin = expectedArchive === undefined ? undefined : z.object({ bytes: nonnegative.safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(expectedArchive);
    return this.withInventoryLock(() => this.importLocked(runId, archivePath, maxBytes, signal, pin));
  }

  private async importLocked(runId: string, archivePath: string, maxBytes: number, signal?: AbortSignal, expectedArchive?: WorkspaceArchivePin): Promise<WorkspaceRestored> {
    signal?.throwIfAborted();
    this.archivePath(archivePath, maxBytes);
    const archive = await lstat(archivePath);
    if (!archive.isFile() || archive.isSymbolicLink() || archive.nlink !== 1 || archive.size > maxBytes + Math.ceil(maxBytes / 100) + 1024 * 1024
      || expectedArchive && archive.size !== expectedArchive.bytes) throw new Error('복원 아카이브 파일이 올바르지 않습니다.');
    if (await this.owned(runId, true)) throw new Error('복원은 새 작업공간에만 가능합니다. 기존 볼륨을 보존했습니다.');
    await this.createVolume(runId, signal);
    const archiveHandle = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stream = archiveHandle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
    const hash = createHash('sha256'); let bytes = 0, consumed = false;
    const invalidPin = () => new Error('복원에 전달된 아카이브가 승인된 길이·해시와 일치하지 않습니다.');
    try {
      const opened = await archiveHandle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== archive.dev || opened.ino !== archive.ino
        || opened.size !== archive.size) throw invalidPin();
      const result = await this.storageCommand(runId, false, {
        inputStream: (async function* () {
          yield `${JSON.stringify({ operation: 'import', runId, maxBytes })}\n`;
          // Keep the final bounded chunk until the pin is known. Hash precisely the
          // archive bytes yielded to stdin, excluding the separate request header.
          let tail: Buffer | undefined;
          for await (const chunk of stream) {
            signal?.throwIfAborted();
            if (tail) {
              if (expectedArchive && bytes + tail.length > expectedArchive.bytes) throw invalidPin();
              bytes += tail.length; hash.update(tail); yield tail;
            }
            tail = Buffer.from(chunk);
          }
          if (expectedArchive && (bytes + (tail?.length ?? 0) !== expectedArchive.bytes
            || hash.copy().update(tail ?? Buffer.alloc(0)).digest('hex') !== expectedArchive.sha256)) throw invalidPin();
          if (tail) { bytes += tail.length; hash.update(tail); yield tail; }
          consumed = true;
        })(),
        timeoutMs: 1_810_000, signal,
      });
      // An early process result is not proof that the generator reached EOF.
      // storageCommand has already completed its owned-container cleanup here.
      if (expectedArchive && (!consumed || bytes !== expectedArchive.bytes || hash.digest('hex') !== expectedArchive.sha256)) throw invalidPin();
      const prepared = restoredSchema.parse(JSON.parse(result.stdout));
      if (prepared.runId !== runId || prepared.reused || prepared.bytes > maxBytes) throw new Error('복원 결과의 실행 식별자가 일치하지 않습니다.');
      return prepared;
    } finally { stream.destroy(); await archiveHandle.close(); }
  }

  async importFiles(runId: string, sourceRunId: string | null, files: WorkspaceFileInput[], signal?: AbortSignal): Promise<WorkspacePrepared> {
    return this.withInventoryLock(() => this.importFilesLocked(runId, sourceRunId, files, signal));
  }

  private async importFilesLocked(runId: string, sourceRunId: string | null, files: WorkspaceFileInput[], signal?: AbortSignal): Promise<WorkspacePrepared> {
    signal?.throwIfAborted();
    if (!Array.isArray(files) || !files.length || files.length > 1000) throw new Error('반입 파일 수가 올바르지 않습니다.');
    let bytes = 0;
    const paths = new Set<string>();
    const folders = new Map<string, Map<string, string>>();
    for (const file of files) {
      validateWorkspacePath(file.path, false);
      if (paths.has(file.path) || typeof file.contentBase64 !== 'string' || file.contentBase64.length > Math.ceil(fileLimit / 3) * 4) throw new Error('반입 파일이 중복되거나 한도를 초과했습니다.');
      paths.add(file.path);
      let parent = '';
      for (const part of file.path.split('/')) {
        const normalized = part.normalize('NFC').toLowerCase(), siblings = folders.get(parent) ?? new Map<string, string>();
        if (siblings.has(normalized) && siblings.get(normalized) !== part) throw new Error('반입 경로의 대소문자 또는 유니코드 이름이 충돌합니다.');
        siblings.set(normalized, part); folders.set(parent, siblings);
        parent = parent ? `${parent}/${normalized}` : normalized;
      }
      const decoded = Buffer.from(file.contentBase64, 'base64'); bytes += decoded.length;
      if (decoded.toString('base64') !== file.contentBase64 || bytes > fileLimit) throw new Error('반입 파일은 합계 16MiB 이하여야 합니다.');
    }
    if (await this.owned(runId, true)) throw new Error('파일 반입은 새 작업공간에만 가능합니다.');
    const prepared = await this.prepareLocked(runId, sourceRunId, signal);
    await this.idle(runId);
    const written = measureSchema.parse(await this.storageJson(runId, { operation: 'write', files }, false, 310_000, signal));
    if (written.bytes !== bytes || written.files !== files.length) throw new Error('반입 결과 길이가 일치하지 않습니다.');
    return { ...prepared, files: prepared.files + written.files, bytes: prepared.bytes + written.bytes };
  }

  async download(runId: string, path: string, maxBytes = fileLimit): Promise<WorkspaceBinary> {
    return this.withInventoryLock(() => this.downloadLocked(runId, path, maxBytes));
  }

  private async downloadLocked(runId: string, path: string, maxBytes: number): Promise<WorkspaceBinary> {
    validateWorkspacePath(path, false);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > fileLimit) throw new Error('파일 다운로드 한도는 16MiB입니다.');
    await this.owned(runId); await this.idle(runId);
    const result = binarySchema.parse(await this.storageJson(runId, { operation: 'download', path, maxBytes }, true));
    const decoded = Buffer.from(result.contentBase64, 'base64');
    if (result.path !== path || result.bytes !== decoded.length || result.bytes > maxBytes || decoded.toString('base64') !== result.contentBase64) throw new Error('다운로드 파일 길이가 일치하지 않습니다.');
    return result;
  }

  /** Only for a failed newly staged import; callers must never pass a published version. */
  async remove(runId: string): Promise<void> {
    await this.withInventoryLock(async () => {
      if (!await this.owned(runId, true)) return;
      await this.idle(runId);
      const result = await this.command('docker', ['volume', 'rm', this.volume(runId)], { timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error('실패한 임시 작업공간을 정리하지 못했습니다.');
    });
  }

  /** Control-plane startup only: ordinary Run volumes never have the explicit trial role. */
  async recoverTemporaryTrials(): Promise<void> {
    if (this.config.mode !== 'docker' || !this.config.workspaceKey || !this.config.persistentWorkspaces) return;
    const listed = await this.command('docker', ['volume', 'ls', '-q', '--filter', 'label=app=agent-company',
      '--filter', `label=agent-company.workspace=${this.config.workspaceKey}`, '--filter', 'label=agent-company.workspace-role=trial'], { timeoutMs: 30_000 });
    if (listed.code !== 0) throw new Error('이전 임시 비교 작업공간 목록을 확인하지 못했습니다.');
    const names = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (names.length > 10_000) throw new Error('임시 비교 작업공간 목록이 한도를 초과했습니다.');
    for (const name of names) {
      if (!/^ac-[a-f0-9]{16}-[a-f0-9]{24}$/.test(name)) throw new Error('임시 비교 작업공간 식별자가 올바르지 않습니다.');
      const inspected = await this.command('docker', ['volume', 'inspect', name, '--format', '{{json .Labels}}'], { timeoutMs: 30_000 });
      if (inspected.code !== 0) throw new Error('임시 비교 작업공간 소유권을 확인하지 못했습니다.');
      const labels = z.record(z.string(), z.string()).parse(JSON.parse(inspected.stdout));
      const runId = labels['agent-company.run'], parent = labels['agent-company.temporary-for'];
      if (labels.app !== 'agent-company' || labels['agent-company.workspace'] !== this.config.workspaceKey
        || labels['agent-company.workspace-role'] !== 'trial' || !parent || !/^[a-zA-Z0-9-]{1,60}$/.test(parent)
        || parent === runId || !runId || this.volume(runId) !== name) throw new Error('임시 비교 작업공간 소유권이 일치하지 않습니다.');
      // remove repeats ownership and idle checks, and never forces a mounted-volume removal.
      await this.remove(runId);
    }
  }

  private archivePath(path: string, maxBytes: number) {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('명시적인 아카이브 절대 경로가 필요합니다.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > volumeLimit) throw new Error('볼륨 전송 한도가 올바르지 않습니다.');
  }

  private async createVolume(runId: string, signal?: AbortSignal) {
    const created = await this.command('docker', ['volume', 'create', '--label', 'app=agent-company', '--label', `agent-company.workspace=${this.config.workspaceKey}`,
      '--label', `agent-company.run=${runId}`, this.volume(runId)], { timeoutMs: 30_000, signal });
    if (created.code !== 0) throw new Error('새 작업공간을 생성하지 못했습니다.');
    await this.owned(runId); await this.idle(runId);
  }

  private async storageJson(runId: string, request: object, readonly: boolean, timeoutMs = 30_000, signal?: AbortSignal) {
    let output = '';
    const decoder = new StringDecoder('utf8');
    await this.storageCommand(runId, readonly, {
      input: `${JSON.stringify(request)}\n`, signal, timeoutMs, captureStdout: false,
      onStdout: chunk => { output += decoder.write(chunk); if (Buffer.byteLength(output) > 24 * 1024 * 1024) throw new Error('스토리지 응답 한도를 초과했습니다.'); },
    });
    return JSON.parse(output + decoder.end());
  }

  private async storageCommand(runId: string, readonly: boolean, options: CommandOptions): Promise<CommandResult> {
    const name = `ac-ws-${randomUUID()}`;
    const args = ['run', '--rm', '-i', '--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${this.config.workspaceKey}`,
      '--label', `agent-company.run=${runId}`, '--label', 'agent-company.helper=storage',
      '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--memory=256m', '--cpus=0.5', '--pids-limit=32',
      '--mount', `type=volume,source=${this.volume(runId)},target=/workspace${readonly ? ',readonly,volume-nocopy' : ''}`,
      '--entrypoint=node', this.config.image, '/app/storage.mjs'];
    let result: CommandResult | undefined, failure: unknown;
    try {
      result = await this.command('docker', args, options);
      if (result.code !== 0) throw new Error(`스토리지 명령에 실패했습니다: ${result.stderr.slice(-1000)}`);
    } catch (error) { failure = error; }
    try {
      const cleanup = await this.command('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
      if (cleanup.code !== 0 && !/No such container/i.test(cleanup.stderr)) throw new Error('storage helper cleanup failed');
    } catch {
      this.onCleanupFailure?.(name);
      throw new Error(`작업공간 보조 컨테이너 종료를 확인하지 못했습니다: ${name}`);
    }
    if (failure) throw failure;
    options.signal?.throwIfAborted();
    return result!;
  }

  private async helper(runId: string, request: object, readonly: boolean, sourceRunId: string | null = null, signal?: AbortSignal) {
    const name = `ac-ws-${randomUUID()}`;
    const args = ['run', '--rm', '-i', '--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${this.config.workspaceKey}`,
      '--label', `agent-company.run=${runId}`, '--label', 'agent-company.helper=workspace',
      '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--memory=256m', '--cpus=0.5', '--pids-limit=32',
      '--mount', `type=volume,source=${this.volume(runId)},target=/workspace${readonly ? ',readonly,volume-nocopy' : ''}`,
      ...(sourceRunId ? ['--mount', `type=volume,source=${this.volume(sourceRunId)},target=/source,readonly,volume-nocopy`] : []),
      '--entrypoint=node', this.config.image, '/app/workspace.mjs'];
    let result: unknown;
    let failure: unknown;
    try {
      const completed = await this.command('docker', args, { input: JSON.stringify(request), timeoutMs: readonly ? 30_000 : 310_000, signal });
      if (completed.code !== 0) throw new Error(`작업공간 명령이 실패했습니다: ${completed.stderr.slice(-1000)}`);
      try { result = JSON.parse(completed.stdout); } catch { throw new Error('작업공간 명령 응답이 올바르지 않습니다.'); }
    } catch (error) { failure = error; }
    try {
      const cleanup = await this.command('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
      if (cleanup.code !== 0 && !/No such container/i.test(cleanup.stderr)) throw new Error('workspace helper cleanup failed');
    } catch {
      this.onCleanupFailure?.(name);
      throw new Error(`작업공간 보조 컨테이너 종료를 확인하지 못했습니다: ${name}`);
    }
    if (failure) throw failure;
    signal?.throwIfAborted();
    return result;
  }
}
