import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopMigrationRuntime, sealDesktopMigrationRuntime } from '../server/desktop-migration-runtime.ts';
import { createWorkerReleaseManifest, workerSourceFiles } from '../shared/runtime-releases.ts';

test('migration runtime requires target/source binding and immutable runtime digest; normal workspace needs no migration metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-migration-runtime-'));
  t.after(() => rm(root, { recursive: true }));
  const ownerKey = randomUUID(), workspaceKey = randomUUID(), generationId = randomUUID(), directory = join(root, generationId);
  await mkdir(directory);
  assert.deepEqual(await loadDesktopMigrationRuntime(directory, ownerKey, workspaceKey), { historicalReleaseCatalogs: [], historicalAuthBindings: [] });
  const receipt = { version: 1, source: { directory: join(root, 'export'), ownerKey: randomUUID(), backupId: randomUUID(), manifestSha256: 'a'.repeat(64) },
    targetOwnerKey: ownerKey, workspaceKey, generationId, createdAt: new Date().toISOString(), stateSha256: 'b'.repeat(64) };
  await writeFile(join(directory, 'migration-receipt.json'), JSON.stringify(receipt));
  await assert.rejects(loadDesktopMigrationRuntime(directory, ownerKey, workspaceKey));
  const manifest = createWorkerReleaseManifest({ image: `sha256:${'c'.repeat(64)}`, runtimeBaseHash: 'd'.repeat(64),
    sourceHashes: Object.fromEntries(workerSourceFiles.map(name => [name, 'e'.repeat(64)])) });
  const catalog = { version: 1 as const, active: { image: manifest.image, manifestId: manifest.id }, manifests: [manifest] };
  await sealDesktopMigrationRuntime(directory, { ownerKey, workspaceKey, historicalReleaseCatalogs: [catalog], historicalAuthBindings: [] });
  const loaded = await loadDesktopMigrationRuntime(directory, ownerKey, workspaceKey);
  assert.deepEqual(loaded.historicalReleaseCatalogs, [catalog]);
  await assert.rejects(loadDesktopMigrationRuntime(directory, randomUUID(), workspaceKey), /소유권/);
  await assert.rejects(sealDesktopMigrationRuntime(directory, { ownerKey, workspaceKey, historicalReleaseCatalogs: [catalog], historicalAuthBindings: [] }), /봉인/);
  const runtimePath = join(directory, 'migration-runtime.json'), raw = await readFile(runtimePath, 'utf8');
  await writeFile(runtimePath, `${raw} `);
  await assert.rejects(loadDesktopMigrationRuntime(directory, ownerKey, workspaceKey), /해시/);
  await rm(join(directory, 'migration-receipt.json'));
  await assert.rejects(loadDesktopMigrationRuntime(directory, ownerKey, workspaceKey), /영수증 없는/);
});
