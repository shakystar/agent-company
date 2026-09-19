import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { startDesktopController } from '../server/desktop-controller.ts';
import { desktopPaths, openDesktopInstallation } from '../server/desktop-paths.ts';
import type { DesktopController, DesktopStart } from '../server/desktop-protocol.ts';
import { desktopRuntimeSettings } from '../server/desktop-runtime-settings.ts';
import { WorkspaceStore } from '../server/store.ts';
import type { Agent, Workspace } from '../shared/types.ts';
import type { DesktopRuntimeSetupStatus } from '../shared/desktop-runtime-setup.ts';
import { createWorkerReleaseManifest, workerSourceFiles } from '../shared/runtime-releases.ts';

const image = `sha256:${'a'.repeat(64)}`;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const selection = { kind: 'wsl-docker' as const, wslExecutable: 'C:\\Windows\\System32\\wsl.exe',
  distro: 'Must-Not-Execute-Fixture', model: 'fixture-model' };

async function resources(root: string, account: boolean) {
  const runtime = join(root, 'runtimes', 'codex'), worker = join(root, 'worker');
  await mkdir(runtime, { recursive: true }); await mkdir(join(worker, 'security'), { recursive: true });
  await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><title>Recovery fixture</title>');
  const sourceHashes: Record<string, string> = {};
  for (const file of workerSourceFiles) {
    const bytes = Buffer.from(`// Inert recovery fixture: ${file}\n`);
    await writeFile(join(worker, file), bytes); sourceHashes[file] = sha(bytes);
  }
  await writeFile(join(worker, 'security', 'codex-userns.json'), '{"fixture":true}');
  const release = createWorkerReleaseManifest({ image, sourceHashes, runtimeBaseHash: 'd'.repeat(64) });
  await writeFile(join(runtime, 'worker.json'), JSON.stringify({ version: 1, provider: 'codex', codexVersion: '0.154.0', target: 'linux-x64',
    engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
    releaseCatalog: { version: 1, active: { image, manifestId: release.id }, manifests: [release] } }));
  // Valid metadata is enough for availability. Archive validation/load must never be reached in these tests.
  const archive = Buffer.from('Inert archive fixture; not a Docker image.');
  await writeFile(join(runtime, 'worker.tar'), archive);
  await writeFile(join(runtime, 'images.json'), JSON.stringify({ version: 1,
    images: [{ kind: 'worker', file: 'worker.tar', image, bytes: archive.length, sha256: sha(archive) }] }));
  if (account) {
    const directory = join(root, 'providers', 'codex'), binary = Buffer.from('Inert non-executable account fixture.');
    const license = Buffer.from('Fixture license\n'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'codex.exe'), binary); await writeFile(join(directory, 'LICENSE'), license);
    await writeFile(join(directory, 'provider.json'), JSON.stringify({ schemaVersion: 1, provider: 'codex', version: '0.154.0',
      target: 'x86_64-pc-windows-msvc', executable: { file: 'codex.exe', bytes: binary.length, sha256: sha(binary) },
      license: { file: 'LICENSE', bytes: license.length, sha256: sha(license) } }));
  }
}

