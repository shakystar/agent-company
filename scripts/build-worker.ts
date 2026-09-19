import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { command } from '../server/process.ts';
import { runtimeConfig } from '../server/runtime.ts';

if (existsSync('.env')) loadEnvFile('.env');
const config = runtimeConfig();
if (config.mode !== 'docker') throw new Error('로컬 worker 빌드에는 Docker 실행 대상을 선택해야 합니다.');
let context = resolve('worker');
if (config.wslDistro) {
  const mapped = await command('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'wslpath', '-a', context]);
  if (mapped.code !== 0 || !mapped.stdout.trim().startsWith('/')) throw new Error('WSL 빌드 경로를 확인하지 못했습니다.');
  context = mapped.stdout.trim();
}
const args = ['build', '-t', config.image, context];
const result = await command(config.wslDistro ? 'wsl.exe' : 'docker',
  config.wslDistro ? ['--distribution', config.wslDistro, '--exec', 'docker', ...args] : args,
  { timeoutMs: 600_000, onLine: line => { console.log(line); } });
if (result.stderr) console.log(result.stderr);
if (result.code !== 0) process.exitCode = result.code;
