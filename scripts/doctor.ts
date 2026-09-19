import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { ContainerRuntime } from '../server/runtime.ts';
import { runtimeConfig } from '../server/runtime.ts';
import { selectedRuntimeConfig } from '../server/releases.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (existsSync('.env')) loadEnvFile('.env');
const root = resolve(process.env.AGENT_DATA_DIR ?? '.data');
const ownerKey = await readFile(resolve(root, 'workspace-id'), 'utf8').then(value => value.trim()).catch(error => {
  if (error.code === 'ENOENT') return null; throw error;
});
const config = ownerKey ? await selectedRuntimeConfig(root, ownerKey, runtimeConfig()) : runtimeConfig();
const runtime = await new ContainerRuntime(config).inspect();
console.log(JSON.stringify({ node: process.version, ...runtime }, null, 2));
if (!runtime.available || !runtime.authenticated) process.exitCode = 1;
