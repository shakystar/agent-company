import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import { FileModelBudget } from '../server/model-budget.ts';
import { ContainerRuntime, runtimeConfig, type RuntimeConfig } from '../server/runtime.ts';
import { atomicJson, secureDirectory } from '../server/storage.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult } from '../shared/types.ts';

// Development verification controller only. The root campaign owner creates the
// manifest and starts this process; this script never creates or resets its budget.
const scenario = z.enum(['recovery', 'growth']).parse(process.argv[2]);
if (process.argv.length !== 3) throw new Error('Usage: node --import tsx scripts/lifecycle-controller.ts <recovery|growth>');
const directory = resolve('.verification/lifecycle-20260906');
const scenarioDirectory = join(directory, scenario);
const dataRoot = join(scenarioDirectory, 'data');
const checkpointDirectory = join(scenarioDirectory, 'checkpoints');
const manifestSchema = z.object({ version: z.literal(1), limit: z.literal(20), ownerKey: z.uuid(),
  workspaces: z.object({ recovery: z.uuid(), growth: z.uuid() }).strict(),
  previousLedgerSha256: z.string().regex(/^[a-f0-9]{64}$/i), createdAt: z.iso.datetime() }).strict()
  .refine(value => value.workspaces.recovery !== value.workspaces.growth, 'Scenario workspace identities must be distinct');

function notify(message: Record<string, unknown>): void {
  // IPC observation is optional and must not turn a persisted model result into a
  // failed execution when the observing parent disconnects during a kill test.
  if (process.connected && process.send) {
    try { process.send(message, () => {}); } catch { /* Parent can read HTTP/DB/checkpoint evidence. */ }
  }
}

class CheckpointRuntime extends ContainerRuntime {
  constructor(config: RuntimeConfig) { super(config); }

  override forkWorkspace(workspaceKey: string): CheckpointRuntime {
    return new CheckpointRuntime({ ...this.config, workspaceKey });
  }

  override execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const runId = z.uuid().parse(input.run.id);
    const path = join(checkpointDirectory, `${runId}.json`);
    return super.execute(input, { ...hooks,
      onCheckpoint: async checkpoint => {
        // The service's durable checkpoint always precedes the exported evidence.
        await hooks.onCheckpoint?.(checkpoint);
        await atomicJson(path, checkpoint);
        const hasTrialResults = Object.entries(checkpoint.growthProgress ?? {}).some(([key, value]) =>
          key.startsWith('comparison-') && value !== null && typeof value === 'object' && 'trials' in value
          && Array.isArray(value.trials) && value.trials.length > 0);
        // Comparison completion clears its resumable trials; keep the last actual
        // trial outputs separately so the harness can check their proof artifacts.
        if (hasTrialResults) await atomicJson(join(checkpointDirectory, `${runId}.trials.json`), checkpoint);
        notify({ type: 'checkpoint', runId, phase: checkpoint.phase, path });
      },
      onAttempt: async attempt => {
        await hooks.onAttempt?.(attempt);
        notify({ type: 'attempt', runId: attempt.runId, id: attempt.id, status: attempt.status,
          phase: attempt.phase, observations: attempt.observations });
      },
    });
  }
}

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let release: (() => Promise<void>) | undefined;
let quitting = false;
let startup: Promise<void> = Promise.resolve();
let shutdown: Promise<void> | undefined;
let descriptor: { scenario: string; workspaceKey: string; origin: string; pid: number; startedAt: string; status: 'running' | 'stopped'; stoppedAt?: string } | undefined;

async function recordDescriptor(): Promise<void> {
  if (!descriptor) return;
  try { await atomicJson(join(scenarioDirectory, 'controller.json'), descriptor); }
  catch { console.error('검증 관찰기용 연결 기록을 저장하지 못했습니다.'); }
}

function close(exitCode = 0): Promise<void> {
  quitting = true;
  return shutdown ??= (async () => {
    // A close arriving during lock acquisition/startup cannot release the lock
    // while createApp is still opening or recovering the same database.
    await startup.catch(() => {});
    let code = exitCode;
    try {
      await app?.close();
      if (descriptor) { descriptor.status = 'stopped'; descriptor.stoppedAt = new Date().toISOString(); await recordDescriptor(); }
    }
    catch (error) { code = 1; console.error(error instanceof Error ? error.message : String(error)); }
    finally {
      try { await release?.(); }
      catch (error) { code = 1; console.error(error instanceof Error ? error.message : String(error)); }
    }
    process.exit(code);
  })();
}
process.on('message', message => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'close') void close();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void close(); });

startup = (async () => {
  await secureDirectory(directory);
  const manifestPath = join(directory, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 64 * 1024) {
    throw new Error('Lifecycle manifest must be an existing independent regular JSON file');
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const workspaceKey = manifest.workspaces[scenario];
  const budget = new FileModelBudget(directory, manifest.limit);
  await budget.read(); // Validate an existing ledger; never replace a mismatched cap.
  if (existsSync('.env')) loadEnvFile('.env');
  const config = runtimeConfig();
  if (config.mode !== 'docker' || config.auth !== 'codex' || !config.persistentWorkspaces) {
    throw new Error('Lifecycle verification requires the configured persistent Docker runtime and existing ChatGPT login');
  }
  // Runtime, WSL target, image, timeout and sandbox profile remain production values.
  await secureDirectory(dataRoot);
  await secureDirectory(checkpointDirectory);
  release = await lockfile.lock(dataRoot, {
    lockfilePath: join(dataRoot, 'controller.lock'), stale: 30_000, update: 10_000,
    retries: { retries: 35, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
  });
  if (quitting) return;
  app = await createApp({ dataDir: join(dataRoot, 'db'), runtime: new CheckpointRuntime({ ...config, workspaceKey }),
    storage: { rootDir: dataRoot, backupDir: join(scenarioDirectory, 'backups'), ownerKey: workspaceKey },
    beforeModelStart: async request => {
      await budget.reserve(request);
      notify({ type: 'model_start', ...request });
    },
  });
  if (quitting) return;
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  if (quitting) return;
  descriptor = { scenario, workspaceKey, origin, pid: process.pid, startedAt: new Date().toISOString(), status: 'running' };
  await recordDescriptor();
  const ready = { type: 'ready', origin, pid: process.pid };
  notify(ready);
  console.log(JSON.stringify(ready));
})();
try { await startup; }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await close(1);
}
