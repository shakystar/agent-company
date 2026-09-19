import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { FileModelBudget } from '../server/model-budget.ts';
import { command, type Command } from '../server/process.ts';
import { runtimeConfig, type RuntimeConfig } from '../server/runtime.ts';
import { secureDirectory } from '../server/storage.ts';
import type { ModelStartRequest } from '../shared/telemetry.ts';

export const directory = resolve('.verification/environment-20260906');
export const verificationImage = 'agent-company-worker:environment-20260906';
const previousCampaigns = [
  { path: '.verification/growth-20260906/model-budget.json', limit: 10, starts: 9 },
  { path: '.verification/lifecycle-20260906/model-budget.json', limit: 20, starts: 20 },
] as const;
const manifestSchema = z.object({ version: z.literal(1), limit: z.literal(100), workspaceKey: z.uuid(),
  previousLedgers: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).length(2),
  createdAt: z.iso.datetime(),
}).strict();
export type EnvironmentCampaignManifest = z.infer<typeof manifestSchema>;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const imageEvidenceSchema = z.object({ version: z.literal(1), workspaceKey: z.uuid(), tag: z.literal(verificationImage),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), inspectedAt: z.iso.datetime(),
  sourceEvidence: z.literal('host-source-observed-at-pin-not-image-content-verification'),
  workerSources: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  workerSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const workerSourcePaths = ['worker/Dockerfile', 'worker/entry.mjs', 'worker/principles.mjs', 'worker/team-mcp.mjs',
  'worker/workspace.mjs', 'worker/storage.mjs', 'worker/growth.mjs', 'worker/environment.mjs', 'worker/npm-empty.npmrc', 'worker/security/codex-userns.json'];

async function regularFile(path: string, maximum = 4 * 1024 * 1024): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) {
    throw new Error('검증 기록은 제한 크기의 독립된 일반 파일이어야 합니다.');
  }
  return readFile(path);
}

async function previousLedgers() {
  return Promise.all(previousCampaigns.map(async expected => {
    const bytes = await regularFile(resolve(expected.path));
    const ledger = JSON.parse(bytes.toString('utf8'));
    assert.equal(ledger.version, 1); assert.equal(ledger.limit, expected.limit);
    assert.ok(Array.isArray(ledger.starts)); assert.equal(ledger.starts.length, expected.starts);
    return { path: expected.path, sha256: digest(bytes) };
  }));
}

async function verifyPreviousLedgers(manifest: EnvironmentCampaignManifest): Promise<void> {
  assert.deepEqual(await previousLedgers(), manifest.previousLedgers, '이전 9/10·20/20 검증 기록은 변경할 수 없습니다.');
}

class EnvironmentCampaignBudget extends FileModelBudget {
  constructor(readonly manifest: EnvironmentCampaignManifest) { super(directory, manifest.limit); }
  override async reserve(request: ModelStartRequest): Promise<void> {
    // A removed ledger must not silently become an empty campaign. Historical
    // evidence is checked at each actual model start, not merely server startup.
    await regularFile(join(directory, 'model-budget.json'));
    const stored = manifestSchema.parse(JSON.parse((await regularFile(join(directory, 'manifest.json'), 64 * 1024)).toString('utf8')));
    assert.deepEqual(stored, this.manifest, '실행 중인 검증 캠페인 설정이 변경됐습니다.');
    await verifyPreviousLedgers(this.manifest);
    await super.reserve(request);
  }
}

