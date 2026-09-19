import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Command, CommandResult } from './process.ts';
import type { BrowserRequest } from '../shared/browser.ts';
import type { ExecutionInput, ResourceAllocation } from '../shared/types.ts';

/** These limits are a subdivision of the run's existing scheduler lease. */
export function browserResources(total: ResourceAllocation) {
  if (!Number.isSafeInteger(total.memoryMiB) || total.memoryMiB < 1024 || !Number.isFinite(total.cpus) || total.cpus < 1) throw new Error('브라우저 지원 작업에는 최소 1024MiB·1 CPU 예약이 필요합니다.');
  const browser = { memoryMiB: 512, cpus: 0.5 };
  return { browser, worker: { memoryMiB: total.memoryMiB - browser.memoryMiB, cpus: total.cpus - browser.cpus } };
}
export interface BrowserRuntimeConfig { image: string; workspaceKey: string; seccompProfile: string }
function cleanupPending(cause?: unknown) {
  return Object.assign(new Error('브라우저 컨테이너 종료를 확인하지 못했습니다. 자원 예약을 유지합니다.', { cause }),
    { code: 'RUNTIME_CLEANUP_PENDING' });
}
function browserResponse(result: CommandResult): unknown {
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch {
    if (result.code !== 0) throw new Error(`브라우저 작업 실패: ${result.stderr.slice(-1500)}`);
    throw new Error('브라우저 응답이 올바른 JSON이 아닙니다.');
  }
  // The browser CLI writes structured errors to stdout and then exits nonzero.
  // Read those errors before the generic exit-code fallback loses their cause.
  if (value && typeof value === 'object' && 'error' in value) throw new Error(String(value.error).slice(0, 2000));
  if (result.code !== 0) throw new Error(`브라우저 작업 실패: ${result.stderr.slice(-1500)}`);
  return value;
}
export class DockerBrowser {
  private session?: { runId: string; name: string; ready: boolean };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly command: Command, private readonly config: () => Promise<BrowserRuntimeConfig>) {}
  get available() { return !this.session; }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
  }
  async call(input: ExecutionInput, request: BrowserRequest, signal: AbortSignal): Promise<unknown> {
    return this.exclusive(async () => {
      signal.throwIfAborted();
      if (this.session && this.session.runId !== input.run.id) return { browserBusy: true };
      if (request.action === 'close') { await this.closeLocked(input.run.id); return { closed: true }; }
      if (request.action === 'status' && !this.session) return { open: false };
      if (this.session && !this.session.ready) throw cleanupPending();
      if (request.action !== 'open' && !this.session) throw new Error('브라우저 세션이 없습니다. 재개 후에는 browser_open으로 작업물을 다시 엽니다.');
      if (!this.session) {
        const config = await this.config();
        if (!/^sha256:[a-f0-9]{64}$/.test(config.image) || !config.workspaceKey || !config.seccompProfile || config.seccompProfile === 'unconfined') throw new Error('검증된 불변 브라우저 이미지·격리 프로필이 필요합니다.');
        const resources = browserResources(input.resources!).browser;
        const name = `ac-browser-${randomUUID()}`;
        this.session = { runId: input.run.id, name, ready: false };
        try {
          const started = await this.command('docker', ['run', '--detach', '--rm', '--init', '--name', name,
            '--label', 'app=agent-company', '--label', `agent-company.workspace=${config.workspaceKey}`,
            '--label', `agent-company.run=${input.run.id}`, '--label', 'agent-company.helper=browser',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', `--security-opt=seccomp=${config.seccompProfile}`,
            '--user=1000:1000', '--pids-limit=256', `--memory=${resources.memoryMiB}m`, `--cpus=${resources.cpus}`,
            '--network=none', '--shm-size=128m', '--tmpfs=/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000', config.image], { signal, timeoutMs: 30_000 });
          if (started.code !== 0) throw new Error(`브라우저 기동 실패: ${started.stderr.slice(-1200)}`);
          await this.waitReady(name, signal);
          this.session.ready = true;
        } catch (error) { await this.closeLocked(input.run.id); throw error; }
      }
      const current = this.session!;
      const result = await this.command('docker', ['exec', '-i', current.name, 'node', '/app/browser.mjs', '--call'],
        { input: JSON.stringify(request), signal, timeoutMs: 45_000 });
      return browserResponse(result);
    });
  }
  private async waitReady(name: string, signal: AbortSignal) {
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await this.command('docker', ['exec', '-i', name, 'node', '/app/browser.mjs', '--call'],
        { input: JSON.stringify({ action: 'status' }), signal, timeoutMs: Math.min(2000, remaining) });
      let value: unknown;
      try { value = JSON.parse(result.stdout); } catch { /* browserResponse retains the failure detail below. */ }
      // Only a missing startup socket is safe to retry. No page action has been
      // sent; permission, transport, malformed-response and other errors stop.
      const socketMissing = result.code !== 0 && value && typeof value === 'object'
        && 'error' in value && value.error === 'connect ENOENT /tmp/ac-browser.sock';
      if (!socketMissing) {
        const status = browserResponse(result);
        if (!status || typeof status !== 'object' || !('open' in status) || typeof status.open !== 'boolean') {
          throw new Error('브라우저 기동 상태 응답이 올바르지 않습니다.');
        }
        return;
      }
      if (attempt < 19 && Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
    }
    throw new Error('브라우저 기동 제한 시간 안에 제어 소켓을 확인하지 못했습니다.');
  }
  async close(runId: string) { await this.exclusive(() => this.closeLocked(runId)); }
  private async closeLocked(runId: string) {
    const current = this.session;
    if (!current || current.runId !== runId) return;
    // The name is generated here and retained even when removal fails. The owning
    // run cannot release its resource lease while this container is unconfirmed.
    current.ready = false;
    let result: CommandResult;
    try { result = await this.command('docker', ['rm', '-f', current.name], { timeoutMs: 15_000 }); }
    catch (error) { throw cleanupPending(error); }
    if (result.code !== 0 && !/No such container/i.test(result.stderr)) {
      throw cleanupPending();
    }
    this.session = undefined;
  }
}
