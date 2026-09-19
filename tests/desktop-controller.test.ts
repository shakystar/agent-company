import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopStart } from '../server/desktop-protocol.ts';

type Event = { type: string; protocol: number; nonce?: string; origin?: string; workspaceKey?: string; code?: string;
  requestId?: string; updateId?: string; status?: { phase: string; activeRunCount: number; pendingRunCount: number } };
const waitFor = async (predicate: () => boolean, seconds = 30) => {
  const end = Date.now() + seconds * 1000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'Desktop child did not reach the expected state');
};

test('real desktop child isolates data and environment, binds its own port, preserves writes and closes on parent EOF', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-child-'));
  const resourceRoot = join(root, '설치 자원'), appDataRoot = join(root, '사용자 데이터'), foreign = join(root, 'foreign'), cwd = join(root, '작업 위치');
  await mkdir(join(resourceRoot, 'dist'), { recursive: true }); await mkdir(cwd); await mkdir(foreign);
  await writeFile(join(resourceRoot, 'dist', 'index.html'), '<!doctype html><title>Packaged UI fixture</title>');
  await writeFile(join(cwd, '.env'), `AGENT_DATA_DIR=${foreign.replaceAll('\\', '/')}\nAGENT_AUTH=codex\n`);
  await writeFile(join(foreign, 'preserved'), 'existing developer data');
  const children: Array<ReturnType<typeof launch>> = [];
  function launch() {
    const request: DesktopStart = { type: 'start', protocol: 1, nonce: randomBytes(32).toString('base64url'),
      token: randomBytes(32).toString('base64url'), cookieName: `ac_desktop_${randomBytes(16).toString('hex')}`, resourceRoot, appDataRoot };
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
      resolve('server/desktop-entry.ts')], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_DATA_DIR: foreign, AGENT_BACKUP_DIR: foreign, PORT: '4310',
        AGENT_AUTH: 'codex', AGENT_CODEX_AUTH_FILE: join(foreign, 'auth.json'), OPENAI_API_KEY: 'desktop-fixture-only',
        AGENT_CPU_BUDGET: '999', AGENT_RUNTIME: 'invalid-inherited-config' } });
    let buffer = '', stdout = '', stderr = '', exited = false;
    const events: Event[] = [];
    const exit = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject); child.once('exit', code => { exited = true; resolveExit(code); });
    });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk; buffer += chunk; let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { events.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return { child, request, events, exit, get exited() { return exited; }, get output() { return stdout + stderr; } };
  }
  t.after(async () => {
    for (const item of children) if (!item.exited) item.child.stdin.end();
    await Promise.all(children.map(item => item.exit));
    await rm(root, { recursive: true, force: true });
  });
  const first = launch(); children.push(first);
  await waitFor(() => first.events.some(event => event.type === 'ready') || first.exited);
  const ready = first.events.find(event => event.type === 'ready');
  assert.ok(ready?.origin, first.output); assert.equal(ready.protocol, 1); assert.equal(ready.nonce, first.request.nonce);
  assert.notEqual(new URL(ready.origin).port, '4310');
  const headers = { authorization: `Bearer ${first.request.token}` };
  for (const path of ['/', '/index.html', '/api/health', '/api/workspace', '/api/files/anything']) {
    assert.equal((await fetch(ready.origin + path)).status, 403, path);
  }
  assert.equal((await fetch(ready.origin + '/', { headers: { cookie: `${first.request.cookieName}=${first.request.token}` } })).status, 200);
  assert.equal((await fetch(ready.origin + '/api/workspace', { headers: { ...headers, origin: 'http://127.0.0.1:5173' } })).status, 403);
  const workspace = await (await fetch(ready.origin + '/api/workspace', { headers })).json();
  assert.equal(workspace.runtime.available, false); assert.equal(workspace.runtime.authenticated, false);
  assert.equal(workspace.agents.length, 0); assert.equal(workspace.runs.length, 0);
  const created = await fetch(ready.origin + '/api/agents', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '설치형 보존 확인', persona: '기동 및 보존 검사', model: 'gpt-6-astra' }) });
  assert.equal(created.status, 201, await created.clone().text());
  const agent = await created.json();
  async function update(type: 'prepare-update' | 'update-status' | 'cancel-update', updateId: string) {
    const requestId = randomUUID();
    first.child.stdin.write(`${JSON.stringify({ type, protocol: 1, nonce: first.request.nonce, requestId, updateId })}\n`);
    await waitFor(() => first.events.some(event => event.requestId === requestId) || first.exited);
    const reply = first.events.find(event => event.requestId === requestId);
    assert.ok(reply, first.output); assert.equal(reply.type, 'update-status');
    assert.equal(reply.nonce, first.request.nonce); assert.equal(reply.updateId, updateId); return reply;
  }
  const firstUpdate = randomUUID();
  assert.ok((await update('prepare-update', firstUpdate)).status);
  const manualResume = await fetch(ready.origin + '/api/deployment/resume', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(manualResume.status, 409);
  assert.equal((await update('cancel-update', randomUUID())).code, 'DESKTOP_UPDATE_PREPARATION_FAILED');
  assert.equal((await update('cancel-update', firstUpdate)).status?.phase, 'running');
  const installedUpdate = randomUUID();
  assert.ok((await update('prepare-update', installedUpdate)).status);
  for (let attempts = 0; ; attempts++) {
    if ((await update('update-status', installedUpdate)).status?.phase === 'ready') break;
    assert.ok(attempts < 100, 'Update preparation did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const duplicate = launch(); children.push(duplicate);
  await waitFor(() => duplicate.exited);
  assert.equal(await duplicate.exit, 1); assert.ok(!duplicate.events.some(event => event.type === 'ready'));
  assert.equal((await fetch(ready.origin + '/api/health', { headers })).status, 200);
  first.child.stdin.write(`${JSON.stringify({ type: 'shutdown', protocol: 1, nonce: first.request.nonce })}\n`);
  assert.equal(await first.exit, 0); assert.equal(first.events.at(-1)?.type, 'stopped');
  assert.ok(!(await readdir(appDataRoot)).includes('desktop.lock'));
  assert.ok(!(await readdir(join(appDataRoot, 'workspace'))).includes('controller.lock'));
  const restarted = launch(); children.push(restarted);
  await waitFor(() => restarted.events.some(event => event.type === 'ready') || restarted.exited);
  const resumed = restarted.events.find(event => event.type === 'ready'); assert.ok(resumed?.origin, restarted.output);
  assert.equal(resumed.workspaceKey, ready.workspaceKey);
  assert.equal((await fetch(resumed.origin + '/api/health', { headers })).status, 403, 'previous launch token must expire');
  const saved = await (await fetch(resumed.origin + '/api/workspace', { headers: { authorization: `Bearer ${restarted.request.token}` } })).json();
  assert.equal(saved.agents.length, 1); assert.equal(saved.agents[0].id, agent.id); assert.equal(saved.runs.length, 0);
  assert.notEqual(saved.deployment.phase, 'running', 'An app update shutdown must preserve the hold on restart');
  const resumeAfterRestart = await fetch(resumed.origin + '/api/deployment/resume', {
    method: 'POST', headers: { authorization: `Bearer ${restarted.request.token}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(resumeAfterRestart.status, 200, 'A previous native process must not retain update authority');
  restarted.child.stdin.end(); assert.equal(await restarted.exit, 0); assert.equal(restarted.events.at(-1)?.type, 'stopped');
  const pendingPath = join(appDataRoot, 'desktop-image-install.pending.json');
  await writeFile(pendingPath, 'interrupted image installation fixture');
  const interrupted = launch(); children.push(interrupted);
  await waitFor(() => interrupted.events.some(event => event.type === 'ready') || interrupted.exited);
  const interruptedReady = interrupted.events.find(event => event.type === 'ready'); assert.ok(interruptedReady?.origin, interrupted.output);
  const interruptedHeaders = { authorization: `Bearer ${interrupted.request.token}` };
  const blocked = await (await fetch(interruptedReady.origin + '/api/desktop/runtime-setup', { headers: interruptedHeaders })).json();
  assert.equal(blocked.phase, 'recoveryRequired'); assert.equal(blocked.imageInstallAvailable, false);
  const interruptedWorkspace = await (await fetch(interruptedReady.origin + '/api/workspace', { headers: interruptedHeaders })).json();
  assert.equal(interruptedWorkspace.agents[0].id, agent.id); assert.equal(interruptedWorkspace.runtime.available, false);
  const attempted = await fetch(interruptedReady.origin + '/api/desktop/runtime-setup/install', {
    method: 'POST', headers: { ...interruptedHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ revision: blocked.revision,
      selection: { kind: 'wsl-docker', wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Fixture-Distro', model: 'fixture' } }),
  });
  assert.equal(attempted.status, 409);
  assert.equal(await readFile(pendingPath, 'utf8'), 'interrupted image installation fixture');
  interrupted.child.stdin.end(); assert.equal(await interrupted.exit, 0);
  // This exact fixture marker is owned by this test; normal runtime never removes an uncertain attempt automatically.
  await rm(pendingPath);
  await writeFile(join(appDataRoot, 'desktop-runtime.json'), 'null');
  const damaged = launch(); children.push(damaged);
  await waitFor(() => damaged.events.some(event => event.type === 'ready') || damaged.exited);
  const damagedReady = damaged.events.find(event => event.type === 'ready'); assert.ok(damagedReady?.origin, damaged.output);
  const preserved = await (await fetch(damagedReady.origin + '/api/workspace', {
    headers: { authorization: `Bearer ${damaged.request.token}` },
  })).json();
  assert.equal(preserved.agents[0].id, agent.id); assert.equal(preserved.runs.length, 0);
  assert.equal(preserved.runtime.available, false); assert.equal(preserved.runtime.authenticated, false);
  assert.match(preserved.runtime.message, /저장된 실행 환경/);
  assert.equal(await readFile(join(appDataRoot, 'desktop-runtime.json'), 'utf8'), 'null');
  damaged.child.stdin.end(); assert.equal(await damaged.exit, 0);
  await writeFile(join(appDataRoot, 'desktop-runtime-configured.json'), JSON.stringify({ version: 1,
    product: 'agent-company-desktop-runtime-configured', workspaceKey: ready.workspaceKey }));
  await rm(join(appDataRoot, 'desktop-runtime.json'));
  const missing = launch(); children.push(missing);
  await waitFor(() => missing.events.some(event => event.type === 'ready') || missing.exited);
  const missingReady = missing.events.find(event => event.type === 'ready'); assert.ok(missingReady?.origin, missing.output);
  const stillPreserved = await (await fetch(missingReady.origin + '/api/workspace', {
    headers: { authorization: `Bearer ${missing.request.token}` },
  })).json();
  assert.equal(stillPreserved.agents[0].id, agent.id); assert.equal(stillPreserved.runs.length, 0);
  assert.equal(stillPreserved.runtime.available, false); assert.match(stillPreserved.runtime.message, /저장된 실행 환경/);
  await assert.rejects(readFile(join(appDataRoot, 'desktop-runtime.json')), { code: 'ENOENT' });
  missing.child.stdin.end(); assert.equal(await missing.exit, 0);
  assert.deepEqual(await readdir(foreign), ['preserved']);
  assert.equal(await readFile(join(foreign, 'preserved'), 'utf8'), 'existing developer data');
  assert.deepEqual(await readdir(resourceRoot), ['dist']);
  for (const item of children) { assert.ok(!item.output.includes(item.request.token)); assert.ok(!item.output.includes('desktop-fixture-only')); }
});
