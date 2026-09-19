import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { FileModelBudget } from '../server/model-budget.ts';
import { runtimeConfig } from '../server/runtime.ts';
import { secureDirectory } from '../server/storage.ts';

export const campaignDirectory = resolve('.verification/lifecycle-20260906');
export type Scenario = 'growth' | 'recovery';
export interface CampaignManifest {
  version: 1; limit: 20; ownerKey: string; workspaces: Record<Scenario, string>;
  previousLedgerSha256: string; createdAt: string;
}
const previousLedger = resolve('.verification/growth-20260906/model-budget.json');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function campaign() {
  if (existsSync('.env')) loadEnvFile('.env');
  const config = runtimeConfig();
  assert.equal(config.mode, 'docker'); assert.equal(config.auth, 'codex');
  await secureDirectory(campaignDirectory);
  let manifest: CampaignManifest;
  try { manifest = JSON.parse(await readFile(join(campaignDirectory, 'manifest.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    manifest = { version: 1, limit: 20, ownerKey: randomUUID(), workspaces: { growth: randomUUID(), recovery: randomUUID() },
      previousLedgerSha256: hash(await readFile(previousLedger)), createdAt: new Date().toISOString() };
    await writeFile(join(campaignDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  }
  assert.equal(manifest.version, 1); assert.equal(manifest.limit, 20);
  for (const key of [manifest.ownerKey, manifest.workspaces.growth, manifest.workspaces.recovery]) assert.match(key, /^[a-f0-9-]{36}$/);
  assert.equal(hash(await readFile(previousLedger)), manifest.previousLedgerSha256, 'The previous 9/10 campaign must remain unchanged');
  for (const scenario of ['growth', 'recovery']) await mkdir(join(campaignDirectory, scenario), { recursive: true });
  return { directory: campaignDirectory, manifest, config, budget: new FileModelBudget(campaignDirectory, 20) };
}
