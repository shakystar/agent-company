import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface WorkerReleasePin { image: string; manifestId: string }
export interface WorkerReleaseManifest {
  version: 1; id: string; image: string; sourceHashes: Record<string, string>; helperContract: string; runtimeBaseHash: string;
}
export interface WorkerReleaseCatalog { version: 1; active: WorkerReleasePin; manifests: WorkerReleaseManifest[] }
export interface HistoricalWorkerAuthBinding {
  pin: WorkerReleasePin; contract: 'codex-secret-directory-v1'; entrySha256: string;
}
/** These two immutable entry sources were read from the historical images and
 * matched their release manifests. They support AGENT_SECRET_DIR, not authBinding.
 * Extending this set requires inspecting the exact new source and its contract. */
export const legacyWorkerEntrySha256 = [
  '00a83e88a131b4edc290c7023b5aca857cc4b551748f5da6f7003e2c5f13815a',
  '3c44a67421a2f0bcf621fed3437e5788eaca199a789b7685f877242f7e01754a',
] as const;
export const workerSourceFiles = ['entry.mjs', 'principles.mjs', 'team-mcp.mjs', 'browser-source.mjs', 'workspace.mjs', 'storage.mjs', 'growth.mjs', 'environment.mjs', 'npm-empty.npmrc'] as const;
export const workerImageSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const workerReleasePinSchema = z.object({ image: workerImageSchema, manifestId: digest }).strict();
const sourceHashesSchema = z.record(z.string(), digest).refine(value => Object.keys(value).length === workerSourceFiles.length
  && workerSourceFiles.every(name => Boolean(value[name])), 'worker source hash 목록이 완전하지 않습니다.');
const manifestSchema = z.object({ version: z.literal(1), id: digest, image: workerImageSchema,
  sourceHashes: sourceHashesSchema, helperContract: digest, runtimeBaseHash: digest }).strict();
