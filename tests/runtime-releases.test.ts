import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerReleaseManifest, validateWorkerReleaseCatalog, requireWorkerRelease, assertCompatibleWorkerReleases,
  stableRuntimeHash, workerSourceFiles, validateWorkerReleaseCatalogSet, selectWorkerReleaseCatalog,
  validateHistoricalWorkerAuthBindings, legacyWorkerEntrySha256 } from '../shared/runtime-releases.ts';

const image = (letter: string) => `sha256:${letter.repeat(64)}`;
const sourceHashes = Object.fromEntries(workerSourceFiles.map(name => [name, 'c'.repeat(64)]));
const manifest = (letter: string, changes = {}) => createWorkerReleaseManifest({ image: image(letter), sourceHashes, runtimeBaseHash: 'd'.repeat(64), ...changes });

test('worker manifest IDs are canonical and only entry may change across compatible releases', () => {
  const a = manifest('a'), b = manifest('b', { sourceHashes: { ...sourceHashes, 'entry.mjs': 'e'.repeat(64) } });
  assertCompatibleWorkerReleases(a, b);
  assert.equal(stableRuntimeHash({ b: 1, a: 2 }), stableRuntimeHash({ a: 2, b: 1 }));
  assert.notEqual(a.id, b.id);
  const catalog = validateWorkerReleaseCatalog({ version: 1, active: { image: b.image, manifestId: b.id }, manifests: [a, b] });
  assert.equal(requireWorkerRelease(catalog, { image: a.image, manifestId: a.id }).id, a.id);
});

test('worker catalog rejects missing, conflicting, tampered and incompatible pins', () => {
  const a = manifest('a'), pin = { image: a.image, manifestId: a.id }, catalog = { version: 1 as const, active: pin, manifests: [a] };
  assert.throws(() => requireWorkerRelease(catalog, { ...pin, image: image('b') }), /catalog/);
  assert.throws(() => validateWorkerReleaseCatalog({ ...catalog, manifests: [a, a] }), /중복/);
  assert.throws(() => validateWorkerReleaseCatalog({ ...catalog, manifests: [{ ...a, helperContract: 'e'.repeat(64) }] }), /계약/);
  assert.throws(() => assertCompatibleWorkerReleases(a, manifest('b', { runtimeBaseHash: 'e'.repeat(64) })), /실행 기반/);
  assert.throws(() => assertCompatibleWorkerReleases(a, manifest('b', { sourceHashes: { ...sourceHashes, 'workspace.mjs': 'e'.repeat(64) } })), /helper 계약/);
  assert.throws(() => manifest('b', { sourceHashes: { 'entry.mjs': 'e'.repeat(64) } }));
});

test('historical catalog selection keeps distinct runtime bases and exact pins without weakening homogeneous catalogs', () => {
  const old = manifest('a'), current = manifest('b', { runtimeBaseHash: 'e'.repeat(64) });
  const catalog = (item: typeof old) => ({ version: 1 as const, active: { image: item.image, manifestId: item.id }, manifests: [item] });
  const previous = catalog(old), active = catalog(current), before = structuredClone({ previous, active });
  assert.throws(() => validateWorkerReleaseCatalog({ ...active, manifests: [old, current] }), /실행 기반/);
  assert.deepEqual(validateWorkerReleaseCatalogSet(active, [previous]), { active, historical: [previous] });
  assert.deepEqual(selectWorkerReleaseCatalog(active, [previous], previous.active), previous);
  assert.deepEqual(selectWorkerReleaseCatalog(active, [previous], active.active), active);
  assert.deepEqual({ previous, active }, before);
  assert.throws(() => selectWorkerReleaseCatalog(active, [], previous.active), /catalog/);
  assert.throws(() => selectWorkerReleaseCatalog(active, [previous], { ...previous.active, manifestId: current.id }), /catalog/);
  assert.throws(() => validateWorkerReleaseCatalogSet(active, [catalog(manifest('c', {
    sourceHashes: { ...sourceHashes, 'environment.mjs': 'f'.repeat(64) },
  }))]), /helper 계약/);
  assert.throws(() => validateWorkerReleaseCatalogSet(active, [catalog(manifest('b'))]), /충돌/);
  assert.throws(() => validateWorkerReleaseCatalogSet(active, [{ ...previous, manifests: [{ ...old, id: 'f'.repeat(64) }] }]));
  assert.deepEqual(selectWorkerReleaseCatalog(active, [active, previous], active.active), active, 'identical overlapping evidence is allowed');
});

test('legacy authentication adapters require an exact registered historical pin and inspected entry contract', () => {
  const old = manifest('a', { sourceHashes: { ...sourceHashes, 'entry.mjs': legacyWorkerEntrySha256[0] } }), current = manifest('b', { runtimeBaseHash: 'e'.repeat(64) });
  const catalog = (item: typeof old) => ({ version: 1 as const, active: { image: item.image, manifestId: item.id }, manifests: [item] });
  const previous = catalog(old), active = catalog(current);
  const binding = { pin: previous.active, contract: 'codex-secret-directory-v1' as const, entrySha256: legacyWorkerEntrySha256[0] };
  assert.deepEqual(validateHistoricalWorkerAuthBindings(active, [previous], [binding]), [binding]);
  for (const raw of [
    [binding, binding], [{ ...binding, entrySha256: legacyWorkerEntrySha256[1] }], [{ ...binding, entrySha256: 'f'.repeat(64) }],
    [{ ...binding, pin: active.active }], [{ ...binding, pin: { ...previous.active, manifestId: current.id } }],
    [{ ...binding, contract: 'arbitrary' }], [{ ...binding, source: '/untrusted/auth.json' }],
  ]) assert.throws(() => validateHistoricalWorkerAuthBindings(active, [previous], raw));
  assert.throws(() => validateHistoricalWorkerAuthBindings(active, [], [binding]));
});
