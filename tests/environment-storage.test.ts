import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AgentService } from '../server/service.ts';
import { type StorageConfig } from '../server/storage.ts';
import type { EnvironmentProposal } from '../shared/environment.ts';
import type { ModelStartRequest } from '../shared/telemetry.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

const GiB = 1024 ** 3;
const proposal: EnvironmentProposal = { reason: 'Preserve this draft while waiting for package capacity', requestedAccess: [],
  spec: { packages: [{ name: 'fixture-environment-package', version: '1.2.3' }], servers: [] } };

for (const constraint of ['data-capacity', 'physical-free-space'] as const) {
  test(`environment admission waits for its 2 GiB bundle ceiling before runtime or model starts: ${constraint}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'ac-environment-storage-'));
    const storage: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: randomUUID(),
      limits: { dataBytes: constraint === 'data-capacity' ? GiB : 10 * GiB, minFreeBytes: 20 * GiB },
      freeSpace: async () => constraint === 'physical-free-space' ? 21 * GiB : 100 * GiB };
    const runtime = new StorageFixtureRuntime(storage.ownerKey);
    const starts: ModelStartRequest[] = [];
    const options = () => ({ dataDir: join(storage.rootDir, 'db'), runtime, storage,
      recovery: { maxAttempts: 1, retryDelayMs: 0 }, beforeModelStart: async (start: ModelStartRequest) => { starts.push(start); } });
    let service: AgentService | undefined;
    t.after(async () => {
      await service?.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.match(directory, /ac-environment-storage-[^\\/]+$/);
      const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
      await rm(directory, { recursive: true });
    });
    service = await AgentService.create(options());
    const agent = await service.createAgent({ name: 'Wait for environment capacity', persona: 'Keep existing work while waiting' });
    await service.addMemory(agent.id, { kind: 'fact', title: 'Existing memory', content: 'Unchanged across cancelled environment admission' });
    await service.importFile({ scope: { type: 'agent', id: agent.id }, path: 'preserved.txt', mediaType: 'text/plain', base64: Buffer.from('Existing personal file').toString('base64') });
    const before = await service.workspace();
    const space = await service.storageStatus();
    // Ordinary 1 MiB admission would pass; only the environment's potential
    // 2 GiB content makes these otherwise usable capacities insufficient.
    assert.ok(space.limits.dataBytes - space.usage.dataBytes > 1024 * 1024);
    assert.ok(space.usage.freeBytes - space.limits.minFreeBytes > 1024 * 1024);
    const revision = await service.proposeEnvironment(agent.id, structuredClone(proposal));
    const deadline = Date.now() + 8000;
    let waiting = await service.workspace();
    for (;;) {
      const run = waiting.runs.find(item => item.environmentRevisionId === revision.id);
      if (run?.status === 'queued' && run.recoveryReason) break;
      assert.ok(Date.now() < deadline, 'Environment must reach storage admission wait');
      await delay(10); waiting = await service.workspace();
    }
    const run = waiting.runs.find(item => item.environmentRevisionId === revision.id)!;
    assert.match(run.recoveryReason!, constraint === 'data-capacity' ? /운영 데이터.*예산/ : /실제 디스크.*여유/);
    assert.equal(run.kind, 'environment'); assert.equal(run.startedAt, null); assert.equal(run.resources, undefined);
    assert.equal(waiting.environmentRevisions!.find(item => item.id === revision.id)!.status, 'queued');
    assert.deepEqual(waiting.environmentRevisions!.find(item => item.id === revision.id)!.spec, proposal.spec);
    assert.equal(runtime.calls.length, 0); assert.deepEqual(starts, []); assert.deepEqual(waiting.modelAttempts, []);
    assert.deepEqual(waiting.resources!.reserved, { memoryMiB: 0, cpus: 0 });
    assert.deepEqual(waiting.resources!.running, []); assert.deepEqual(waiting.resources!.waiting, []);
    assert.deepEqual(waiting.memories, before.memories);
    assert.equal(waiting.agents[0].environmentRevisionId, before.agents[0].environmentRevisionId);
    assert.equal(waiting.agents[0].workspaceRunId, before.agents[0].workspaceRunId);

    await service.cancelEnvironment(revision.id);
    await service.close(); service = undefined;
    service = await AgentService.create(options());
    const reopened = await service.workspace();
    const cancelled = reopened.environmentRevisions!.find(item => item.id === revision.id)!;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.reason, proposal.reason);
    assert.deepEqual(cancelled.spec, proposal.spec); assert.equal(cancelled.buildRunId, run.id);
    assert.equal(reopened.runs.find(item => item.id === run.id)!.status, 'cancelled');
    assert.equal(reopened.runs.length, waiting.runs.length);
    assert.deepEqual(reopened.memories, before.memories);
    assert.equal(reopened.agents[0].environmentRevisionId, before.agents[0].environmentRevisionId);
    assert.equal(reopened.agents[0].workspaceRunId, before.agents[0].workspaceRunId);
    assert.equal((await service.downloadWorkspaceFile(agent.id, 'preserved.txt')).bytes.toString(), 'Existing personal file');
    assert.equal(runtime.calls.length, 0); assert.deepEqual(starts, []); assert.deepEqual(reopened.modelAttempts, []);
    assert.deepEqual(reopened.resources!.reserved, { memoryMiB: 0, cpus: 0 });
  });
}
