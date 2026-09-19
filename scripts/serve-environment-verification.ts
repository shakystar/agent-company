import { lstat, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import { ContainerRuntime, type RuntimeConfig } from '../server/runtime.ts';
import { atomicJson, secureDirectory } from '../server/storage.ts';
import type { EnvironmentToolCall } from '../shared/environment.ts';
import type { ExecutionInput } from '../shared/types.ts';
import { directory, environmentCampaign, pinEnvironmentImage } from './environment-campaign.ts';

// Actual-runtime verification only. The controller owns a separate database,
// workspace and bounded campaign; it does not touch the prior observer on 4314.
const port = 4315;
const dataRoot = join(directory, 'data');
const callsPath = join(directory, 'mcp-calls.jsonl');
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let release: (() => Promise<void>) | undefined;
let startup: Promise<void> = Promise.resolve();
let shutdown: Promise<void> | undefined;
let quitting = false;
let evidenceWrites: Promise<void> = Promise.resolve();
let descriptor: { origin: string; pid: number; workspaceKey: string; status: 'running' | 'stopped'; startedAt: string; stoppedAt?: string } | undefined;

function notify(message: Record<string, unknown>): void {
  if (process.connected && process.send) {
    try { process.send(message, () => {}); } catch { /* The fixed descriptor remains available. */ }
  }
}

async function assertPortAvailable(): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

function appendCall(record: { runId: string; server: string; tool: string; args: Record<string, unknown>; result: unknown; at: string }): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  // The runtime has already enforced its 512,000-byte response ceiling. Allow
  // the bounded tool arguments and record metadata, never an entire execution input.
  if (Buffer.byteLength(line) > 1024 * 1024) return Promise.reject(new Error('MCP 검증 기록의 응답 한도를 초과했습니다.'));
  const write = evidenceWrites.then(async () => {
    const existing = await lstat(callsPath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('MCP 검증 기록은 독립된 일반 파일이어야 합니다.');
    const handle = await open(callsPath, 'a', 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('MCP 검증 기록의 소유 파일 형식을 확인하지 못했습니다.');
      await handle.writeFile(line); await handle.sync();
    } finally { await handle.close(); }
  });
  evidenceWrites = write.then(() => undefined, () => undefined);
  return write;
}

class VerificationRuntime extends ContainerRuntime {
  constructor(config: RuntimeConfig) { super(config); }
  override forkWorkspace(workspaceKey: string): VerificationRuntime {
    return new VerificationRuntime({ ...this.config, workspaceKey: z.uuid().parse(workspaceKey) });
  }
  override async callEnvironmentTool(input: ExecutionInput, call: EnvironmentToolCall, signal: AbortSignal): Promise<unknown> {
    const result = await super.callEnvironmentTool(input, call, signal);
    await appendCall({ runId: z.uuid().parse(input.run.id), server: call.server, tool: call.tool,
      args: call.arguments, result, at: new Date().toISOString() });
    return result;
  }
}

function close(exitCode = 0): Promise<void> {
  quitting = true;
  return shutdown ??= (async () => {
    await startup.catch(() => {});
    let code = exitCode;
    try {
      await app?.close(); // createApp's onClose waits for service cleanup and DB close.
      await evidenceWrites;
      if (descriptor) {
        descriptor.status = 'stopped'; descriptor.stoppedAt = new Date().toISOString();
        await atomicJson(join(directory, 'controller.json'), descriptor);
      }
    } catch (error) { code = 1; console.error(error instanceof Error ? error.message : String(error)); }
    finally {
      try { await release?.(); }
      catch (error) { code = 1; console.error(error instanceof Error ? error.message : String(error)); }
    }
    process.exit(code);
  })();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void close(); });
process.on('message', message => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'close') void close();
});

startup = (async () => {
  if (process.argv.length !== 2) throw new Error('Usage: node --import tsx scripts/serve-environment-verification.ts');
  const builtIndex = await lstat(resolve('dist/index.html'));
  if (!builtIndex.isFile() || builtIndex.isSymbolicLink()) throw new Error('검증용 대시보드 빌드가 필요합니다.');
  await assertPortAvailable(); // Fail before opening a database that could resume work.
  const { manifest, config, budget } = await environmentCampaign();
  await secureDirectory(dataRoot);
  release = await lockfile.lock(dataRoot, { lockfilePath: join(dataRoot, 'controller.lock'), stale: 30_000, update: 10_000,
    retries: { retries: 35, factor: 1, minTimeout: 1000, maxTimeout: 1000 } });
  if (quitting) return;
  const pinned = await pinEnvironmentImage(config, manifest);
  if (quitting) return;
  const runtime = new VerificationRuntime(pinned.config);
  const readiness = await runtime.inspect(true);
  if (!readiness.available || !readiness.authenticated) throw new Error(`검증 이미지·기존 로그인 확인 실패: ${readiness.message}`);
  if (quitting) return;
  app = await createApp({ dataDir: join(dataRoot, 'db'), runtime,
    storage: { rootDir: dataRoot, backupDir: join(directory, 'backups'), ownerKey: manifest.workspaceKey },
    beforeModelStart: async request => { await budget.reserve(request); notify({ type: 'model_start', ...request }); },
  });
  app.addHook('onError', async (request, _reply, error) => {
    console.error(JSON.stringify({ type: 'api_error', method: request.method, path: request.url.split('?')[0], message: error.message.slice(0, 3000) }));
  });
  await app.register(fastifyStatic, { root: resolve('dist') });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'API 경로를 찾을 수 없습니다.' }) : reply.sendFile('index.html'));
  if (quitting) return;
  const origin = await app.listen({ host: '127.0.0.1', port });
  descriptor = { origin, pid: process.pid, workspaceKey: manifest.workspaceKey, status: 'running', startedAt: new Date().toISOString() };
  await atomicJson(join(directory, 'controller.json'), descriptor);
  if (quitting) return;
  notify({ type: 'ready', ...descriptor });
  console.log(JSON.stringify({ type: 'ready', ...descriptor }));
})();
try { await startup; }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); await close(1); }
