import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import assert from 'node:assert/strict';
import { ContainerRuntime, runtimeConfig, workspaceVolume } from '../server/runtime.ts';
import { command } from '../server/process.ts';
import type { ExecutionInput } from '../shared/types.ts';

if (existsSync('.env')) loadEnvFile('.env');
const at = new Date().toISOString();
const id = randomUUID();
const nonce = randomUUID();
const config = { ...runtimeConfig(), workspaceKey: `smoke-${id}`, persistentWorkspaces: true, timeoutMs: 180_000 };
assert.equal(config.mode, 'docker', '이 실검증은 로컬 Docker 작업공간을 확인합니다.');
const input: ExecutionInput = {
  agent: { id, name: '실행 검증', description: '', persona: '요청된 검증 작업을 수행하고 관찰한 결과를 정확히 기록합니다.', color: '#738876', model: runtimeConfig().model,
    status: 'running', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: at, updatedAt: at },
  run: { id, agentId: id, agentVersion: 1, snapshotId: id,
    prompt: `터미널 도구로 python3를 실행해 137 * 29를 계산합니다. Python으로 /workspace/runtime-proof.json 파일에 {"value":계산값,"nonce":"${nonce}"}를 기록합니다. 성공하면 result를 정확히 "runtime-ok:3973"으로 반환합니다. 명령 실행에 실패하면 오류를 그대로 보고합니다. 기억·스킬·산출물 배열은 비워 둡니다.`,
    status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: at, completedAt: null },
  memories: [], skills: [], connections: [], resources: { memoryMiB: 1024, cpus: 1 },
};
const driver = new ContainerRuntime(config);
const docker = (args: string[]) => config.wslDistro
  ? command('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'docker', ...args])
  : command('docker', args);
const volume = workspaceVolume(config, id), readerName = `ac-${id}-evidence`;
try {
  const result = await driver.execute(input, {
    signal: AbortSignal.timeout(190_000), getSteering: async () => [],
    onEvent: async message => { console.log(message); },
  });
  assert.equal(result.result.trim(), 'runtime-ok:3973');
  // Read the actual worker file outside the model response and outside its sandbox.
  const proof = await docker(['run', '--rm', '--name', readerName, '--label', 'app=agent-company',
    '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--user=1000:1000', '--memory=64m', '--cpus=0.25', '--pids-limit=64',
    '--mount', `type=volume,source=${volume},target=/workspace,readonly`, '--entrypoint=python3', config.image,
    '-c', 'from pathlib import Path; print(Path("/workspace/runtime-proof.json").read_text())']);
  assert.equal(proof.code, 0, proof.stderr);
  assert.deepEqual(JSON.parse(proof.stdout), { value: 3973, nonce });
  console.log(JSON.stringify({ result: result.result, fileVerified: true, inputTokens: result.inputTokens, outputTokens: result.outputTokens }));
} finally {
  await driver.settle(id);
  const removed = await docker(['rm', '-f', readerName]);
  assert.ok(removed.code === 0 || /No such container/i.test(removed.stderr), '증거 조회 컨테이너 정리를 확인하지 못했습니다.');
  const owner = await docker(['volume', 'inspect', volume, '--format', '{{index .Labels "agent-company.workspace"}}']);
  if (owner.code === 0) {
    assert.equal(owner.stdout.trim(), config.workspaceKey);
    const cleaned = await docker(['volume', 'rm', volume]);
    assert.equal(cleaned.code, 0, '실검증 전용 볼륨 정리에 실패했습니다.');
  } else assert.match(owner.stderr, /No such volume/i);
}
