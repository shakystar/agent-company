import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { assertDesktopMigrationStartup, assertMigrationOrdinaryRestoreSupported, assertOperatingMigrationStartup,
  cutoverDocument, cutoverJournalPath, sourceFencePath, verifyMigrationActivationAuthorization, type CutoverJournal } from '../server/desktop-migration-cutover.ts';

test('cutover guards fail closed for interrupted journals, invalid authorization, source reuse and unsupported ordinary restore', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-cutover-guards-'));
  t.after(async () => { assert.ok(relative(resolve(tmpdir()), dir).startsWith('ac-cutover-guards-')); await rm(dir, { recursive: true }); });
  const sourceRoot = join(dir, 'source'), targetRoot = join(dir, 'app'), root = join(targetRoot, 'workspace');
  await mkdir(sourceRoot); await mkdir(root, { recursive: true });
  const owner = randomUUID(), id = randomUUID(), workspaceKey = randomUUID();
  await assertDesktopMigrationStartup(targetRoot, owner); await assertOperatingMigrationStartup(sourceRoot);
  await assertMigrationOrdinaryRestoreSupported(root, owner);
  const journal: CutoverJournal = { version: 1, id: randomUUID(), phase: 'validated', sourceRoot, sourceOwner: randomUUID(),
    targetRoot, targetOwner: owner, generationId: id, workspaceKey, preparationPath: join(dir, 'receipt.json'), preparationSha256: 'a'.repeat(64),
    payloadManifestPath: join(dir, 'payload.json'), payloadManifestSha256: 'b'.repeat(64), entrySha256: 'c'.repeat(64), controllerSha256: 'd'.repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const save = async () => writeFile(cutoverJournalPath(targetRoot), JSON.stringify(journal));
  await save(); await assert.rejects(assertDesktopMigrationStartup(targetRoot, owner), /CUTOVER_REQUIRED/);
  await assert.rejects(verifyMigrationActivationAuthorization(root, owner, id), /CUTOVER_REQUIRED/);
  journal.phase = 'budget-imported'; await save();
  let authorization = { journalSha256: (await cutoverDocument(cutoverJournalPath(targetRoot))).sha256 };
  await assert.rejects(verifyMigrationActivationAuthorization(root, owner, id, authorization), { code: 'ENOENT' });
  await writeFile(sourceFencePath(sourceRoot), JSON.stringify({ version: 1, cutoverId: journal.id, sourceOwner: journal.sourceOwner,
    targetRoot, targetOwner: owner, preparationSha256: journal.preparationSha256 }));
  await assert.rejects(assertOperatingMigrationStartup(sourceRoot), /CUTOVER_REQUIRED/);
  await verifyMigrationActivationAuthorization(root, owner, id, authorization);
  await assert.rejects(verifyMigrationActivationAuthorization(root, owner, randomUUID(), authorization), /CUTOVER_REQUIRED/);
  await assert.rejects(verifyMigrationActivationAuthorization(root, owner, id, { journalSha256: '0'.repeat(64) }), /CUTOVER_REQUIRED/);
  journal.phase = 'committed'; await save();
  await writeFile(join(root, 'storage-layout.json'), JSON.stringify({ version: 1, ownerKey: owner, activeId: id, generations: [{ id, workspaceKey }], restores: [] }));
  await assertDesktopMigrationStartup(targetRoot, owner);
  await assert.rejects(assertMigrationOrdinaryRestoreSupported(root, owner), /ORDINARY_RESTORE_UNSUPPORTED/);
  await assert.rejects(assertDesktopMigrationStartup(targetRoot, randomUUID()), /CUTOVER_REQUIRED/);
  authorization = { journalSha256: (await cutoverDocument(cutoverJournalPath(targetRoot))).sha256 };
  await assert.rejects(verifyMigrationActivationAuthorization(root, owner, id, authorization), /CUTOVER_REQUIRED/);
});