async function fixture(t: TestContext, mode: 'valid' | 'malformed' | 'foreign' | 'out-of-package' = 'valid', account = true) {
  let spawnAttempts = 0;
  // A regression must fail before any OS process starts, even if a path accidentally reaches Docker or account setup.
  const spawn = t.mock.method(childProcess, 'spawn', () => { spawnAttempts++; throw new Error('EXTERNAL_PROCESS_FORBIDDEN_IN_RECOVERY_FIXTURE'); });
  syncBuiltinESMExports();
  const temporary = await mkdtemp(join(tmpdir(), 'ac-recovery-controller-'));
  const paths = desktopPaths(join(temporary, 'resources'), join(temporary, 'appdata'));
  let controller: DesktopController | undefined;
  t.after(async () => {
    try {
      await controller?.close();
      const location = relative(tmpdir(), temporary);
      assert.ok(location.startsWith('ac-recovery-controller-') && !isAbsolute(location) && !location.includes(sep));
      await rm(temporary, { recursive: true });
      assert.equal(spawnAttempts, 0, 'No Docker, Codex or other external process may be attempted');
    } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
  });
  await resources(paths.resourceRoot, account);
  const installation = await openDesktopInstallation(paths), ownerKey = installation.workspaceKey;
  const settings = desktopRuntimeSettings(paths.appDataRoot, ownerKey);
  const agent: Agent = { id: randomUUID(), name: '보존할 에이전트', description: 'Recovery regression', persona: 'Do not execute a model',
    model: 'fixture-model', color: '#738876', allowWeb: false, repositoryIds: [], status: 'idle', generation: 0,
    parentId: null, parentSnapshotId: null, version: 1, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' };
  try {
    await settings.save(selection, 0);
    // A non-initial revision proves restart/recovery never rewrites the saved selection as a new installation.
    await settings.save(selection, 1);
    const store = await WorkspaceStore.open(join(paths.dataDir, 'db'));
    try { await store.change(state => { state.agents.push(agent); }); } finally { await store.close(); }
  } finally { await installation.release(); }
  const markerPath = join(paths.appDataRoot, 'desktop-image-install.pending.json');
  const journal = { version: 1, ownerKey: mode === 'foreign' ? randomUUID() : ownerKey, selection,
    images: [mode === 'out-of-package' ? `sha256:${'f'.repeat(64)}` : image] };
  const marker = Buffer.from(mode === 'malformed' ? '{PRIVATE_BROKEN_PENDING' : JSON.stringify(journal));
  await writeFile(markerPath, marker);
  const sentinel = join(paths.dataDir, 'preserved-fixture.txt'); await writeFile(sentinel, 'Existing installation data must survive.');
  const settingsPath = join(paths.appDataRoot, 'desktop-runtime.json'), configuredPath = join(paths.appDataRoot, 'desktop-runtime-configured.json');
  const storedSettings = await readFile(settingsPath), configured = await readFile(configuredPath);
  const request: DesktopStart = { type: 'start', protocol: 1, nonce: randomBytes(32).toString('base64url'),
    token: randomBytes(32).toString('base64url'), cookieName: `ac_desktop_${randomBytes(16).toString('hex')}`,
    resourceRoot: paths.resourceRoot, appDataRoot: paths.appDataRoot };
  controller = await startDesktopController(request, new AbortController().signal);
  const origin = controller.origin; assert.notEqual(new URL(origin).port, '4310');
  const headers = { authorization: `Bearer ${request.token}` };
  const get = (path: string) => fetch(origin + path, { headers, signal: AbortSignal.timeout(10_000) });
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const status = async (): Promise<DesktopRuntimeSetupStatus> => {
    const response = await get('/api/desktop/runtime-setup'); assert.equal(response.status, 200); return response.json();
  };
  const preserved = async () => {
    assert.deepEqual(await readFile(markerPath), marker); assert.deepEqual(await readFile(settingsPath), storedSettings);
    assert.deepEqual(await readFile(configuredPath), configured); assert.deepEqual(await settings.read(), { revision: 2, selection });
    assert.equal(await readFile(sentinel, 'utf8'), 'Existing installation data must survive.');
    const response = await get('/api/workspace'); assert.equal(response.status, 200);
    const workspace: Workspace = await response.json(); assert.deepEqual(workspace.agents, [agent]); assert.deepEqual(workspace.runs, []);
    assert.equal(workspace.runtime.available, false); assert.equal(workspace.runtime.authenticated, false);
    assert.deepEqual(await readdir(paths.credentialsDir), []);
    assert.equal(spawnAttempts, 0); return workspace;
  };
  return { paths, agent, status, get, post, preserved, async close() { await controller!.close(); controller = undefined; } };
}

test('real controller retains saved settings with a valid pending journal and exposes recovery without activating execution', { timeout: 45_000 }, async t => {
  const f = await fixture(t), status = await f.status();
  assert.equal(status.phase, 'recoveryRequired'); assert.equal(status.available, false);
  assert.equal(status.imageInstallAvailable, false); assert.equal(status.recoveryAvailable, true);
  assert.deepEqual(status.selection, selection); assert.equal(status.recovery, null);
  const account = await (await f.get('/api/desktop/setup')).json();
  assert.equal(account.provider.available, true); assert.equal(account.phase, 'unchecked'); assert.equal(account.executionReady, false);
  for (const operation of ['configure', 'install']) {
    const response = await f.post(`/api/desktop/runtime-setup/${operation}`, { revision: status.revision, selection });
    assert.equal(response.status, 409); assert.match((await response.json()).error, /현재 상태/);
  }
  for (const [operation, extra] of [['check', {}], ['logout', {}], ['login', { method: 'chatgptDeviceCode' }],
    ['login', { method: 'apiKey', apiKey: 'fixture-only-never-used' }]] as const) {
    const response = await f.post(`/api/desktop/setup/${operation}`, { revision: account.revision, ...extra });
    assert.equal(response.status, 409); assert.match((await response.json()).error, /모델의 인증 사용과 정리/);
  }
  assert.equal((await f.post(`/api/agents/${f.agent.id}/runs`, { prompt: 'Must not execute' })).status, 503);
  assert.equal((await f.post('/api/desktop/runtime-setup/recovery/retry', { revision: status.revision })).status, 409, 'Diagnosis is required before replay');
  await f.preserved(); assert.deepEqual(await f.status(), status); await f.close();
});

test('real controller diagnosis rejects damaged, foreign and out-of-package journals without external commands or data changes', { timeout: 90_000 }, async t => {
  for (const mode of ['malformed', 'foreign', 'out-of-package'] as const) await t.test(mode, async sub => {
    const f = await fixture(sub, mode), before = await f.status();
    assert.equal(before.phase, 'recoveryRequired'); assert.equal(before.recoveryAvailable, true); assert.deepEqual(before.selection, selection);
    const response = await f.post('/api/desktop/runtime-setup/recovery/inspect', { revision: before.revision });
    assert.equal(response.status, 200); const failed: DesktopRuntimeSetupStatus = await response.json();
    assert.equal(failed.phase, 'recoveryRequired'); assert.equal(failed.recovery, null); assert.deepEqual(failed.selection, selection);
    assert.equal(failed.error?.code, 'SETUP_RUNTIME_RECOVERY_FAILED'); assert.equal(failed.recoveryAvailable, true);
    assert.ok(!JSON.stringify(failed).includes('PRIVATE')); assert.ok(!JSON.stringify(failed.error).includes(f.paths.appDataRoot));
    assert.equal((await f.post('/api/desktop/runtime-setup/recovery/retry', { revision: failed.revision })).status, 409);
    await f.preserved(); await f.close();
  });
});

test('real controller requires the account provider as well as worker/image metadata before offering recovery', { timeout: 45_000 }, async t => {
  const f = await fixture(t, 'valid', false), status = await f.status();
  assert.equal(status.phase, 'recoveryRequired'); assert.equal(status.recoveryAvailable, false); assert.equal(status.imageInstallAvailable, false);
  assert.deepEqual(status.selection, selection); assert.equal((await (await f.get('/api/desktop/setup')).json()).provider.available, false);
  for (const operation of ['inspect', 'retry']) {
    assert.equal((await f.post(`/api/desktop/runtime-setup/recovery/${operation}`, { revision: status.revision })).status, 409);
  }
  await f.preserved(); await f.close();
});
