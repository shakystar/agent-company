import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OperationalModelBudget, validateOperationalBudgetMigration, type OperationalBudgetMigration } from '../server/operational-budget.ts';
import { temporary } from './operational-budget-fixture.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const denied = (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 409;
const read = async (directory: string) => JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'));
async function fixture(t: TestContext) {
  const root = await temporary(t), sourceDirectory = join(root, 'source'), targetDirectory = join(root, 'target');
  const sourceOwner = randomUUID(), targetOwner = randomUUID(), now = () => new Date('2026-09-12T02:00:00Z');
  const source = await OperationalModelBudget.open({ directory: sourceDirectory, ownerKey: sourceOwner, now });
  const target = await OperationalModelBudget.open({ directory: targetDirectory, ownerKey: targetOwner, now });
  const snapshot = () => OperationalModelBudget.exportMigration({ directory: sourceDirectory, ownerKey: sourceOwner });
  const options = (value: OperationalBudgetMigration, expectedRevision = 0) => ({ sourceOwnerKey: sourceOwner,
    sourceLedgerSha256: value.ledgerSha256, expectedRevision });
  const charge = (budget: OperationalModelBudget, runId = randomUUID(), scoped = false) => budget.reserve(
    { runId, phase: 'task', kind: 'migration-fixture', reason: 'No real process is started' },
    { projectId: scoped ? project : null, rootRunId: runId, ...(scoped ? { teamId: team, agentId: agent } : {}) });
  const project = randomUUID(), team = randomUUID(), agent = randomUUID();
  return { root, sourceDirectory, targetDirectory, sourceOwner, targetOwner, source, target, snapshot, options, charge, project, team, agent, now };
}

test('read-only export preserves exact v2 bytes and refuses missing directories, foreign owners and links', async t => {
  const f = await fixture(t); await f.charge(f.source);
  const before = await readFile(join(f.sourceDirectory, 'ledger.json'));
  const value = await f.snapshot();
  assert.equal(value.ledgerRaw, before.toString('utf8')); assert.equal(value.ledgerSha256, sha(before));
  assert.deepEqual(await readFile(join(f.sourceDirectory, 'ledger.json')), before);
  await assert.rejects(OperationalModelBudget.exportMigration({ directory: join(f.root, 'missing'), ownerKey: f.sourceOwner }), denied);
  await assert.rejects(lstat(join(f.root, 'missing')), { code: 'ENOENT' });
  await assert.rejects(OperationalModelBudget.exportMigration({ directory: f.sourceDirectory, ownerKey: randomUUID() }), denied);
  const linked = join(f.root, 'linked-ledger'); await link(join(f.sourceDirectory, 'ledger.json'), linked);
  await assert.rejects(f.snapshot(), denied);
});

test('read-only v1 export never migrates the source and still verifies its sequence', async t => {
  const f = await fixture(t); await f.charge(f.source);
  const current = await read(f.sourceDirectory);
  const { teamDailyLimits: _teams, agentDailyLimits: _agents, ...legacy } = current; legacy.version = 1;
  const raw = JSON.stringify(legacy); await writeFile(join(f.sourceDirectory, 'ledger.json'), raw);
  const snapshot = await f.snapshot(); assert.equal(snapshot.ledgerRaw, raw);
  assert.equal(await readFile(join(f.sourceDirectory, 'ledger.json'), 'utf8'), raw);
  await assert.rejects(lstat(join(f.sourceDirectory, 'ledger.v1.original.json')), { code: 'ENOENT' });
  await f.target.importMigration(snapshot, f.options(snapshot)); assert.equal((await f.target.status()).used, 1);
  legacy.starts[0].sequence = 2; await writeFile(join(f.sourceDirectory, 'ledger.json'), JSON.stringify(legacy));
  await assert.rejects(f.snapshot(), denied);
});

