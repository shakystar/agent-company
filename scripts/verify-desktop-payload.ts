import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopStart } from '../server/desktop-protocol.ts';
import { assertDesktopPayloadCopySpace, copyDesktopPayload, readDesktopPayload } from './desktop-payload.ts';

// Copy outside the repository so a missing packaged dependency cannot resolve from developer node_modules.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.length !== 3) throw new Error('검사할 payload 폴더 한 개가 필요합니다.');
const source = resolve(process.argv[2]);
const payload = await readDesktopPayload(source), { manifest } = payload;
// The copy and its isolated database must leave the existing operating floor available.
await assertDesktopPayloadCopySpace(tmpdir(), payload.copyBytes + 256n * 1024n ** 2n);
const temporary = await mkdtemp(join(tmpdir(), 'agent-company-packaged-'));
const installed = join(temporary, '설치 자원'), appDataRoot = join(temporary, '사용자 데이터'), cwd = join(temporary, 'empty cwd');
const records: object[] = [];
let child: ReturnType<typeof launch> | undefined;
let verificationError: unknown;
function launch() {
  const request: DesktopStart = { type: 'start', protocol: 1, nonce: randomBytes(32).toString('base64url'),
    token: randomBytes(32).toString('base64url'), cookieName: `ac_desktop_${randomBytes(16).toString('hex')}`,
    resourceRoot: join(installed, 'resources'), appDataRoot };
  const env: NodeJS.ProcessEnv = {};
  // No NODE_PATH/NODE_OPTIONS, model credentials, runtime defaults or developer Node/npm on PATH.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const processHandle = spawn(join(installed, 'binaries', 'node-x86_64-pc-windows-msvc.exe'),
    [join(installed, manifest.entry)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '', stdout = '', stderr = '', exited = false;
  const events: Array<{ type: string; nonce?: string; origin?: string; workspaceKey?: string }> = [];
  const exit = new Promise<number | null>((resolveExit, reject) => {
    processHandle.once('error', reject); processHandle.once('exit', code => { exited = true; resolveExit(code); });
  });
  processHandle.stdout!.setEncoding('utf8').on('data', chunk => {
    stdout += chunk; buffer += chunk; let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) { events.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); }
  });
  processHandle.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  processHandle.stdin!.on('error', () => undefined);
  processHandle.stdin!.write(`${JSON.stringify(request)}\n`);
  return { processHandle, request, events, exit, get exited() { return exited; }, get output() { return stdout + stderr; } };
}
const wait = async (predicate: () => boolean) => {
  const until = Date.now() + 60_000;
  while (!predicate() && Date.now() < until) await new Promise(resolveWait => setTimeout(resolveWait, 25));
  assert.ok(predicate(), '동봉 서버의 준비 또는 정상 종료를 확인하지 못했습니다.');
};
try {
  await mkdir(installed); await copyDesktopPayload(payload, installed); await mkdir(cwd);
  records.push({ check: 'copied-payload-hashes', passed: true, files: manifest.files.length });
  child = launch(); await wait(() => child!.events.some(event => event.type === 'ready') || child!.exited);
  const ready = child.events.find(event => event.type === 'ready'); assert.ok(ready?.origin, '동봉 서버 준비 실패');
  assert.equal(ready.nonce, child.request.nonce);
  const headers = { authorization: `Bearer ${child.request.token}` };
  const unauthorized = await fetch(ready.origin + '/api/workspace');
  await unauthorized.arrayBuffer(); assert.equal(unauthorized.status, 403);
  const workspace = await (await fetch(ready.origin + '/api/workspace', { headers })).json();
  assert.equal(workspace.agents.length, 0); assert.equal(workspace.runs.length, 0); assert.equal(workspace.runtime.authenticated, false);
  const document = await (await fetch(ready.origin + '/', { headers })).text();
  assert.match(document, /<div id="root">/);
  const assets = [...document.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) {
    const response: Response = await fetch(ready.origin + asset, { headers });
    // Finish each HTTP response before requesting graceful server shutdown.
    // Unread bodies can retain active connections beyond the exit deadline.
    await response.arrayBuffer(); assert.equal(response.status, 200);
  }
  const created = await fetch(ready.origin + '/api/agents', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '동봉 서버 보존 검사', persona: '실행 없는 설치 검증', model: 'gpt-6-astra' }) });
  assert.equal(created.status, 201); const agent = await created.json();
  child.processHandle.stdin!.end(); await wait(() => child!.exited); assert.equal(await child.exit, 0);
  assert.ok(!child.output.includes(child.request.token));
  records.push({ check: 'bundled-node-js-wasm-ui-no-developer-path', passed: true, workspaceKey: ready.workspaceKey, assets: assets.length, modelCalls: 0 });
  child = launch(); await wait(() => child!.events.some(event => event.type === 'ready') || child!.exited);
  const restarted = child.events.find(event => event.type === 'ready'); assert.ok(restarted?.origin);
  assert.equal(restarted.workspaceKey, ready.workspaceKey);
  const state = await (await fetch(restarted.origin + '/api/workspace', { headers: { authorization: `Bearer ${child.request.token}` } })).json();
  assert.equal(state.agents[0].id, agent.id); assert.equal(state.runs.length, 0);
  child.processHandle.stdin!.write(`${JSON.stringify({ type: 'shutdown', protocol: 1, nonce: child.request.nonce })}\n`);
  await wait(() => child!.exited); assert.equal(await child.exit, 0);
  assert.ok(!(await readdir(appDataRoot)).includes('desktop.lock'));
  assert.ok(!(await readdir(join(appDataRoot, 'workspace'))).includes('controller.lock'));
  records.push({ check: 'restart-data-preserved-and-leases-released', passed: true, modelCalls: 0 });
  const reportRoot = join(root, '.verification', 'desktop-foundation-20260912'); await mkdir(reportRoot, { recursive: true });
  const reportDir = join(reportRoot, `payload-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(reportDir);
  await writeFile(join(reportDir, 'packaged-backend.json'), JSON.stringify({ createdAt: new Date().toISOString(), source,
    node: manifest.node, operatingDataUsed: false, copiedOutsideRepository: true, developerNodeOnPath: false,
    cleanMachineVerified: false, nativeWindowVerified: false, installerVerified: false, records }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, checks: records.length, reportDir, installerVerified: false }));
} catch (error) {
  verificationError = error; throw error;
} finally {
  try {
    if (child && !child.exited) { child.processHandle.stdin!.end(); await wait(() => child!.exited); await child.exit; }
    const target = resolve(temporary), base = resolve(tmpdir());
    assert.ok(relative(base, target).startsWith('agent-company-packaged-') && target.startsWith(base + sep));
    await rm(target, { recursive: true, force: true });
  } catch (cleanupError) {
    if (verificationError) throw new AggregateError([verificationError, cleanupError], '동봉 서버 검증과 정리 확인이 실패했습니다.');
    throw cleanupError;
  }
}
