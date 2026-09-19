import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { AgentService } from '../server/service.ts';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';
import { ResourceScheduler, readResourceConfig } from '../server/resources.ts';
import { FileModelBudget } from '../server/model-budget.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { assertReleaseIdle, inspectWorkerSources } from '../server/releases.ts';
import { atomicJson } from '../server/storage.ts';
import type { ExecutionInput, ExecutionHooks } from '../shared/types.ts';

// A separate, retained fixture. Never edits a studio-team artifact. The operator
// controller must be stopped: its normal lock protects the shared CPU/RAM budget.
if (existsSync('.env')) loadEnvFile('.env');
const [workerImage, browserImage] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
for (const image of [workerImage, browserImage]) assert.match(image, /^sha256:[a-f0-9]{64}$/);
const operatingRoot = resolve(process.env.AGENT_DATA_DIR ?? '.data');
const ownerKey = (await readFile(join(operatingRoot, 'workspace-id'), 'utf8')).trim();
const directory = resolve('.verification/browser-20260908/model-proof');
const workspaceKey = randomUUID();
const base = runtimeConfig();
assert.equal(base.auth, 'codex'); assert.equal(base.model, 'gpt-6-astra'); assert.equal(base.mode, 'docker');
const unlock = await lockfile.lock(operatingRoot, { lockfilePath: join(operatingRoot, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
let service: AgentService | undefined;
let created = false;
const tools: Array<{ at: string; name: string; action?: unknown; captureId?: string; image?: boolean }> = [];
const events: string[] = [];
try {
  await assertReleaseIdle(operatingRoot, ownerKey, base);
  await inspectWorkerSources(base, workerImage, workspaceKey);
  // Refuse to reset or append an accidental second campaign.
  await mkdir(directory);
  created = true;
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ workspaceKey, ownerKey, workerImage, browserImage,
    model: base.model, maxModelStarts: 2, createdAt: new Date().toISOString() }), { flag: 'wx' });
  const campaign = new FileModelBudget(directory, 2);
  await writeFile(join(directory, 'model-budget.json'), JSON.stringify({ version: 1, limit: 2, starts: [] }), { flag: 'wx' });
  const operationalBudget = await OperationalModelBudget.open({ directory: join(operatingRoot, 'operational-budget'), ownerKey });
  const budgetBefore = await operationalBudget.status([]);
  const resourceConfig = readResourceConfig();
  class ObservedRuntime extends ContainerRuntime {
    override execute(input: ExecutionInput, hooks: ExecutionHooks) {
      return super.execute(input, { ...hooks,
        onEvent: async message => { events.push(message); console.log(JSON.stringify({ event: 'progress', message })); await hooks.onEvent(message); },
        onTool: async (name, args) => {
          const result = await hooks.onTool!(name, args);
          const blocks = (result as { __browserMcpContent?: { content: Array<{ type: string; text?: string }> } })?.__browserMcpContent?.content;
          const capture = blocks?.find(block => block.type === 'text')?.text;
          const entry = { at: new Date().toISOString(), name, action: (args as { action?: unknown })?.action,
            captureId: capture ? JSON.parse(capture).capture?.id : undefined, image: blocks?.some(block => block.type === 'image') };
          tools.push(entry); console.log(JSON.stringify({ event: 'tool', ...entry }));
          await atomicJson(join(directory, 'tools.json'), tools); return result;
        } });
    }
  }
  const runtime = new ObservedRuntime({ ...base, image: workerImage, browserImage, workspaceKey, persistentWorkspaces: true });
  service = await AgentService.create({ dataDir: join(directory, 'db'), runtime, operationalBudget,
    scheduler: new ResourceScheduler(resourceConfig), beforeModelStart: request => campaign.reserve(request) });
  const agent = await service.createAgent({ name: '브라우저 연결 검증', persona: '승인된 로컬 브라우저 연결 검증만 수행합니다. 실제 렌더링과 결과를 구분해 보고하며 외부 요청이나 새 기억·스킬·환경·다른 에이전트 생성은 하지 않습니다.' });
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>격리 브라우저 연결 검증</title><link rel="stylesheet" href="style.css">
<main><h1>예약 확인</h1><p>아래 확인 버튼을 눌러 상태 변경을 확인합니다.</p><label for="name">이름</label><input id="name" autocomplete="off"><button id="confirm">확인</button><output id="result" aria-live="polite"></output></main>
<script>document.querySelector('#confirm').onclick=()=>{document.querySelector('#result').textContent='확인 완료: '+document.querySelector('#name').value};</script></html>`;
  const css = `*{box-sizing:border-box}body{margin:0;background:#eef1f3;color:#1c2631;font-family:sans-serif}main{position:relative;width:350px;max-width:calc(100vw - 40px);margin:40px auto;padding:24px;background:white;border-radius:16px}h1{font-size:32px;margin:0 0 24px}p{line-height:1.6}label,input,output{display:block;width:100%;margin-top:16px}input{height:44px;padding:10px;border:1px solid #789}button{position:absolute;top:18px;left:18px;width:300px;height:64px;background:#294d88;color:white;border:0;border-radius:8px;font-size:20px}output{min-height:32px}`;
  for (const [path, content] of [['fixture/index.html', html], ['fixture/style.css', css]]) {
    await service.importFile({ scope: { type: 'agent', id: agent.id }, path, mediaType: 'text/plain', base64: Buffer.from(content).toString('base64') });
  }
  const conversation = await service.createConversation({ scope: { type: 'agent', id: agent.id }, title: '실제 이미지 관찰·수정 검증', idempotencyKey: randomUUID() });
  await service.sendConversation(conversation.id, { mode: 'task', recipientAgentId: agent.id, idempotencyKey: randomUUID(), content:
    '플랫폼의 실제 브라우저 연결 검증입니다. /workspace/fixture의 정적 페이지를 browser_open으로 390×844에서 열고 browser_action screenshot의 실제 이미지를 먼저 관찰합니다. 화면에서 발견한 배치 문제를 자신의 fixture 소스에서 수정하고, 소스를 다시 열어 같은 크기로 캡처해 개선 여부를 확인합니다. 새 snapshot ref로 이름에 브라우저검증을 입력하고 확인 버튼을 눌러 화면의 확인 완료 상태도 검사합니다. 마지막 캡처를 남깁니다. result에는 첫 캡처에서 실제 관찰한 문제, 변경 이유, 재캡처 관찰과 기능 검사 결과 및 캡처 ID를 기록합니다. 브라우저 이미지 없이 시각 확인했다고 하지 않습니다. 외부 웹·계정·서비스·팀 작업물은 범위 밖입니다. 새 기억·스킬·환경은 만들지 않습니다.' });
  const deadline = Date.now() + 16 * 60_000;
  let final;
  for (;;) {
    final = await service.workspace();
    const run = final.runs[0];
    if (run && ['succeeded', 'failed', 'cancelled', 'paused'].includes(run.status)) break;
    if (Date.now() > deadline) throw new Error('브라우저 모델 검증 기한을 초과했습니다. 진행 상태를 보존합니다.');
    await delay(1000);
  }
  await atomicJson(join(directory, 'workspace.json'), final);
  assert.equal(final.runs[0].status, 'succeeded', final.runs[0].error ?? final.runs[0].recoveryReason ?? 'Model proof did not complete');
  const captures = final.browserCaptures ?? [];
  assert.ok(captures.length >= 2, '수정 전후 캡처가 없습니다.');
  assert.ok(new Set(captures.map(capture => capture.sourceHash)).size >= 2, '수정한 소스를 다시 열지 않았습니다.');
  assert.ok(new Set(captures.map(capture => capture.sha256)).size >= 2, '실제 캡처가 변하지 않았습니다.');
  for (const action of ['screenshot', 'fill', 'click']) assert.ok(tools.some(tool => tool.name === 'browser_action' && tool.action === action), action);
  assert.ok(tools.filter(tool => tool.image).length >= 2, '실제 MCP image 응답을 전달하지 않았습니다.');
  for (const capture of captures) {
    const file = await service.downloadBrowserCapture(capture.id);
    await writeFile(join(directory, file.path), file.bytes, { flag: 'wx' });
  }
  const changed = await service.downloadWorkspaceFile(agent.id, 'fixture/style.css');
  const ledger = await campaign.read();
  await atomicJson(join(directory, 'report.json'), { passed: true, workspaceKey, agentId: agent.id, conversationId: conversation.id,
    modelStarts: ledger.starts.length, budgetBefore, budgetAfter: await operationalBudget.status([]), resources: resourceConfig,
    workerImage, browserImage, captures, tools, result: final.runs[0].result, attempts: final.modelAttempts,
    changedStyleHash: createHash('sha256').update(changed.bytes).digest('hex'), scope: 'controlled fixture, not studio website quality' });
  console.log(JSON.stringify({ passed: true, modelStarts: ledger.starts.length, captures: captures.length, directory }));
} catch (error) {
  if (service) await atomicJson(join(directory, 'workspace-failure.json'), await service.workspace());
  if (created) await atomicJson(join(directory, 'failure.json'), { message: error instanceof Error ? error.message : String(error), tools, events });
  throw error;
} finally {
  try { await service?.close(); } finally { await unlock(); }
  // Proof DB, source volumes and captures are retained. Runtime.close/settle stops
  // execution containers; do not remove work or evidence as temporary files.
}
