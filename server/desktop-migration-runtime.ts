import { createHash } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { readDesktopProviderFile } from './desktop-provider-files.ts';
import { atomicJson, existingStorageDirectory } from './storage.ts';
import { validateWorkerReleaseCatalog, workerReleasePinSchema, type WorkerReleaseCatalog } from '../shared/runtime-releases.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const migrationRuntimeSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), workspaceKey: z.uuid(), generationId: z.uuid(),
  sourceManifestSha256: digest, historicalReleaseCatalogs: z.array(z.unknown()).min(1).max(100),
  historicalAuthBindings: z.array(z.object({ pin: workerReleasePinSchema, contract: z.literal('codex-secret-directory-v1'), entrySha256: digest }).strict()).max(1000),
}).strict();
const receiptSchema = z.object({ version: z.literal(1), source: z.object({ directory: z.string(), ownerKey: z.uuid(), backupId: z.uuid(), manifestSha256: digest }).strict(),
  targetOwnerKey: z.uuid(), workspaceKey: z.uuid(), generationId: z.uuid(), createdAt: z.iso.datetime(), stateSha256: digest, runtimeSha256: digest.optional() }).strict();

async function document(path: string) {
  const snapshot = await readDesktopProviderFile(path, 2 * 1024 * 1024);
  return { value: JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(snapshot.data)) as unknown, sha256: snapshot.pin.sha256 };
}
function validateRuntime(raw: unknown) {
  const parsed = migrationRuntimeSchema.parse(raw);
  const historicalReleaseCatalogs = parsed.historicalReleaseCatalogs.map(validateWorkerReleaseCatalog);
  const pins = new Set<string>();
  for (const binding of parsed.historicalAuthBindings) {
    const key = `${binding.pin.image}:${binding.pin.manifestId}`;
    const manifest = historicalReleaseCatalogs.flatMap(c => c.manifests).find(m => m.image === binding.pin.image && m.id === binding.pin.manifestId);
    if (pins.has(key) || !manifest || manifest.sourceHashes['entry.mjs'] !== binding.entrySha256) throw new Error('이관 인증 계약의 실행 이미지 근거가 일치하지 않습니다.');
    pins.add(key);
  }
  return { ...parsed, historicalReleaseCatalogs };
}

/** Only an explicit offline import may attach historical runtime metadata. The
 * source manifest and target generation stay bound; provider UI cannot write it. */
export async function sealDesktopMigrationRuntime(directory: string, options: {
  ownerKey: string; workspaceKey: string; historicalReleaseCatalogs: WorkerReleaseCatalog[];
  historicalAuthBindings: z.infer<typeof migrationRuntimeSchema>['historicalAuthBindings'];
}) {
  await existingStorageDirectory(directory);
  const receiptPath = join(directory, 'migration-receipt.json');
  const receipt = receiptSchema.parse((await document(receiptPath)).value);
  if (receipt.targetOwnerKey !== options.ownerKey || receipt.workspaceKey !== options.workspaceKey || receipt.generationId !== basename(directory)
    || receipt.runtimeSha256) throw new Error('이관 세대의 소유권 또는 봉인 상태가 일치하지 않습니다.');
  const runtime = validateRuntime({ version: 1, ownerKey: options.ownerKey, workspaceKey: options.workspaceKey,
    generationId: receipt.generationId, sourceManifestSha256: receipt.source.manifestSha256,
    historicalReleaseCatalogs: options.historicalReleaseCatalogs, historicalAuthBindings: options.historicalAuthBindings });
  const bytes = JSON.stringify(runtime);
  await writeFile(join(directory, 'migration-runtime.json'), bytes, { flag: 'wx', mode: 0o600 });
  await atomicJson(receiptPath, { ...receipt, runtimeSha256: createHash('sha256').update(bytes).digest('hex') });
}

/** Missing metadata is valid for an ordinary workspace, but never for a migrated
 * generation. A broken seal blocks configuration before service/model startup. */
export async function loadDesktopMigrationRuntime(directory: string, ownerKey: string, workspaceKey: string) {
  const receiptPath = join(directory, 'migration-receipt.json'), runtimePath = join(directory, 'migration-runtime.json');
  const exists = (path: string) => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (!await exists(receiptPath)) {
    if (await exists(runtimePath)) throw new Error('출처 영수증 없는 이관 실행 구성이 있습니다.');
    return { historicalReleaseCatalogs: [] as WorkerReleaseCatalog[], historicalAuthBindings: [] as z.infer<typeof migrationRuntimeSchema>['historicalAuthBindings'] };
  }
  const receipt = receiptSchema.parse((await document(receiptPath)).value);
  const snapshot = await document(runtimePath), runtime = validateRuntime(snapshot.value);
  if (!receipt.runtimeSha256 || snapshot.sha256 !== receipt.runtimeSha256 || receipt.targetOwnerKey !== ownerKey || receipt.workspaceKey !== workspaceKey
    || receipt.generationId !== basename(directory) || runtime.ownerKey !== ownerKey || runtime.workspaceKey !== workspaceKey
    || runtime.generationId !== receipt.generationId || runtime.sourceManifestSha256 !== receipt.source.manifestSha256) throw new Error('이관 실행 구성의 출처·해시·소유권이 일치하지 않습니다.');
  return { historicalReleaseCatalogs: runtime.historicalReleaseCatalogs, historicalAuthBindings: runtime.historicalAuthBindings };
}