test('import preserves target identity/raw baseline and appends source attribution, dates and repeated Run charges', async t => {
  const f = await fixture(t); await f.charge(f.target);
  await f.source.update({ expectedRevision: 0, projectDailyLimits: { [f.project]: 4 }, teamDailyLimits: { [f.team]: 3 }, agentDailyLimits: { [f.agent]: 2 } });
  const run = randomUUID(); await f.charge(f.source, run, true); await f.charge(f.source, run, true);
  const original = await readFile(join(f.targetDirectory, 'ledger.json')), anchor = await readFile(join(f.targetDirectory, 'identity.json'));
  const snapshot = await f.snapshot(), source = await read(f.sourceDirectory);
  const result = await f.target.importMigration(snapshot, f.options(snapshot));
  assert.equal(result.appended, 2); assert.equal(result.totalImported, 2);
  assert.deepEqual(await readFile(join(f.targetDirectory, 'identity.json')), anchor);
  assert.deepEqual(await readFile(join(f.targetDirectory, `ledger.import.${result.importId}.before.json`)), original);
  const target = await read(f.targetDirectory);
  assert.equal(target.identity, JSON.parse(original.toString()).identity); assert.equal(target.ownerKey, f.targetOwner);
  assert.deepEqual(target.starts.slice(0, 1), JSON.parse(original.toString()).starts);
  assert.deepEqual(target.starts.slice(1), source.starts.map((entry: object, index: number) => ({ ...entry, sequence: index + 2 })));
  const status = await f.target.status([f.project], { teamIds: [f.team], agentIds: [f.agent] });
  assert.equal(status.used, 3); assert.equal(status.revision, 1); assert.equal(status.projects[0].used, 2);
  assert.equal(status.agentDailyLimits![f.agent], 2);
  assert.equal(await f.target.canStart(f.project, f.team, f.agent), false);
  await assert.rejects(OperationalModelBudget.exportMigration({ directory: f.targetDirectory, ownerKey: f.targetOwner }), denied);
});

test('concurrent exact retries and restart never reapply identity+sequence; a newer source only appends its suffix', async t => {
  const f = await fixture(t); await f.charge(f.source); await f.charge(f.source);
  const snapshot = await f.snapshot();
  const second = await OperationalModelBudget.open({ directory: f.targetDirectory, ownerKey: f.targetOwner, now: f.now });
  const results = await Promise.all([f.target.importMigration(snapshot, f.options(snapshot)), second.importMigration(snapshot, f.options(snapshot))]);
  assert.equal(results.reduce((sum, result) => sum + result.appended, 0), 2);
  assert.equal(results[0].importId, results[1].importId);
  const reopened = await OperationalModelBudget.open({ directory: f.targetDirectory, ownerKey: f.targetOwner, now: f.now });
  await f.charge(reopened); await f.charge(f.source);
  const newer = await f.snapshot(); const result = await reopened.importMigration(newer, f.options(newer));
  assert.equal(result.appended, 1); assert.equal((await reopened.status()).used, 4);
  assert.equal((await reopened.importMigration(newer, f.options(newer, 999))).appended, 0, 'Acknowledged retry does not need the old CAS to remain current');
  assert.equal((await read(f.targetDirectory)).usageImports.length, 2);
});

test('source prefix edits and truncation are rejected even with a new valid raw hash', async t => {
  const f = await fixture(t); await f.charge(f.source); await f.charge(f.source);
  const first = await f.snapshot(); await f.target.importMigration(first, f.options(first));
  const originalTarget = await readFile(join(f.targetDirectory, 'ledger.json'));
  const source = await read(f.sourceDirectory); source.starts[0].reason = 'Changed after export';
  await writeFile(join(f.sourceDirectory, 'ledger.json'), JSON.stringify(source));
  const changed = await f.snapshot(); await assert.rejects(f.target.importMigration(changed, f.options(changed)), denied);
  source.starts = source.starts.slice(0, 1); await writeFile(join(f.sourceDirectory, 'ledger.json'), JSON.stringify(source));
  const truncated = await f.snapshot(); await assert.rejects(f.target.importMigration(truncated, f.options(truncated)), denied);
  assert.deepEqual(await readFile(join(f.targetDirectory, 'ledger.json')), originalTarget);
});