export async function environmentCampaign() {
  if (existsSync('.env')) loadEnvFile('.env');
  const currentConfig = runtimeConfig();
  assert.equal(currentConfig.mode, 'docker'); assert.equal(currentConfig.auth, 'codex');
  assert.equal(currentConfig.persistentWorkspaces, true); assert.equal(currentConfig.model, 'gpt-6-astra');
  await secureDirectory(directory);
  const release = await lockfile.lock(directory, { lockfilePath: join(directory, 'campaign.lock'),
    stale: 30_000, update: 10_000, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
  let manifest: EnvironmentCampaignManifest;
  try {
    const manifestPath = join(directory, 'manifest.json');
    const ledgerPath = join(directory, 'model-budget.json');
    try { manifest = manifestSchema.parse(JSON.parse((await regularFile(manifestPath, 64 * 1024)).toString('utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (existsSync(ledgerPath)) throw new Error('기존 예산 기록에 캠페인 manifest가 없습니다. 초기화하지 않았습니다.');
      manifest = { version: 1, limit: 100, workspaceKey: randomUUID(), previousLedgers: await previousLedgers(), createdAt: new Date().toISOString() };
      // Create-only writes deliberately leave incomplete initialization visible
      // after a crash; neither side of a partial campaign is ever reset.
      await writeFile(ledgerPath, JSON.stringify({ version: 1, limit: 100, starts: [] }, null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    }
    await regularFile(ledgerPath);
    await verifyPreviousLedgers(manifest);
  } finally { await release(); }
  const budget = new EnvironmentCampaignBudget(manifest);
  await budget.read();
  // Only the verification image and owned workspace differ. No .env edits,
  // authentication copies, default-tag changes or runtime fallback are made.
  const config = { ...currentConfig, image: verificationImage, workspaceKey: manifest.workspaceKey };
  return { directory, manifest, config, budget };
}

/** Read-only image inspection occurs only when explicitly called by the controller. */
export async function pinEnvironmentImage(config: RuntimeConfig, manifest: EnvironmentCampaignManifest, runner: Command = command) {
  assert.equal(config.mode, 'docker'); assert.equal(config.image, verificationImage);
  assert.equal(config.workspaceKey, manifest.workspaceKey);
  const args = ['image', 'inspect', verificationImage, '--format', '{{.Id}}'];
  const inspected = await runner(config.wslDistro ? 'wsl.exe' : 'docker',
    config.wslDistro ? ['--distribution', config.wslDistro, '--exec', 'docker', ...args] : args, { timeoutMs: 30_000 });
  if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim())) {
    throw new Error('검증 전용 이미지의 고정 ID를 확인하지 못했습니다. 다른 이미지로 대체하지 않습니다.');
  }
  const imageId = inspected.stdout.trim();
  await secureDirectory(directory);
  // proper-lockfile keys in-process ownership by target, not lockfilePath.
  // Keep this lock distinct from the nested model-budget lock on directory.
  const release = await lockfile.lock(join(directory, 'image.json'), { realpath: false, lockfilePath: join(directory, 'image.lock'), stale: 30_000, update: 10_000,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
  let evidence: z.infer<typeof imageEvidenceSchema>;
  try {
    const path = join(directory, 'image.json');
    try { evidence = imageEvidenceSchema.parse(JSON.parse((await regularFile(path, 64 * 1024)).toString('utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const ledger = await new FileModelBudget(directory, manifest.limit).read();
      if (ledger.starts.length) throw new Error('이미 시작한 캠페인의 이미지 근거가 없습니다. 사후 이미지 지정은 하지 않습니다.');
      const workerSources = await Promise.all(workerSourcePaths.map(async path => ({ path, sha256: digest(await regularFile(resolve(path))) })));
      evidence = { version: 1, workspaceKey: manifest.workspaceKey, tag: verificationImage, imageId,
        inspectedAt: new Date().toISOString(), sourceEvidence: 'host-source-observed-at-pin-not-image-content-verification',
        workerSources, workerSourceHash: digest(Buffer.from(JSON.stringify(workerSources))) };
      await writeFile(path, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
    }
    assert.equal(evidence.workspaceKey, manifest.workspaceKey, '검증 이미지 근거의 캠페인 소유권이 다릅니다.');
    assert.equal(evidence.imageId, imageId, '검증 이미지 태그의 ID가 이전 시작과 다릅니다. 기존 이미지 근거를 덮어쓰지 않았습니다.');
    assert.equal(evidence.workerSourceHash, digest(Buffer.from(JSON.stringify(evidence.workerSources))), '보존된 worker 소스 목록의 해시가 일치하지 않습니다.');
  } finally { await release(); }
  return { config: { ...config, image: evidence.imageId }, evidence };
}
