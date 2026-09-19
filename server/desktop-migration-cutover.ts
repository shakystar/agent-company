import { dirname, join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { readDesktopProviderFile } from './desktop-provider-files.ts';

export const desktopMigrationCutoverCapability = 'agent-company-offline-cutover-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const cutoverJournalSchema = z.object({ version: z.literal(1), id: z.uuid(),
  phase: z.enum(['validated', 'source-fenced', 'budget-imported', 'generation-activated', 'committed']),
  sourceRoot: z.string(), sourceOwner: z.uuid(), targetRoot: z.string(), targetOwner: z.uuid(),
  generationId: z.uuid(), workspaceKey: z.uuid(), preparationPath: z.string(), preparationSha256: digest,
  payloadManifestPath: z.string(), payloadManifestSha256: digest, entrySha256: digest, controllerSha256: digest,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type CutoverJournal = z.infer<typeof cutoverJournalSchema>;
export type MigrationActivationAuthorization = { journalSha256: string };
export const cutoverJournalPath = (appDataRoot: string) => join(appDataRoot, 'desktop-migration-cutover.json');
export const sourceFencePath = (sourceRoot: string) => join(sourceRoot, 'desktop-migration-source-fence.json');
const fail = () => new Error('DESKTOP_MIGRATION_CUTOVER_REQUIRED');
export async function cutoverDocument(path: string) {
  const file = await readDesktopProviderFile(path, 2 * 1024 ** 2);
  return { value: JSON.parse(file.data.toString('utf8')), sha256: file.pin.sha256 };
}
async function exists(path: string) {
  return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
}
/** A fence is permanent until a separately audited reverse migration. */
export async function assertOperatingMigrationStartup(sourceRoot: string) {
  if (await exists(sourceFencePath(sourceRoot))) throw fail();
}
export async function verifyCutoverFence(journal: CutoverJournal) {
  const fence = await cutoverDocument(sourceFencePath(journal.sourceRoot));
  if (JSON.stringify(fence.value) !== JSON.stringify({ version: 1, cutoverId: journal.id,
    sourceOwner: journal.sourceOwner, targetRoot: journal.targetRoot, targetOwner: journal.targetOwner,
    preparationSha256: journal.preparationSha256 })) throw fail();
}
export async function assertDesktopMigrationStartup(appDataRoot: string, ownerKey: string) {
  const path = cutoverJournalPath(appDataRoot);
  if (!await exists(path)) {
    const layoutPath = join(appDataRoot, 'workspace', 'storage-layout.json');
    if (await exists(layoutPath)) {
      const layout = (await cutoverDocument(layoutPath)).value;
      if (layout.activeId && await exists(join(appDataRoot, 'workspace', 'generations', layout.activeId, 'migration-receipt.json'))) throw fail();
    }
    return;
  }
  const journal = cutoverJournalSchema.parse((await cutoverDocument(path)).value);
  if (journal.phase !== 'committed' || resolve(journal.targetRoot) !== resolve(appDataRoot) || journal.targetOwner !== ownerKey) throw fail();
  await verifyCutoverFence(journal);
  const layout = (await cutoverDocument(join(appDataRoot, 'workspace', 'storage-layout.json'))).value;
  if (layout.ownerKey !== ownerKey || layout.activeId !== journal.generationId
    || !layout.generations?.some((entry: { id: string; workspaceKey: string }) => entry.id === journal.generationId && entry.workspaceKey === journal.workspaceKey)) throw fail();
}
/** Ordinary backup format does not yet preserve historical runtime capsules. */
export async function assertMigrationOrdinaryRestoreSupported(root: string, owner: string) {
  const path = cutoverJournalPath(dirname(root));
  if (!await exists(path)) return;
  const journal = cutoverJournalSchema.parse((await cutoverDocument(path)).value);
  if (join(resolve(journal.targetRoot), 'workspace') === resolve(root) && journal.targetOwner === owner) {
    throw new Error('DESKTOP_MIGRATION_ORDINARY_RESTORE_UNSUPPORTED');
  }
}
/** Not accepted from HTTP. The offline CLI supplies the exact journal snapshot after budget commit. */
export async function verifyMigrationActivationAuthorization(root: string, owner: string, id: string,
  authorization?: MigrationActivationAuthorization) {
  if (!authorization) throw fail();
  const document = await cutoverDocument(cutoverJournalPath(dirname(root)));
  const journal = cutoverJournalSchema.parse(document.value);
  if (document.sha256 !== authorization.journalSha256 || journal.phase !== 'budget-imported'
    || resolve(root) !== join(resolve(journal.targetRoot), 'workspace') || journal.targetOwner !== owner || journal.generationId !== id) throw fail();
  await verifyCutoverFence(journal);
}