test('hash, owner, stale CAS and conflicting policies fail before modifying target files', async t => {
  const f = await fixture(t); await f.charge(f.source);
  const snapshot = await f.snapshot(), before = await readFile(join(f.targetDirectory, 'ledger.json'));
  await assert.rejects(f.target.importMigration(snapshot, { ...f.options(snapshot), sourceOwnerKey: randomUUID() }), denied);
  await assert.rejects(f.target.importMigration(snapshot, { ...f.options(snapshot), sourceLedgerSha256: '0'.repeat(64) }), denied);
  await assert.rejects(f.target.importMigration(snapshot, f.options(snapshot, 1)), denied);
  await f.source.update({ expectedRevision: 0, dailyLimit: 500 });
  const conflict = await f.snapshot(); await assert.rejects(f.target.importMigration(conflict, f.options(conflict)), denied);
  assert.deepEqual(await readFile(join(f.targetDirectory, 'ledger.json')), before);
  assert.ok(!(await readdir(f.targetDirectory)).some(name => name.startsWith('ledger.import.')));
  await f.target.update({ expectedRevision: 0, dailyLimit: 500, teamDailyLimits: { [f.team]: 1 } });
  await f.source.update({ expectedRevision: 1, teamDailyLimits: { [f.team]: 2 } });
  const scoped = await f.snapshot(); await assert.rejects(f.target.importMigration(scoped, f.options(scoped, 1)), denied);
  assert.equal((await f.target.status()).dailyLimit, 500);
});

test('restart completes a journaled import before admitting any later reservation, without double charging', async t => {
  const f = await fixture(t); await f.charge(f.target); await f.charge(f.source);
  const snapshot = await f.snapshot(), result = await f.target.importMigration(snapshot, f.options(snapshot));
  const committed = await readFile(join(f.targetDirectory, 'ledger.json'));
  const before = await readFile(join(f.targetDirectory, `ledger.import.${result.importId}.before.json`));
  // Crash window after durable intent, before atomic ledger replacement.
  await writeFile(join(f.targetDirectory, 'ledger.json'), before);
  const reopened = await OperationalModelBudget.open({ directory: f.targetDirectory, ownerKey: f.targetOwner, now: f.now });
  assert.deepEqual(await readFile(join(f.targetDirectory, 'ledger.json')), committed);
  assert.equal((await reopened.importMigration(snapshot, f.options(snapshot))).appended, 0);
  await f.charge(reopened); assert.equal((await reopened.status()).used, 3);
});

test('missing, modified or linked import evidence blocks reads and starts; exact restoration permits retry', async t => {
  const f = await fixture(t); await f.charge(f.source);
  const snapshot = await f.snapshot(), result = await f.target.importMigration(snapshot, f.options(snapshot));
  const path = join(f.targetDirectory, `ledger.import.${result.importId}.source.json`), saved = await readFile(path);
  await rename(path, `${path}.preserved`);
  await assert.rejects(f.target.status(), denied); await assert.rejects(f.charge(f.target), denied);
  await writeFile(path, '{broken'); await assert.rejects(f.target.status());
  await writeFile(path, saved); assert.equal((await f.target.status()).used, 1);
  const journalPath = join(f.targetDirectory, 'ledger.import.pending.json'), journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.afterLedgerSha256 = '0'.repeat(64); await writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(f.target.status(), denied);
});

