import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';

/** Test double only: real DB/files/backups, simulated Docker volumes, no model call. */
export class StorageFixtureRuntime implements RuntimeDriver {
  readonly workspacePersistence = true;
  readonly calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; finish: () => void }>;
  constructor(readonly key: string, readonly spaces = new Map<string, Map<string, Record<string, string>>>(), calls?: StorageFixtureRuntime['calls']) {
    this.calls = calls ?? []; if (!spaces.has(key)) spaces.set(key, new Map());
  }
  forkWorkspace(key: string) { return new StorageFixtureRuntime(key, this.spaces, this.calls); }
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', available: true, authenticated: true, image: 'storage-fixture-no-model', model: 'fixture', version: 'test', message: '검증 전용 실행기이며 실제 모델을 호출하지 않습니다.' }; }
  async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const own = this.spaces.get(this.key)!;
    own.set(input.run.id, structuredClone(own.get(input.run.workspaceSourceRunId ?? '') ?? {}));
    return new Promise((resolve, reject) => {
      hooks.signal.addEventListener('abort', () => reject(new Error('test interrupted')), { once: true });
      this.calls.push({ input, hooks, finish: () => resolve({ result: 'fixture complete', memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0 }) });
    });
  }
  async canResume() { return true; }
  async listWorkspaceVolumes() {
    return [...this.spaces.get(this.key)!].map(([runId, files]) => ({ runId, files: Object.keys(files).length, bytes: Object.values(files).reduce((sum, value) => sum + Buffer.from(value, 'base64').length, 0) }));
  }
  async importWorkspaceFiles(runId: string, sourceRunId: string | null, files: Array<{ path: string; contentBase64: string }>) {
    const volumes = this.spaces.get(this.key)!;
    if (volumes.has(runId)) throw new Error('existing volume');
    const result = structuredClone(sourceRunId ? volumes.get(sourceRunId)! : {});
    if (!result) throw new Error('missing source');
    for (const file of files) { if (Object.keys(result).some(path => path.normalize('NFC').toLowerCase() === file.path.normalize('NFC').toLowerCase())) throw new Error('같은 경로의 파일'); result[file.path] = file.contentBase64; }
    volumes.set(runId, result); return {};
  }
  async removeWorkspaceVolume(runId: string) { this.spaces.get(this.key)!.delete(runId); }
  async downloadWorkspaceFile(runId: string, path: string) {
    const contentBase64 = this.spaces.get(this.key)!.get(runId)?.[path];
    if (contentBase64 === undefined) throw new Error('missing file');
    return { path, contentBase64, bytes: Buffer.from(contentBase64, 'base64').length };
  }
  async readWorkspace(runId: string, path: string) {
    const value = await this.downloadWorkspaceFile(runId, path); return { path, bytes: value.bytes, text: Buffer.from(value.contentBase64, 'base64').toString('utf8') };
  }
  async listWorkspace(runId: string, path = '') {
    const entries = new Map<string, { name: string; path: string; size: number; type: 'file' | 'directory' }>();
    for (const [file, base64] of Object.entries(this.spaces.get(this.key)!.get(runId) ?? {})) {
      if (path && !file.startsWith(`${path}/`)) continue;
      const remaining = path ? file.slice(path.length + 1) : file; const name = remaining.split('/')[0];
      entries.set(name, { name, path: path ? `${path}/${name}` : name, size: Buffer.from(base64, 'base64').length, type: remaining.includes('/') ? 'directory' : 'file' });
    }
    return { path, entries: [...entries.values()], truncated: false };
  }
  async exportWorkspace(runId: string, archivePath: string) {
    const files = this.spaces.get(this.key)!.get(runId); if (!files) throw new Error('missing volume');
    const bytes = Buffer.from(JSON.stringify(files)); await writeFile(archivePath, bytes, { flag: 'wx' });
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files: Object.keys(files).length, contentBytes: Object.values(files).reduce((sum, value) => sum + Buffer.from(value, 'base64').length, 0) };
  }
  async importWorkspace(runId: string, archivePath: string, _maxBytes?: number, _signal?: AbortSignal, expectedArchive?: { bytes: number; sha256: string }) {
    if (this.spaces.get(this.key)!.has(runId)) throw new Error('existing volume');
    const bytes = await readFile(archivePath);
    if (expectedArchive && (bytes.length !== expectedArchive.bytes || createHash('sha256').update(bytes).digest('hex') !== expectedArchive.sha256)) throw new Error('archive pin mismatch');
    this.spaces.get(this.key)!.set(runId, JSON.parse(bytes.toString('utf8'))); return {};
  }
}
