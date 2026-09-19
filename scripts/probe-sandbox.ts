import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from '../server/process.ts';
import { runtimeConfig } from '../server/runtime.ts';

if (existsSync('.env')) loadEnvFile('.env');
const config = runtimeConfig();
if (config.mode !== 'docker') throw new Error('이 진단은 Docker 전용입니다.');
const selected = process.argv[2] ?? 'default';
if (!['default', 'restricted'].includes(selected)) throw new Error('default 또는 restricted만 선택할 수 있습니다.');
const docker = (args: string[], options: Parameters<typeof command>[2] = {}) => config.wslDistro
  ? command('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'docker', ...args], options)
  : command('docker', args, options);
let profile = resolve('worker/security/codex-userns.json');
if (selected !== 'default' && config.wslDistro) {
  const mapped = await command('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'wslpath', '-a', profile]);
  if (mapped.code !== 0) throw new Error('프로필 경로 변환에 실패했습니다.');
  profile = mapped.stdout.trim();
}
const name = `ac-sandbox-probe-${randomUUID()}`;
try {
  const result = await docker(['run', '--rm', '--name', name, '--label', 'app=agent-company',
    '--label', 'agent-company.workspace=sandbox-diagnostic', '--read-only', '--network=none',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    ...(selected !== 'default' ? [`--security-opt=seccomp=${profile}`] : []),
    '--user=1000:1000', '--memory=256m', '--cpus=1', '--pids-limit=128',
    '--tmpfs=/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000',
    '--tmpfs=/home/node/.codex:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=64m',
    'agent-company-worker:seccomp-diagnostic', '-f', '-qq', '-e',
    'trace=clone,clone3,unshare,mount,pivot_root,umount2,chroot,setns',
    'codex', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false',
    'sandbox', '--', '/usr/bin/true'], { timeoutMs: 60_000 });
  console.log(JSON.stringify({ profile: selected, code: result.code, stdout: result.stdout,
    trace: result.stderr.split('\n').filter(line => !line.includes('CLONE_VM') && !line.includes('clone3(')).join('\n') }, null, 2));
  process.exitCode = result.code;
} finally {
  const removed = await docker(['rm', '-f', name], { timeoutMs: 30_000 });
  if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) throw new Error(`진단 컨테이너 종료를 확인하지 못했습니다: ${name}`);
}
