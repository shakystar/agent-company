import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { command, type Command } from '../server/process.ts';
import type { ExecutionInput, ExecutionHooks } from '../shared/types.ts';

if (existsSync('.env')) loadEnvFile('.env');
const workspaceKey = randomUUID(), nonce = randomUUID();
const config = { ...runtimeConfig(), workspaceKey, persistentWorkspaces: true };
assert.equal(config.mode, 'docker', 'This local smoke requires the explicitly selected Docker runtime.');
const docker: Command = (file, args, options) => config.wslDistro && file === 'docker'
  ? command('wsl.exe', ['--distribution', config.wslDistro, '--exec', file, ...args], options) : command(file, args, options);
const directory = await mkdtemp(join(tmpdir(), 'agent-company-peer-smoke-'));
const called: string[] = [];
let sawWaiting = false;
class ObservedRuntime extends ContainerRuntime {
  override execute(input: ExecutionInput, hooks: ExecutionHooks) {
    console.log(JSON.stringify({ event: 'worker', agent: input.agent.name, runId: input.run.id, continuation: Boolean(input.previousResult) }));
    return super.execute(input, { ...hooks, onTool: async (name, args) => {
      called.push(name);
      console.log(JSON.stringify({ event: 'tool', agent: input.agent.name, name }));
      return hooks.onTool!(name, args);
    } });
  }
}
let service: AgentService | undefined;
try {
  const runtime = new ObservedRuntime(config);
  service = await AgentService.create({ runtime, dataDir: join(directory, 'db'),
    scheduler: new ResourceScheduler({ capacity: { memoryMiB: 1536, cpus: 1 },
      defaultRequest: { minimum: { memoryMiB: 1536, cpus: 1 }, preferred: { memoryMiB: 1536, cpus: 1 } } }) });
  const persona = '로컬 협업 연결 검증에 참여하는 독립 동료입니다. 이 검증에서는 새 기억과 스킬을 만들지 않습니다. '
    + '팀 도구는 현재 승인된 팀의 검증 메시지와 산출물에만 사용합니다. 불필요한 추가 대화는 하지 않습니다.';
  const a = await service.createAgent({ name: '검증 A', persona });
  const b = await service.createAgent({ name: '검증 B', persona: `${persona}\n받은 검증 요청에서는 message_list로 요청을 읽고 message_acknowledge합니다. `
    + '공유 입력 파일을 artifact_read로 읽고 Python으로 137*29를 계산해 /workspace/peer-result.json에 입력의 nonce와 value를 저장합니다. '
    + '같은 JSON을 shared/result.json으로 artifact_publish하고, 원래 요청에 replyToId로 답장하면서 산출물 ID를 전달합니다. '
    + '요청을 message_complete한 뒤 작업을 마칩니다. A의 개인 파일은 접근하지 않습니다.' });
  const team = await service.createTeam({ name: '실제 협업 검사', memberIds: [a.id, b.id],
    workflow: '두 동료가 명시적으로 공유한 자료만 전달합니다. 서로의 개인 기억과 작업공간은 공유하지 않습니다.' });
  const run = await service.startRun(a.id,
    `실제 협업 검증입니다. 팀 ID ${team.id}, 동료 B ID ${b.id}, nonce ${nonce}입니다. `
    + `먼저 /workspace/private.txt에 ${nonce}를 기록합니다. artifact_publish로 팀 범위 shared/input.json에 {"nonce":"${nonce}"}를 게시합니다. `
    + 'message_send로 B에게 공유 입력을 읽고 137*29를 계산하여 shared/result.json으로 게시하고 답장하도록 요청합니다. '
    + '그 요청의 messageId로 peer_wait를 호출하고 현재 턴을 종료합니다. '
    + '응답을 받아 재개된 뒤에만 메시지와 공유 결과를 읽고 /workspace/team-result.json에 같은 JSON을 저장합니다. '
    + '최종 result는 collaboration-ok:3973으로 마칩니다. 이미 수행한 요청을 반복하거나 별도 메시지를 추가하지 않습니다.');
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    const state = await service.workspace();
    const current = state.runs.find(item => item.id === run.id)!;
    if (current.status === 'waiting') sawWaiting = true;
    const failed = state.runs.find(item => item.status === 'failed');
    if (failed) throw new Error(`${failed.agentId}: ${failed.error}`);
    if (current.status === 'succeeded' && !state.runs.some(item => ['queued', 'starting', 'running', 'waiting'].includes(item.status))) break;
    if (Date.now() > deadline) throw new Error('실제 협업 검증 대기 시간을 초과했습니다.');
    await delay(1000);
  }
  const diagnostics = await service.workspace();
  console.log(JSON.stringify({ event: 'completed-runs', runs: diagnostics.runs.map(item => ({ agentId: item.agentId,
    result: item.result, status: item.status, attempt: item.attempt })), tools: called }));
  assert.ok(called.includes('message_send') && called.includes('artifact_publish') && called.includes('peer_wait'), '실제 협업 도구 호출을 확인하지 못했습니다.');
  const file = await service.workspaceFiles(a.id, 'team-result.json', true) as { text: string };
  assert.deepEqual(JSON.parse(file.text), { nonce, value: 3973 });
  const privateFile = await service.workspaceFiles(a.id, 'private.txt', true) as { text: string };
  assert.equal(privateFile.text.trim(), nonce);
  const state = await service.workspace();
  const actual = state.runs.find(item => item.id === run.id)!;
  assert.ok(called.includes('message_send') && called.includes('artifact_publish') && called.includes('peer_wait'));
  assert.ok(sawWaiting || (actual.attempt ?? 0) > 1, 'Expected a durable waiting continuation.');
  assert.equal(state.runs.filter(item => item.agentId === b.id).length, 1);
  console.log(JSON.stringify({ result: 'collaboration-ok:3973', fileVerified: true, privateFilePreserved: true,
    waitingObserved: sawWaiting, turns: actual.attempt, messageCount: state.messages?.length,
    inputTokens: state.runs.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: state.runs.reduce((sum, item) => sum + item.outputTokens, 0) }));
} finally {
  await service?.close();
  const selector = `label=agent-company.workspace=${workspaceKey}`;
  const containers = await docker('docker', ['ps', '-aq', '--filter', 'label=app=agent-company', '--filter', selector]);
  assert.equal(containers.code, 0);
  for (const id of containers.stdout.trim().split(/\s+/).filter(Boolean)) {
    assert.match(id, /^[a-f0-9]{12,64}$/);
    assert.equal((await docker('docker', ['rm', '-f', id])).code, 0);
  }
  const volumes = await docker('docker', ['volume', 'ls', '-q', '--filter', 'label=app=agent-company', '--filter', selector]);
  assert.equal(volumes.code, 0);
  for (const volume of volumes.stdout.trim().split(/\s+/).filter(Boolean)) {
    assert.match(volume, /^ac-[a-f0-9]{16}-[a-f0-9]{24}$/);
    const owned = await docker('docker', ['volume', 'inspect', volume, '--format', '{{index .Labels "agent-company.workspace"}}']);
    assert.equal(owned.stdout.trim(), workspaceKey);
    assert.equal((await docker('docker', ['volume', 'rm', volume])).code, 0);
  }
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(directory, /agent-company-peer-smoke-[^\\/]+$/);
  await rm(directory, { recursive: true, force: true });
  console.log('검증 전용 컨테이너·볼륨·임시 DB를 정리했습니다.');
}
