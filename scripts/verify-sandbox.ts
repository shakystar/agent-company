import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from '../server/process.ts';
import { dockerArguments, runtimeConfig, workspaceVolume } from '../server/runtime.ts';
import type { ExecutionInput } from '../shared/types.ts';

if (existsSync('.env')) loadEnvFile('.env');
const config = runtimeConfig();
assert.equal(config.mode, 'docker');
const docker = (args: string[], options: Parameters<typeof command>[2] = {}) => config.wslDistro
  ? command('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'docker', ...args], options)
  : command('docker', args, options);
const engine = await docker(['version', '--format', '{{.Server.Version}}/{{.Server.Arch}}']);
assert.equal(engine.stdout.trim(), '29.1.3/amd64');
let profile = resolve('worker/security/codex-userns.json');
if (config.wslDistro) {
  const mapped = await command('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'wslpath', '-a', profile]);
  assert.equal(mapped.code, 0); profile = mapped.stdout.trim();
}
const name = `ac-sandbox-verify-${randomUUID()}`;
const persistent = process.argv[2] === 'persistent';
const trace = process.argv.includes('--trace');
const verifiedConfig = { ...config, image: trace ? 'agent-company-worker:seccomp-diagnostic' : config.image,
  workspaceKey: name, dockerSandbox: 'codex-userns' as const, seccompProfile: profile };
const input = { run: { id: name }, resources: { memoryMiB: 256, cpus: 1 } } as ExecutionInput;
const volume = workspaceVolume(verifiedConfig, name);
if (persistent) {
  const created = await docker(['volume', 'create', '--label', `agent-company.workspace=${name}`, volume]);
  assert.equal(created.code, 0);
}
const args = dockerArguments(verifiedConfig, name, input, persistent);
args.splice(args.length - 1, 0, '--entrypoint=node');
args.push('--input-type=module', '-');
try {
  const result = await docker(args, { input: `process.env.AGENT_VERIFY_TRACE=${JSON.stringify(trace ? '1' : '0')};\n` + await readFile('worker/security/verify.mjs', 'utf8'), timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.memoryMax, String(256 * 1024 * 1024));
  assert.equal(checks.cpuMax, '100000 100000');
  assert.equal(checks.pidsMax, '256');
  console.log(JSON.stringify(checks, null, 2));
} finally {
  const removed = await docker(['rm', '-f', name]);
  if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) throw new Error(`진단 컨테이너 종료를 확인하지 못했습니다: ${name}`);
  if (persistent) {
    const owner = await docker(['volume', 'inspect', volume, '--format', '{{index .Labels "agent-company.workspace"}}']);
    assert.equal(owner.stdout.trim(), name);
    const removedVolume = await docker(['volume', 'rm', volume]);
    assert.equal(removedVolume.code, 0, '검증 전용 볼륨 정리에 실패했습니다.');
  }
}
