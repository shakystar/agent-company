import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopGitHubRuntime, inspectOperatingGitHub, migrateOperatingGitHub } from '../server/desktop-github.ts';
import { createGitHubRuntime } from '../server/github-runtime.ts';

test('explicit desktop GitHub migration preserves receipts, uncertain operations and source bytes without key or network access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-github-'));
  t.after(() => rm(root, { recursive: true }));
  const sourceRoot = join(root, 'source'), appDataRoot = join(root, 'app'), resourceRoot = join(root, 'resources');
  for (const dir of [sourceRoot, appDataRoot, resourceRoot, join(resourceRoot, 'dist'), join(appDataRoot, 'workspace')]) await mkdir(dir);
  await writeFile(join(resourceRoot, 'dist', 'index.html'), 'fixture');
  const sourceOwner = randomUUID(), ownerKey = randomUUID(), generationId = randomUUID(), workspaceKey = randomUUID(), id = randomUUID();
  await writeFile(join(appDataRoot, 'desktop-installation.json'), JSON.stringify({ version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: ownerKey }));
  await writeFile(join(appDataRoot, 'workspace', 'workspace-id'), ownerKey);
  await writeFile(join(appDataRoot, 'workspace', 'storage-layout.json'), JSON.stringify({ ownerKey, activeId: generationId, generations: [{ id: generationId, workspaceKey }] }));
  const preparationSha256 = 'a'.repeat(64);
  await writeFile(join(sourceRoot, 'desktop-migration-source-fence.json'), JSON.stringify({ version: 1, cutoverId: id, sourceOwner,
    targetRoot: appDataRoot, targetOwner: ownerKey, preparationSha256 }));
  await writeFile(join(appDataRoot, 'desktop-migration-cutover.json'), JSON.stringify({ version: 1, id, phase: 'committed', sourceRoot, sourceOwner,
    targetRoot: appDataRoot, targetOwner: ownerKey, generationId, workspaceKey, preparationPath: join(root, 'prep.json'), preparationSha256,
    payloadManifestPath: join(root, 'payload.json'), payloadManifestSha256: 'b'.repeat(64), entrySha256: 'c'.repeat(64), controllerSha256: 'd'.repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const config = { version: 1, ownerKey, appId: '123', installationId: '456', privateKeyFile: join(root, 'never-read-key.pem'), repositories: ['test/repository'] };
  const runtime = await createGitHubRuntime({ rootDir: sourceRoot, ownerKey: sourceOwner, env: {
    AGENT_GITHUB_APP_ID: config.appId, AGENT_GITHUB_INSTALLATION_ID: config.installationId,
    AGENT_GITHUB_PRIVATE_KEY_FILE: config.privateKeyFile, AGENT_GITHUB_REPOSITORIES: 'test/repository' },
    authOptions: { fetch: async () => { throw new Error('network forbidden'); }, readFile: async () => { throw new Error('key forbidden'); } } });
  const input = { key: 'prior-publish', runId: randomUUID(), agentId: randomUUID(), connectionId: randomUUID(), repository: 'test/repository', operation: 'publish', fingerprint: 'e'.repeat(64) };
  await runtime.journal.execute(input, async () => ({ sha: 'commit', branch: 'original-branch' }));
  await assert.rejects(runtime.journal.execute({ ...input, key: 'uncertain' }, async () => { throw new Error('unknown outcome'); }));
  const before = await inspectOperatingGitHub(sourceRoot);
  const configPath = join(root, 'config.json'), configBytes = JSON.stringify(config);
  await writeFile(configPath, configBytes);
  const options = { sourceRoot, appDataRoot, resourceRoot, configPath,
    configSha256: createHash('sha256').update(configBytes).digest('hex'), sourceSha256: before.sha256 };
  await assert.rejects(migrateOperatingGitHub({ ...options, sourceSha256: '0'.repeat(64) }));
  const migrated = await migrateOperatingGitHub(options);
  assert.equal(migrated.records, 2); assert.equal(migrated.networkRequests, 0); assert.equal(migrated.privateKeyCopied, false);
  assert.equal((await inspectOperatingGitHub(sourceRoot)).sha256, before.sha256);
  const target = await createDesktopGitHubRuntime(appDataRoot, ownerKey);
  assert.equal(target?.status().writable, true);
  assert.deepEqual(await target!.journal.execute(input, async () => { throw new Error('completed receipt must prevent action'); }), { sha: 'commit', branch: 'original-branch' });
  const uncertainPath = createHash('sha256').update('uncertain').digest('hex') + '.json';
  const uncertain = JSON.parse(await readFile(join(appDataRoot, 'workspace', 'github-operations', uncertainPath), 'utf8'));
  assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.attempts, 1); assert.equal(uncertain.ownerKey, ownerKey);
  assert.equal(uncertain.identity, before.anchor.journalIdentity);
  await assert.rejects(target!.journal.execute({ ...input, fingerprint: 'f'.repeat(64) }, async () => null));
  assert.equal((await migrateOperatingGitHub(options)).journalIdentity, before.anchor.journalIdentity, 'exact retry is idempotent before new writes');
  await assert.rejects(createDesktopGitHubRuntime(appDataRoot, randomUUID()));
});

test('an unconfigured desktop ignores ambient GitHub environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-github-empty-')); t.after(() => rm(root, { recursive: true }));
  assert.equal(await createDesktopGitHubRuntime(root, randomUUID()), undefined);
});