test('read-only source path redirection is rejected without reading adopted files', async t => {
  const f = await fixture(t), redirected = join(f.root, 'redirected');
  try { await symlink(f.sourceDirectory, redirected, 'junction'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Junction creation not permitted'); throw error; }
  await assert.rejects(OperationalModelBudget.exportMigration({ directory: redirected, ownerKey: f.sourceOwner }), denied);
  const empty = join(f.root, 'empty'); await mkdir(empty);
  await assert.rejects(OperationalModelBudget.exportMigration({ directory: empty, ownerKey: f.sourceOwner }), denied);
  assert.deepEqual(await readdir(empty), []);
});

test('explicit approved global policy is committed with usage and its source/target decision survives retry and restart', async t => {
  const f = await fixture(t); await f.charge(f.target); await f.charge(f.source);
  await f.source.update({ expectedRevision: 0, dailyLimit: 500, teamDailyLimits: { [f.team]: 4 } });
  const snapshot = await f.snapshot(), options = { ...f.options(snapshot), approvedDailyLimit: 200, expectedSourceDailyLimit: 500 };
  await assert.rejects(f.target.importMigration(snapshot, f.options(snapshot)), denied);
  await assert.rejects(f.target.importMigration(snapshot, { ...options, expectedSourceDailyLimit: 100 }), denied);
  await assert.rejects(f.target.importMigration(snapshot, { ...f.options(snapshot), approvedDailyLimit: 200 }), denied);
  const result = await f.target.importMigration(snapshot, options);
  const status = await f.target.status(); assert.equal(status.dailyLimit, 200); assert.equal(status.used, 2); assert.equal(status.revision, 1);
  const target = await read(f.targetDirectory); assert.equal(target.changes.at(-1).dailyLimit, 200);
  const receipt = JSON.parse(await readFile(join(f.targetDirectory, `ledger.import.${result.importId}.receipt.json`), 'utf8'));
  assert.deepEqual(receipt.policyDecision, { dailyLimit: 200, sourceDailyLimit: 500, targetDailyLimit: 100, expectedRevision: 0 });
  const original = JSON.parse(await readFile(join(f.targetDirectory, `ledger.import.${result.importId}.before.json`), 'utf8'));
  assert.equal(original.dailyLimit, 100); assert.equal((await read(f.sourceDirectory)).dailyLimit, 500);
  const reopened = await OperationalModelBudget.open({ directory: f.targetDirectory, ownerKey: f.targetOwner, now: f.now });
  assert.equal((await reopened.importMigration(snapshot, options)).appended, 0);
  await assert.rejects(reopened.importMigration(snapshot, { ...options, approvedDailyLimit: 300 }), denied);
  await assert.rejects(reopened.importMigration(snapshot, f.options(snapshot)), denied);
});

test('explicit global approval does not relax overlapping scoped policies', async t => {
  const f = await fixture(t);
  await f.source.update({ expectedRevision: 0, dailyLimit: 500, agentDailyLimits: { [f.agent]: 3 } });
  await f.target.update({ expectedRevision: 0, agentDailyLimits: { [f.agent]: 1 } });
  const snapshot = await f.snapshot(), before = await readFile(join(f.targetDirectory, 'ledger.json'));
  await assert.rejects(f.target.importMigration(snapshot, { ...f.options(snapshot, 1), approvedDailyLimit: 200, expectedSourceDailyLimit: 500 }), denied);
  assert.deepEqual(await readFile(join(f.targetDirectory, 'ledger.json')), before);
});

test('journal before receipt publication recovers the exact approved transaction, and loss of intent fails closed', async t => {
  const f = await fixture(t); await f.charge(f.source);
  await f.source.update({ expectedRevision: 0, dailyLimit: 500 });
  const snapshot = await f.snapshot(), options = { ...f.options(snapshot), approvedDailyLimit: 200, expectedSourceDailyLimit: 500 };
  const result = await f.target.importMigration(snapshot, options);
  const after = await readFile(join(f.targetDirectory, 'ledger.json'));
  const receiptPath = join(f.targetDirectory, `ledger.import.${result.importId}.receipt.json`);
  const receipt = await readFile(receiptPath);
  await rename(receiptPath, `${receiptPath}.preserved`);
  await writeFile(join(f.targetDirectory, 'ledger.json'), await readFile(join(f.targetDirectory, `ledger.import.${result.importId}.before.json`)));
  const restarted = await OperationalModelBudget.open({ directory: f.targetDirectory, ownerKey: f.targetOwner, now: f.now });
  assert.deepEqual(await readFile(receiptPath), receipt); assert.deepEqual(await readFile(join(f.targetDirectory, 'ledger.json')), after);
  assert.equal((await restarted.status()).dailyLimit, 200); assert.equal((await restarted.status()).used, 1);
  await rename(join(f.targetDirectory, 'ledger.import.pending.json'), join(f.targetDirectory, 'preserved-pending.json'));
  await assert.rejects(restarted.status(), denied);
  await writeFile(join(f.targetDirectory, 'ledger.json'), await readFile(join(f.targetDirectory, `ledger.import.${result.importId}.before.json`)));
  await assert.rejects(restarted.status(), denied, 'Old ledger plus missing intent cannot erase evidence of a published import');
});

test('pure capsule validation rejects unknown fields and invalid source sequences without exposing raw data', async t => {
  const f = await fixture(t); await f.charge(f.source);
  const snapshot = await f.snapshot(); assert.deepEqual(validateOperationalBudgetMigration(snapshot), snapshot);
  assert.throws(() => validateOperationalBudgetMigration({ ...snapshot, extra: true }), denied);
  const ledger = JSON.parse(snapshot.ledgerRaw); ledger.starts[0].sequence = 2;
  const ledgerRaw = JSON.stringify(ledger);
  assert.throws(() => validateOperationalBudgetMigration({ ...snapshot, ledgerRaw, ledgerSha256: sha(ledgerRaw) }), error => {
    assert.ok(denied(error)); assert.ok(!(error as Error).message.includes('No real process')); return true;
  });
});
