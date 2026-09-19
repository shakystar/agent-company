import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AgentService } from '../server/service.ts';
import { ContainerRuntime } from '../server/runtime.ts';
import type { WorkspaceStore } from '../server/store.ts';
import type { RuntimeDriver } from '../shared/types.ts';
import type { EnvironmentRevision } from '../shared/environment.ts';
import { createWorkerReleaseManifest, workerSourceFiles } from '../shared/runtime-releases.ts';

const at = '2026-09-12T00:00:00.000Z';
const sourceHashes = Object.fromEntries(workerSourceFiles.map(name => [name, 'c'.repeat(64)]));
const previous = createWorkerReleaseManifest({ image: `sha256:${'a'.repeat(64)}`, sourceHashes, runtimeBaseHash: 'd'.repeat(64) });
const current = createWorkerReleaseManifest({ image: `sha256:${'b'.repeat(64)}`, sourceHashes, runtimeBaseHash: 'e'.repeat(64) });
const catalog = (manifest: typeof current) => ({ version: 1 as const, active: { image: manifest.image, manifestId: manifest.id }, manifests: [manifest] });

test('new service Runs pin only owned ready verified environments and never rewrite prior pins', async () => {
  const selector = new ContainerRuntime({ mode: 'docker', auth: 'none', authFile: '', image: current.image, model: 'fixture', timeoutMs: 10_000,
    releaseCatalog: catalog(current), historicalReleaseCatalogs: [catalog(previous)] }, async () => assert.fail('no real runtime transport'));
  const runtime: RuntimeDriver = {
    defaultReleasePin: selector.defaultReleasePin,
    selectReleasePinForEnvironment: image => selector.selectReleasePinForEnvironment(image),
    inspect: async () => ({ mode: 'docker', simulation: true, available: true, authenticated: true, image: current.image, model: 'fixture', message: 'mock', version: 'fixture' }),
    confirmDeploymentIdle: async () => {}, execute: async () => assert.fail('deployment hold must prevent execution'),
  };
  const service = await AgentService.create({ runtime });
  try {
    await service.prepareDeployment();
    const store = (service as unknown as { store: WorkspaceStore }).store;
    for (const kind of ['ready', 'none', 'unknown-image', 'missing-report', 'failed-status', 'other-owner', 'failed-check', 'package-mismatch', 'missing-revision']) {
      const agent = await service.createAgent({ name: kind, persona: 'fixture' });
      const revision: EnvironmentRevision = { id: randomUUID(), agentId: agent.id, baseRevisionId: null, sourceRunId: null,
        buildRunId: randomUUID(), reason: 'verified mock imported environment', requestedAccess: [], status: 'ready', error: null,
        spec: { packages: [], servers: [] }, createdAt: at, completedAt: at,
        report: { imageId: previous.image, contentHash: '1'.repeat(64), lockfileHash: '2'.repeat(64), packages: [], tools: [],
          checks: [{ name: 'fixture', passed: true, detail: 'mock verification' }], createdAt: at } };
      if (kind === 'unknown-image') revision.report!.imageId = `sha256:${'f'.repeat(64)}`;
      if (kind === 'missing-report') delete revision.report;
      if (kind === 'failed-status') revision.status = 'failed';
      if (kind === 'other-owner') revision.agentId = randomUUID();
      if (kind === 'failed-check') revision.report!.checks[0].passed = false;
      if (kind === 'package-mismatch') revision.report!.packages = [{ name: 'unexpected', version: '1.0.0' }];
      await store.change(state => {
        if (kind !== 'none') {
          state.agents.find(item => item.id === agent.id)!.environmentRevisionId = revision.id;
          if (kind !== 'missing-revision') state.environmentRevisions.push(revision);
        }
      });
      const before = await store.read();
      if (kind === 'ready' || kind === 'none') {
        const run = await service.startRun(agent.id, 'queued only');
        assert.deepEqual(run.runtimeRelease, kind === 'ready' ? catalog(previous).active : catalog(current).active);
        const state = await store.read();
        assert.deepEqual(state.runs.filter(item => item.id !== run.id), before.runs);
        if (kind === 'ready') assert.equal(state.executionStates[run.id].input.environment!.report.imageId, previous.image);
      } else {
        await assert.rejects(service.startRun(agent.id, 'must reject before snapshot'), { statusCode: 409 });
        const after = await store.read();
        assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.snapshots, before.snapshots);
      }
    }
    assert.deepEqual(runtime.defaultReleasePin, catalog(current).active);
  } finally { await service.close(); }
});
