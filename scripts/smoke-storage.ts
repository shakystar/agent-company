import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { AgentService } from '../server/service.ts';
import { activeStorage, type StorageConfig } from '../server/storage.ts';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';

if (existsSync('.env')) loadEnvFile('.env');
const runtimeSettings = runtimeConfig();
if (runtimeSettings.mode !== 'docker') throw new Error('실제 저장 검사는 지정된 Docker 실행기가 필요합니다.');
const directory = await mkdtemp(join(tmpdir(), 'ac-storage-docker-'));
const ownerKey = randomUUID();
const runtime = new ContainerRuntime({ ...runtimeSettings, auth: 'none', apiKey: undefined, workspaceKey: ownerKey });
const config: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey };
let service: AgentService | undefined;
const keys = new Set<string>([ownerKey]);
try {
  service = await AgentService.create({ dataDir: join(config.rootDir, 'db'), runtime, storage: config });
  const a = await service.createAgent({ name: 'Storage smoke A', persona: '격리 저장 검증', model: runtimeSettings.model });
  const team = await service.createTeam({ name: 'Storage smoke peers', memberIds: [a.id] });
  const privateBytes = Buffer.from(`storage-roundtrip:${randomUUID()}`);
  await service.importFile({ scope: { type: 'agent', id: a.id }, path: 'input/private.txt', mediaType: 'text/plain', base64: privateBytes.toString('base64') });
  const sharedBytes = Buffer.from([0, 1, 2, 128, 255]);
  const shared = await service.importFile({ scope: { type: 'team', id: team.id }, path: 'shared.bin', mediaType: 'application/octet-stream', base64: sharedBytes.toString('base64') });
  console.log('개인 볼륨·공유 파일 반입을 확인했습니다.');
  const backed = await service.createBackup(); const id = backed.backups[0].id;
  await service.pinBackup(id, true);
  await service.updateAgent(a.id, { name: 'Original preserved after backup' });
  const staged = await service.prepareRestore(id);
  console.log('독립 복원본의 DB·파일 검증을 확인했습니다.');
  assert.equal((await service.workspace()).agents[0].name, 'Original preserved after backup');
  assert.equal((await service.activateRestore(staged.id)).paused, true);
  assert.deepEqual((await service.downloadWorkspaceFile(a.id, 'input/private.txt')).bytes, privateBytes);
  assert.deepEqual((await service.downloadFile(shared.file.id)).bytes, sharedBytes);
  assert.equal((await service.workspace()).agents[0].name, 'Storage smoke A');
  const selected = await activeStorage(config); keys.add(selected.workspaceKey);
  await service.close(); service = undefined;
  service = await AgentService.create({ dataDir: join(selected.dataDir, 'db'), runtime: runtime.forkWorkspace(selected.workspaceKey), storage: config });
  assert.equal((await service.storageStatus()).paused, true);
  assert.deepEqual((await service.downloadWorkspaceFile(a.id, 'input/private.txt')).bytes, privateBytes);
  assert.deepEqual((await service.downloadFile(shared.file.id)).bytes, sharedBytes);
  console.log(JSON.stringify({ status: 'storage-ok', personalFileVerified: true, sharedBinaryVerified: true, restoredPausedAfterRestart: true, originalDataPreserved: true, modelCalls: 0 }));
} finally {
  await service?.close();
  try {
    const layout = JSON.parse(await readFile(join(config.rootDir, 'storage-layout.json'), 'utf8'));
    assert.equal(layout.ownerKey, ownerKey);
    for (const item of [...layout.generations, ...layout.restores]) { assert.match(item.workspaceKey, /^[a-f0-9-]{36}$/); keys.add(item.workspaceKey); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const key of keys) {
    const owned = runtime.forkWorkspace(key);
    for (const volume of await owned.listWorkspaceVolumes()) await owned.removeWorkspaceVolume(volume.runId);
  }
  const target = resolve(directory); const suffix = relative(resolve(tmpdir()), target);
  assert.ok(suffix.startsWith('ac-storage-docker-') && !suffix.includes('..'));
  await rm(target, { recursive: true });
  console.log('검증 전용 DB·백업·소유 볼륨을 정리했습니다. 사용자 데이터와 인증은 변경하지 않았습니다.');
}
