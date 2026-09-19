import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { FileModelBudget } from './model-budget.ts';
import { secureDirectory } from './storage.ts';
import type { ModelStartRequest } from '../shared/telemetry.ts';

const protectedLedgers = [
  '.verification/growth-20260906/model-budget.json', '.verification/lifecycle-20260906/model-budget.json',
  '.verification/environment-20260906/model-budget.json', '.verification/conversation-20260906/model-budget.json',
];
const schema = z.object({ version: z.literal(1), limit: z.literal(10), ownerKey: z.uuid(),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), createdAt: z.iso.datetime(),
  protectedFiles: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict();
async function bytes(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('검증 장부는 크기가 제한된 독립된 일반 파일이어야 합니다.');
  return readFile(path);
}
async function optional(path: string) {
  try { return await bytes(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Explicit opt-in for this approved campaign, not a normal-operation limit. */
export class OperationVerificationCampaign {
  readonly directory: string;
  private manifest!: z.infer<typeof schema>;
  private budget: FileModelBudget;
  private constructor(directory: string, private readonly protectedPaths: string[], private readonly anchorPath: string) {
    this.directory = resolve(directory); this.budget = new FileModelBudget(this.directory, 10);
  }
  static async open(ownerKey: string, imageId: string,
    options: { directory?: string; protectedPaths?: string[]; anchorPath?: string } = {}) {
    const campaign = new OperationVerificationCampaign(options.directory ?? '.verification/operation-20260907', options.protectedPaths ?? protectedLedgers,
      resolve(options.anchorPath ?? '.data/operation-verification.identity.json'));
    await secureDirectory(campaign.directory);
    const manifestPath = join(campaign.directory, 'manifest.json'), ledgerPath = join(campaign.directory, 'model-budget.json');
    const manifest = await optional(manifestPath), ledger = await optional(ledgerPath), anchor = await optional(campaign.anchorPath);
    if (!manifest && !ledger && !anchor) {
      const protectedFiles = await Promise.all(campaign.protectedPaths.map(async path => ({ path, sha256: digest(await bytes(resolve(path))) })));
      const initial = schema.parse({ version: 1, limit: 10, ownerKey, imageId, createdAt: new Date().toISOString(), protectedFiles });
      await secureDirectory(dirname(campaign.anchorPath));
      await writeFile(campaign.anchorPath, JSON.stringify({ version: 1, ownerKey, manifestHash: digest(Buffer.from(JSON.stringify(initial))) }), { flag: 'wx', mode: 0o600 });
      await writeFile(ledgerPath, JSON.stringify({ version: 1, limit: 10, starts: [] }), { flag: 'wx', mode: 0o600 });
      await writeFile(manifestPath, JSON.stringify(initial), { flag: 'wx', mode: 0o600 });
    } else if (!manifest || !ledger || !anchor) throw new Error('통합 검증 장부 또는 별도 식별 기록이 누락됐습니다. 횟수를 초기화하지 않았습니다.');
    campaign.manifest = schema.parse(JSON.parse((await bytes(manifestPath)).toString('utf8')));
    if (campaign.manifest.ownerKey !== ownerKey || campaign.manifest.imageId !== imageId
      || JSON.stringify(campaign.manifest.protectedFiles.map(item => item.path)) !== JSON.stringify(campaign.protectedPaths)) throw new Error('통합 검증 소유권·이미지·보호 장부가 일치하지 않습니다.');
    await campaign.validate(); await campaign.budget.read(); return campaign;
  }
  async validate() {
    const current = schema.parse(JSON.parse((await bytes(join(this.directory, 'manifest.json'))).toString('utf8')));
    if (JSON.stringify(current) !== JSON.stringify(this.manifest)) throw new Error('통합 검증 명세가 변경됐습니다.');
    const anchor = z.object({ version: z.literal(1), ownerKey: z.uuid(), manifestHash: z.string() }).strict().parse(JSON.parse((await bytes(this.anchorPath)).toString('utf8')));
    if (anchor.ownerKey !== current.ownerKey || anchor.manifestHash !== digest(Buffer.from(JSON.stringify(current)))) throw new Error('통합 검증의 별도 식별 기록이 일치하지 않습니다.');
    await bytes(join(this.directory, 'model-budget.json'));
    for (const file of this.manifest.protectedFiles) {
      if (digest(await bytes(resolve(file.path))) !== file.sha256) throw new Error(`이전 검증 장부가 변경됐습니다: ${file.path}`);
    }
  }
  async reserve(request: ModelStartRequest) {
    await this.validate(); await this.budget.reserve(request);
    console.log(JSON.stringify({ type: 'verification_model_start', ...request, used: (await this.budget.read()).starts.length, limit: 10 }));
  }
  async status() { await this.validate(); return this.budget.read(); }
}
