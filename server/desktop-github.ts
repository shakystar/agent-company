import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { createGitHubRuntime } from './github-runtime.ts';
import { GitHubAppAuth, readGitHubConfig } from './github-auth.ts';
import { identitySchema, recordSchema } from './github-journal.ts';
import { readDesktopProviderFile } from './desktop-provider-files.ts';
import { desktopPaths, openDesktopInstallation } from './desktop-paths.ts';
import { assertDesktopMigrationStartup, cutoverDocument, cutoverJournalPath, cutoverJournalSchema } from './desktop-migration-cutover.ts';
import { existingStorageDirectory } from './storage.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const anchorSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(), journalIdentity: z.uuid(),
  appId: z.string().regex(/^[1-9][0-9]*$/), installationId: z.string().regex(/^[1-9][0-9]*$/) }).strict();
export const desktopGitHubConfigSchema = z.object({ version: z.literal(1), ownerKey: z.uuid(),
  appId: z.string().regex(/^[1-9][0-9]*$/), installationId: z.string().regex(/^[1-9][0-9]*$/),
  privateKeyFile: z.string().refine(isAbsolute), repositories: z.array(z.string()).min(1).max(500) }).strict();
type Config = z.infer<typeof desktopGitHubConfigSchema>;
const fail = () => new Error('DESKTOP_GITHUB_MIGRATION_INVALID');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function exists(path: string) { return lstat(path).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }); }
function env(config: Config) {
  return { AGENT_GITHUB_APP_ID: config.appId, AGENT_GITHUB_INSTALLATION_ID: config.installationId,
    AGENT_GITHUB_PRIVATE_KEY_FILE: config.privateKeyFile, AGENT_GITHUB_REPOSITORIES: config.repositories.join(',') };
}
/** Explicit per-installation configuration; never inherits .env or process.env. No key is read here. */
export async function createDesktopGitHubRuntime(appDataRoot: string, ownerKey: string) {
  const path = join(appDataRoot, 'desktop-github.json');
  if (!await exists(path)) return undefined;
  const config = desktopGitHubConfigSchema.parse((await cutoverDocument(path)).value);
  if (config.ownerKey !== ownerKey) throw fail();
  return createGitHubRuntime({ rootDir: join(appDataRoot, 'workspace'), ownerKey, env: env(config) });
}
/** Pure regular-file snapshot: no DB, key, network, or journal initialization. */
export async function inspectOperatingGitHub(root: string) {
  await existingStorageDirectory(root); await existingStorageDirectory(join(root, 'github-operations'));
  const paths = ['github-runtime.json', ...(await readdir(join(root, 'github-operations'))).sort().map(name => {
    if (name !== 'identity.json' && !/^[a-f0-9]{64}\.json$/.test(name)) throw fail();
    return `github-operations/${name}`;
  })];
  if (paths.length > 10001) throw fail();
  const files: { path: string; bytes: Buffer; sha256: string }[] = [];
  let total = 0;
  for (const path of paths) {
    const file = await readDesktopProviderFile(join(root, path), path.endsWith('identity.json') || path === 'github-runtime.json' ? 4096 : 2 * 1024 ** 2);
    total += file.data.length; if (total > 128 * 1024 ** 2) throw fail();
    files.push({ path, bytes: file.data, sha256: file.pin.sha256 });
  }
  const anchor = anchorSchema.parse(JSON.parse(files[0].bytes.toString('utf8')));
  const identityFile = files.find(file => file.path === 'github-operations/identity.json'); if (!identityFile) throw fail();
  const identity = identitySchema.parse(JSON.parse(identityFile.bytes.toString('utf8')));
  if (identity.ownerKey !== anchor.ownerKey || identity.identity !== anchor.journalIdentity) throw fail();
  for (const file of files.filter(file => file.path !== 'github-runtime.json' && file !== identityFile)) {
    const receipt = recordSchema.parse(JSON.parse(file.bytes.toString('utf8')));
    if (receipt.ownerKey !== anchor.ownerKey || receipt.identity !== anchor.journalIdentity
      || file.path !== `github-operations/${receipt.keyHash}.json`) throw fail();
  }
  return { anchor, files, sha256: hash(JSON.stringify(files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes: bytes.length })))) };
}
async function preserve(path: string, bytes: Buffer) {
  if (await exists(path)) {
    const current = await readDesktopProviderFile(path, 2 * 1024 ** 2);
    if (!current.data.equals(bytes)) throw fail(); return;
  }
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
/** Source must already be fenced by completed workspace cutover. All metadata,
 * uncertainty and operation identities survive. This does not restore grants. */
export async function migrateOperatingGitHub(options: { sourceRoot: string; appDataRoot: string; resourceRoot: string;
  configPath: string; configSha256: string; sourceSha256: string }) {
  digest.parse(options.configSha256); digest.parse(options.sourceSha256);
  const document = await cutoverDocument(options.configPath); if (document.sha256 !== options.configSha256) throw fail();
  const config = desktopGitHubConfigSchema.parse(document.value), paths = desktopPaths(options.resourceRoot, options.appDataRoot);
  if (!new GitHubAppAuth(readGitHubConfig(env(config), { forbiddenRoots: [paths.appDataRoot, paths.resourceRoot, resolve(options.sourceRoot)] })).status().configured) throw fail();
  const releaseSource = await lockfile.lock(options.sourceRoot, { lockfilePath: join(options.sourceRoot, 'controller.lock'), stale: 30000, update: 10000, retries: 0 });
  let installation: Awaited<ReturnType<typeof openDesktopInstallation>> | undefined;
  try {
    installation = await openDesktopInstallation(paths);
    if (installation.workspaceKey !== config.ownerKey) throw fail();
    await assertDesktopMigrationStartup(paths.appDataRoot, config.ownerKey);
    const cutover = cutoverJournalSchema.parse((await cutoverDocument(cutoverJournalPath(paths.appDataRoot))).value);
    if (resolve(cutover.sourceRoot) !== resolve(options.sourceRoot)) throw fail();
    const source = await inspectOperatingGitHub(options.sourceRoot);
    if (source.sha256 !== options.sourceSha256 || source.anchor.ownerKey !== cutover.sourceOwner
      || source.anchor.appId !== config.appId || source.anchor.installationId !== config.installationId) throw fail();
    const markerPath = join(paths.appDataRoot, 'desktop-github-migration.json');
    const marker = Buffer.from(JSON.stringify({ version: 1, sourceSha256: source.sha256, sourceOwner: source.anchor.ownerKey,
      ownerKey: config.ownerKey, journalIdentity: source.anchor.journalIdentity, configSha256: options.configSha256, cutoverId: cutover.id }));
    if (!await exists(markerPath) && (await exists(join(paths.dataDir, 'github-runtime.json')) || await exists(join(paths.dataDir, 'github-operations'))
      || await exists(join(paths.appDataRoot, 'desktop-github.json')))) throw fail();
    await preserve(markerPath, marker);
    const evidence = join(paths.appDataRoot, 'github-migration-source');
    if (!await exists(evidence)) await mkdir(evidence, { mode: 0o700 });
    await existingStorageDirectory(evidence);
    for (const directory of [join(evidence, 'github-operations'), join(paths.dataDir, 'github-operations')]) {
      if (!await exists(directory)) await mkdir(directory, { mode: 0o700 }); await existingStorageDirectory(directory);
    }
    for (const file of source.files) {
      await preserve(join(evidence, file.path), file.bytes);
      const rebound = Buffer.from(JSON.stringify({ ...JSON.parse(file.bytes.toString('utf8')), ownerKey: config.ownerKey }));
      await preserve(join(paths.dataDir, file.path), rebound);
    }
    if ((await inspectOperatingGitHub(options.sourceRoot)).sha256 !== options.sourceSha256) throw fail();
    const copied = await inspectOperatingGitHub(paths.dataDir);
    if (copied.anchor.journalIdentity !== source.anchor.journalIdentity || copied.files.length !== source.files.length) throw fail();
    await preserve(join(paths.appDataRoot, 'desktop-github.json'), Buffer.from(JSON.stringify(config)));
    const runtime = await createDesktopGitHubRuntime(paths.appDataRoot, config.ownerKey);
    if (!runtime?.status().writable) throw fail();
    return { sourceSha256: source.sha256, journalIdentity: source.anchor.journalIdentity, records: source.files.length - 2,
      configured: true, grantsRestored: false, networkRequests: 0, privateKeyCopied: false };
  } finally { try { await installation?.release(); } finally { await releaseSource(); } }
}
