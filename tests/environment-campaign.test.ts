import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import lockfile from 'proper-lockfile';
import { FileModelBudget } from '../server/model-budget.ts';

test('image evidence keeps its actual proper-lockfile ownership across nested budget reads and read failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-environment-campaign-lock-'));
  const target = join(directory, 'image.json');
  const options = { realpath: false, lockfilePath: join(directory, 'image.lock'), retries: 0 };
  let release: (() => Promise<void>) | undefined;
  t.after(async () => {
    if (release) await release();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-environment-campaign-lock-[^\\/]+$/);
    const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    await rm(directory, { recursive: true });
  });
  const ledgerPath = join(directory, 'model-budget.json');
  const initialLedger = JSON.stringify({ version: 1, limit: 100, starts: [] });
  await writeFile(ledgerPath, initialLedger, { flag: 'wx' });
  // The image file intentionally does not exist yet, as on a campaign's first
  // pin. realpath:false permits locking that distinct future evidence target.
  release = await lockfile.lock(target, options);
  assert.equal(await lockfile.check(target, options), true);
  const budget = new FileModelBudget(directory, 100);
  assert.deepEqual(await budget.read(), { version: 1, limit: 100, starts: [] });
  await assert.rejects(new FileModelBudget(directory, 99).read(), /초기화하지/);
  assert.equal(await lockfile.check(target, options), true, 'nested directory locks must not release image ownership');
  await assert.rejects(lockfile.lock(target, options), (error: NodeJS.ErrnoException) => error.code === 'ELOCKED');
  assert.equal(await readFile(ledgerPath, 'utf8'), initialLedger, 'read and failed read must not rewrite the budget');

  const evidence = JSON.stringify({ imageId: `sha256:${'a'.repeat(64)}` });
  await writeFile(target, evidence, { flag: 'wx' });
  await release(); release = undefined;
  assert.equal(await lockfile.check(target, options), false);
  // An existing immutable evidence file can be locked again on restart.
  release = await lockfile.lock(target, options);
  await budget.read();
  assert.equal(await readFile(target, 'utf8'), evidence);
  await release(); release = undefined;
  assert.equal(await lockfile.check(target, options), false);
});

test('campaign pin source uses a distinct image target before its nested budget read', async () => {
  // Source guard binds the real lock-library regression above to the production
  // helper without importing its fixed campaign path or touching real evidence.
  const source = await readFile(new URL('../scripts/environment-campaign.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function pinEnvironmentImage(');
  assert.ok(start >= 0);
  const pin = source.slice(start);
  assert.match(pin, /lockfile\.lock\(join\(directory, 'image\.json'\),\s*\{\s*realpath:\s*false,\s*lockfilePath:\s*join\(directory, 'image\.lock'\)/);
  assert.doesNotMatch(pin, /lockfile\.lock\(directory,\s*\{[^}]*image\.lock/);
  assert.match(pin, /new FileModelBudget\(directory, manifest\.limit\)\.read\(\)/);
  assert.match(pin, /finally\s*\{\s*await release\(\)/);
});