export function canonicalRuntimeJson(value: unknown): string {
  if (value === undefined) throw new Error('정의되지 않은 값을 이미지 증거로 사용할 수 없습니다.');
  if (Array.isArray(value)) return `[${value.map(canonicalRuntimeJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalRuntimeJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function stableRuntimeHash(value: unknown): string { return createHash('sha256').update(canonicalRuntimeJson(value)).digest('hex'); }
export function createWorkerReleaseManifest(input: { image: string; sourceHashes: Record<string, string>; runtimeBaseHash: string }): WorkerReleaseManifest {
  const image = workerImageSchema.parse(input.image), sourceHashes = sourceHashesSchema.parse(input.sourceHashes), runtimeBaseHash = digest.parse(input.runtimeBaseHash);
  const helperContract = stableRuntimeHash({ version: 1, helpers: Object.fromEntries(workerSourceFiles.filter(name => name !== 'entry.mjs').map(name => [name, sourceHashes[name]])) });
  const body = { version: 1 as const, image, sourceHashes, helperContract, runtimeBaseHash };
  return { ...body, id: stableRuntimeHash(body) };
}
export function validateWorkerReleaseManifest(raw: unknown): WorkerReleaseManifest {
  const value = manifestSchema.parse(raw), expected = createWorkerReleaseManifest(value);
  if (value.id !== expected.id || value.helperContract !== expected.helperContract) throw new Error('worker manifest 식별자 또는 helper 계약이 일치하지 않습니다.');
  return value;
}
export function requireWorkerRelease(catalog: WorkerReleaseCatalog, pin: WorkerReleasePin): WorkerReleaseManifest {
  const selected = workerReleasePinSchema.parse(pin);
  const matches = catalog.manifests.filter(item => item.id === selected.manifestId && item.image === selected.image);
  if (matches.length !== 1) throw new Error('실행 이미지 pin이 catalog에 없거나 충돌합니다. 기본 이미지로 대체하지 않습니다.');
  return validateWorkerReleaseManifest(matches[0]);
}
export function assertCompatibleWorkerReleases(a: WorkerReleaseManifest, b: WorkerReleaseManifest): void {
  validateWorkerReleaseManifest(a); validateWorkerReleaseManifest(b);
  if (a.helperContract !== b.helperContract || a.runtimeBaseHash !== b.runtimeBaseHash) throw new Error('worker helper 계약 또는 실행 기반이 달라 기존 작업을 보존하는 이미지 전환을 지원하지 않습니다.');
}
export function validateWorkerReleaseCatalog(raw: unknown): WorkerReleaseCatalog {
  const catalog = z.object({ version: z.literal(1), active: workerReleasePinSchema, manifests: z.array(manifestSchema).min(1).max(1000) }).strict().parse(raw);
  if (new Set(catalog.manifests.map(item => item.image)).size !== catalog.manifests.length
    || new Set(catalog.manifests.map(item => item.id)).size !== catalog.manifests.length) throw new Error('worker catalog 이미지 또는 manifest가 중복됩니다.');
  const active = requireWorkerRelease(catalog, catalog.active);
  for (const item of catalog.manifests) assertCompatibleWorkerReleases(active, item);
  return catalog;
}

/** Historical execution bases remain separate homogeneous catalogs. Sharing a
 * controller/workspace format requires the exact same eight helper sources;
 * it does not establish provider authentication or native-package ABI parity. */
export function validateWorkerReleaseCatalogSet(active: unknown, historical: unknown = []): {
  active: WorkerReleaseCatalog; historical: WorkerReleaseCatalog[];
} {
  const current = validateWorkerReleaseCatalog(active);
  const previous = z.array(z.unknown()).max(100).parse(historical).map(validateWorkerReleaseCatalog);
  const helperContract = requireWorkerRelease(current, current.active).helperContract;
  const images = new Map<string, string>(), ids = new Map<string, string>();
  for (const catalog of [current, ...previous]) for (const manifest of catalog.manifests) {
    if (manifest.helperContract !== helperContract) throw new Error('역사별 worker catalog의 helper 계약이 다릅니다. 별도 실행 기반만 선택할 수 있습니다.');
    if ((images.has(manifest.image) && images.get(manifest.image) !== manifest.id)
      || (ids.has(manifest.id) && ids.get(manifest.id) !== manifest.image)) throw new Error('역사별 worker catalog 이미지 또는 manifest 증거가 충돌합니다.');
    images.set(manifest.image, manifest.id); ids.set(manifest.id, manifest.image);
  }
  return { active: current, historical: previous };
}

/** Select by the original exact pin, never by a tag, runtimeBase approximation,
 * environment preference or the current default. Identical repeated manifests
 * are harmless; conflicting evidence is rejected for the entire set. */
export function selectWorkerReleaseCatalog(active: WorkerReleaseCatalog, historical: WorkerReleaseCatalog[] | undefined,
  pin: WorkerReleasePin): WorkerReleaseCatalog {
  const set = validateWorkerReleaseCatalogSet(active, historical ?? []), selected = workerReleasePinSchema.parse(pin);
  const catalog = [set.active, ...set.historical].find(item => item.manifests.some(manifest => manifest.id === selected.manifestId && manifest.image === selected.image));
  if (!catalog) throw new Error('실행 이미지 pin이 현재 또는 역사별 catalog에 없습니다. 기본 이미지로 대체하지 않습니다.');
  requireWorkerRelease(catalog, selected);
  return catalog;
}

/** Private migration configuration. No binding can select a new image, widen a
 * homogeneous catalog, or infer compatibility from a provider version string. */
export function validateHistoricalWorkerAuthBindings(active: WorkerReleaseCatalog, historical: WorkerReleaseCatalog[] | undefined,
  raw: unknown = []): HistoricalWorkerAuthBinding[] {
  const set = validateWorkerReleaseCatalogSet(active, historical ?? []);
  const bindings = z.array(z.object({ pin: workerReleasePinSchema, contract: z.literal('codex-secret-directory-v1'),
    entrySha256: z.enum(legacyWorkerEntrySha256) }).strict()).max(1000).parse(raw);
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.pin.manifestId)) throw new Error('역사별 인증 어댑터가 중복됩니다.');
    seen.add(binding.pin.manifestId);
    const catalog = set.historical.find(item => item.manifests.some(manifest => manifest.id === binding.pin.manifestId && manifest.image === binding.pin.image));
    if (!catalog || binding.pin.image === set.active.active.image) throw new Error('인증 어댑터는 명시된 역사별 이미지 pin에만 연결할 수 있습니다.');
    if (requireWorkerRelease(catalog, binding.pin).sourceHashes['entry.mjs'] !== binding.entrySha256) throw new Error('역사별 인증 어댑터의 entry source 증거가 다릅니다.');
  }
  return bindings;
}
