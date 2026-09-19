import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { runtimeConfig } from '../server/runtime.ts';
import { assertReleaseIdle, readRuntimeRelease, selectRuntimeRelease, transitionRuntimeRelease, createRuntimeReleaseEvidenceTemplate } from '../server/releases.ts';

if (existsSync('.env')) loadEnvFile('.env');
const [action, ...args] = process.argv.slice(2);
const pinned = action === 'activate-pinned' || action === 'rollback-pinned';
const takesImage = action === 'activate' || action === 'activate-pinned' || action === 'evidence-template';
const image = takesImage ? args.shift() : undefined;
const evidencePath = pinned && args[0] === '--evidence' && args.length === 2 ? args[1] : undefined;
if (!['status', 'activate', 'rollback', 'activate-pinned', 'rollback-pinned', 'evidence-template'].includes(action)
  || takesImage && !image || args.length && !evidencePath) {
  throw new Error('사용 형식: npm run release -- status | activate <image> | rollback | evidence-template <new-file.json> | activate-pinned <image> [--evidence file.json] | rollback-pinned [--evidence file.json]');
}
const root = resolve(process.env.AGENT_DATA_DIR ?? '.data');
const ownerKey = (await readFile(join(root, 'workspace-id'), 'utf8')).trim();
const config = runtimeConfig();
if (action === 'status') {
  console.log(JSON.stringify(await readRuntimeRelease(root, ownerKey, config), null, 2));
} else if (action === 'evidence-template') {
  const template = await createRuntimeReleaseEvidenceTemplate(root, ownerKey, config);
  await writeFile(resolve(image!), `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ evidenceTemplate: resolve(image!), complete: false }));
} else if (pinned) {
  const record = await transitionRuntimeRelease(root, ownerKey, config, action === 'activate-pinned'
    ? { action: 'activate', image: image!, evidencePath } : { action: 'rollback', evidencePath });
  console.log(JSON.stringify(record, null, 2));
} else {
  // No forced stale-lock removal and no live-server image replacement.
  const release = await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
  try {
    await assertReleaseIdle(root, ownerKey, config);
    const record = await selectRuntimeRelease(root, ownerKey, config, action === 'activate' ? { action, image: image! } : { action: 'rollback' });
    console.log(JSON.stringify(record, null, 2));
  } finally { await release(); }
}
