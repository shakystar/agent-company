import { assertOperatingMigrationStartup } from './desktop-migration-cutover.ts';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import lockfile from 'proper-lockfile';
import { createApp } from './app.ts';
import { ContainerRuntime, runtimeConfig } from './runtime.ts';
import { activeStorage, defaultStorageLimits, type StorageConfig } from './storage.ts';
import { OperationalModelBudget } from './operational-budget.ts';
import { selectedRuntimeConfig } from './releases.ts';
import { OperationVerificationCampaign } from './verification-campaign.ts';
import { createGitHubRuntime } from './github-runtime.ts';

if (existsSync('.env')) loadEnvFile('.env');
const dataDir = resolve(process.env.AGENT_DATA_DIR ?? '.data');
await mkdir(dataDir, { recursive: true });
console.log('개인 데이터 폴더의 실행 잠금을 확인합니다.');
const unlock = await lockfile.lock(dataDir, {
  lockfilePath: resolve(dataDir, 'controller.lock'), stale: 30_000, update: 10_000,
  // Windows watchers may terminate a process without delivering SIGTERM. Wait for
  // its lease to expire; never remove a potentially live controller's lock.
  retries: { retries: 35, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
});
let lockHeld = true;
const release = async () => { if (lockHeld) { lockHeld = false; await unlock(); } };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
await assertOperatingMigrationStartup(dataDir);
const keyPath = resolve(dataDir, 'workspace-id');
let workspaceKey: string;
try { workspaceKey = (await readFile(keyPath, 'utf8')).trim(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  workspaceKey = randomUUID();
  await writeFile(keyPath, workspaceKey, { flag: 'wx' });
}
if (!/^[a-f0-9-]{36}$/.test(workspaceKey)) throw new Error('워크스페이스 식별자가 올바르지 않습니다.');
const storage: StorageConfig | undefined = process.env.AGENT_STORAGE_ENABLED === 'true' ? {
  rootDir: dataDir, ownerKey: workspaceKey, backupDir: resolve(process.env.AGENT_BACKUP_DIR ?? 'C:/dev/backups/agent-company'),
  limits: Object.fromEntries(Object.entries(defaultStorageLimits).map(([key, fallback]) => {
    const names: Record<string, string> = { dataBytes: 'AGENT_DATA_BUDGET_GIB', backupBytes: 'AGENT_BACKUP_BUDGET_GIB', tempBytes: 'AGENT_STORAGE_TEMP_GIB', minFreeBytes: 'AGENT_DISK_MIN_FREE_GIB' };
    const raw = process.env[names[key]];
    return [key, raw === undefined ? fallback : Number(raw) * 1024 ** 3];
  })),
} : undefined;
const selected = storage ? await activeStorage(storage) : { dataDir, workspaceKey };
const selectedConfig = await selectedRuntimeConfig(dataDir, workspaceKey, runtimeConfig());
const operationalBudget = await OperationalModelBudget.open({ directory: resolve(dataDir, 'operational-budget'), ownerKey: workspaceKey });
const verification = process.argv.includes('--verify-operation')
  ? await OperationVerificationCampaign.open(workspaceKey, selectedConfig.image, { anchorPath: resolve(dataDir, 'operation-verification.identity.json') }) : undefined;
const runtime = new ContainerRuntime({ ...selectedConfig, workspaceKey: selected.workspaceKey });
const github = await createGitHubRuntime({ rootDir: dataDir, ownerKey: workspaceKey });
const port = Number(process.env.PORT ?? 4310);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT 설정이 올바르지 않습니다.');
app = await createApp({ dataDir: resolve(selected.dataDir, 'db'), runtime, storage, operationalBudget, github,
  prepareDeployment: process.argv.includes('--prepare-deployment'),
  ...(process.argv.includes('--diagnose-dashboard-response') ? { dashboardResponseDiagnostics: {
    write: (record: unknown) => console.log(`[dashboard-response] ${JSON.stringify(record)}`),
    maxRequests: 20, durationMs: 5 * 60_000,
  } } : {}),
  preview: { controllerOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173'] },
  ...(verification ? { beforeModelStart: request => verification.reserve(request) } : {}) });
app.addHook('onClose', async () => { await release(); });
const dist = resolve('dist');
if (existsSync(resolve(dist, 'index.html'))) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'API 경로를 찾을 수 없습니다.' });
    return reply.sendFile('index.html');
  });
}
await app.listen({ host: '127.0.0.1', port });
console.log(`Agent Company API: http://127.0.0.1:${port}`);
if (process.argv.includes('--diagnose-dashboard-response')) console.log('Dashboard response diagnostics: GET / and /index.html only, max 20 requests, 5 minutes; no cookies, credentials or bodies.');
if (verification) console.log('이번 통합 검증은 별도 총 10회 모델 시작 한도를 사용합니다.');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app!.close();
  process.exit(0);
};
for (const event of ['SIGINT', 'SIGTERM'] as const) {
  process.on(event, stop);
}
// A local parent can stop this controller gracefully without an exposed HTTP endpoint.
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void stop(); });
} catch (error) {
  try { await app?.close(); } finally { await release(); }
  throw error;
}
