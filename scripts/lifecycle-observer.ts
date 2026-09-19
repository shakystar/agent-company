import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Read-only observer: no dotenv/auth loading, DB opening, command execution,
// model budget mutation, Docker access, or HTTP requests outside a validated
// local scenario controller's GET /api/workspace endpoint.
const root = resolve('.verification/lifecycle-20260906');
const oldRoot = resolve('.verification/growth-20260906');
const html = await readFile(fileURLToPath(new URL('./lifecycle-observer.html', import.meta.url)), 'utf8');
const manifestSchema = z.object({ version: z.literal(1), limit: z.literal(20), ownerKey: z.uuid(),
  workspaces: z.object({ growth: z.uuid(), recovery: z.uuid() }), createdAt: z.iso.datetime() });
const descriptorSchema = z.object({ scenario: z.enum(['growth', 'recovery']), workspaceKey: z.uuid(),
  origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/), pid: z.number().int().positive(),
  startedAt: z.iso.datetime(), status: z.enum(['running', 'stopped']), stoppedAt: z.iso.datetime().optional() });
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown, max = 1500): string => typeof value === 'string' ? value
  .replace(/```[\s\S]*?```/g, '[코드 생략]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [비공개]')
  .replace(/\bsk-[A-Za-z0-9_-]+/g, '[비공개]')
  .replace(/("?(?:access_token|refresh_token|id_token|api_key|authorization)"?\s*[:=]\s*)[^\s,}]+/gi, '$1[비공개]')
  .slice(0, max) : '';
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

async function readJson(base: string, name: string, maxBytes = 16 * 1024 * 1024) {
  const path = join(base, name);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Unsafe file');
    const actual = await realpath(path), within = relative(base, actual);
    if (isAbsolute(within) || within.startsWith('..') || actual !== path) throw new Error('Redirected file');
    const handle = await open(path, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      let used = 0;
      while (used < bytes.length) {
        const chunk = await handle.read(bytes, used, bytes.length - used, used);
        if (!chunk.bytesRead) break;
        used += chunk.bytesRead;
      }
      if (used > info.size) throw new Error('File changed during read');
      return { value: object(JSON.parse(bytes.subarray(0, used).toString('utf8'))), modifiedAt: info.mtime.toISOString(), error: null };
    } finally { await handle.close(); }
  } catch (error) {
    return { value: {} as JsonObject, modifiedAt: null, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? '아직 기록이 없습니다.' : '보관 파일을 확인하지 못했습니다.' };
  }
}

function ledger(value: JsonObject, expected: number) {
  const valid = value.version === 1 && value.limit === expected && Array.isArray(value.starts) && value.starts.length <= expected;
  return { starts: valid ? (value.starts as unknown[]).length : null, limit: expected,
    lastStartAt: valid ? time(object((value.starts as unknown[]).at(-1)).recordedAt) : null };
}
function publicRuns(value: unknown) {
  return array(value).toSorted((a, b) => text(b.createdAt).localeCompare(text(a.createdAt))).slice(0, 30).map(run => ({
    id: text(run.id, 100), kind: text(run.kind, 30) || 'task', status: text(run.status, 30),
    createdAt: time(run.createdAt), completedAt: time(run.completedAt),
    progress: text(object(run.progress).message), progressAt: time(object(run.progress).updatedAt),
    result: text(run.result), error: text(run.error), budgetPaused: run.modelBudgetPaused === true,
  }));
}
function publicReviews(value: unknown) {
  return array(value).toSorted((a, b) => text(b.createdAt).localeCompare(text(a.createdAt))).slice(0, 20).map(review => ({
    id: text(review.id, 100), purpose: text(review.purpose, 30), verdict: text(review.verdict, 30),
    decision: text(review.decision, 30), reason: text(review.reason), createdAt: time(review.createdAt),
  }));
}
function publicAttempts(value: unknown) {
  return array(value).toSorted((a, b) => text(b.startedAt).localeCompare(text(a.startedAt))).slice(0, 20).map(attempt => ({
    id: text(attempt.id, 100), phase: text(attempt.phase, 30), kind: text(attempt.kind, 100), status: text(attempt.status, 30),
    startedAt: time(attempt.startedAt), usageStatus: text(object(attempt.usage).status, 30),
    inputTokens: count(object(attempt.usage).inputTokens), outputTokens: count(object(attempt.usage).outputTokens),
  }));
}

async function scenarioStatus(name: 'growth' | 'recovery', manifest: z.infer<typeof manifestSchema> | null) {
  const base = join(root, name);
  const [reportFile, progressFile, stateFile, descriptorFile] = await Promise.all([
    readJson(base, 'report.json'), readJson(base, 'progress.json'), readJson(base, 'state.json'), readJson(base, 'controller.json', 8192),
  ]);
  const report = reportFile.value;
  const parsed = descriptorSchema.safeParse(descriptorFile.value);
  let live: JsonObject | null = null;
  let connection = '실시간 연결 정보가 없습니다.';
  if (parsed.success && manifest && parsed.data.scenario === name && parsed.data.workspaceKey === manifest.workspaces[name]) {
    const descriptor = parsed.data;
    const port = Number(new URL(descriptor.origin).port);
    if (port > 65535 || port === 4314) connection = '연결 기록의 포트가 올바르지 않습니다.';
    else if (descriptor.status === 'stopped') connection = '제어 서버의 종료 기록입니다. 현재 실행을 뜻하지 않습니다.';
    else {
      try {
        const response = await fetch(`${descriptor.origin}/api/workspace`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2500) });
        if (!response.ok || !response.body) throw new Error('Unavailable');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 16 * 1024 * 1024) throw new Error('Oversized workspace');
            chunks.push(next.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!Array.isArray(result.runs) || !Array.isArray(result.agents) || !result.runtime) throw new Error('Invalid workspace');
        live = result; connection = '현재 제어 서버의 API 응답입니다.';
      } catch { connection = '제어 서버에 연결되지 않습니다. 남아 있는 연결 기록은 실행 증거가 아닙니다.'; }
    }
  } else if (parsed.success) connection = '캠페인과 연결 기록의 소유 식별자가 일치하지 않습니다.';
  const source = live ?? report;
  const progress = Object.keys(progressFile.value).length ? progressFile.value : object(report.progress);
  const cases = array(stateFile.value.cases ?? report.cases).slice(0, 3).map(item => ({
    name: text(item.name, 50), stage: text(item.stage, 50), starts: count(item.starts), completedAt: time(item.completedAt),
  }));
  return { name, live: live !== null, source: live ? '실시간 API' : '보관된 마지막 상태', connection,
    observedAt: new Date().toISOString(), recordedAt: live ? new Date().toISOString() : time(report.completedAt) ?? reportFile.modifiedAt,
    controllerStartedAt: parsed.success ? parsed.data.startedAt : null,
    report: { status: text(report.status, 30), completedAt: time(report.completedAt), error: text(report.error),
      databaseReopened: typeof report.databaseReopened === 'boolean' ? report.databaseReopened : null },
    progress: { recordedAt: progressFile.modifiedAt ?? stateFile.modifiedAt, completed: progress.completed === true,
      introductionRunId: text(progress.retryIntroductionRunId ?? progress.introductionRunId, 100), regressionRunId: text(progress.regressionRunId, 100) },
    cases, runs: publicRuns(source.runs), reviews: publicReviews(live ? live.growthReviews : report.reviews),
    attempts: publicAttempts(source.modelAttempts),
    repairJobs: array(source.repairJobs).slice(-10).map(job => ({ status: text(job.status, 30), attempts: count(job.attempts), reason: text(job.reason) })),
  };
}

let cache: { at: number; data: unknown } | undefined;
let pending: Promise<unknown> | undefined;
async function status() {
  if (cache && Date.now() - cache.at < 2500) return cache.data;
  return pending ??= (async () => {
    const [manifestFile, currentFile, oldFile] = await Promise.all([
      readJson(root, 'manifest.json', 8192), readJson(root, 'model-budget.json'), readJson(oldRoot, 'model-budget.json'),
    ]);
    const parsed = manifestSchema.safeParse(manifestFile.value);
    const data = { updatedAt: new Date().toISOString(), readOnly: true, campaign: ledger(currentFile.value, 20),
      previousCampaign: ledger(oldFile.value, 10), startedAt: parsed.success ? parsed.data.createdAt : null,
      scenarios: await Promise.all((['growth', 'recovery'] as const).map(name => scenarioStatus(name, parsed.success ? parsed.data : null))) };
    cache = { at: Date.now(), data }; return data;
  })().finally(() => { pending = undefined; });
}

const server = createServer((request, response) => {
  const host = request.headers.host ?? '';
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const send = (code: number, type: string, body: string) => { response.writeHead(code, { 'Content-Type': type }); response.end(request.method === 'HEAD' ? undefined : body); };
  if (!/^(?:127\.0\.0\.1|localhost):4314$/.test(host) || request.headers['sec-fetch-site'] === 'cross-site'
    || (request.headers.origin && request.headers.origin !== `http://${host}`)) return send(403, 'text/plain; charset=utf-8', '로컬 관찰 화면에서만 접근할 수 있습니다.');
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); return send(405, 'text/plain; charset=utf-8', '읽기 전용 화면입니다.'); }
  if (request.url === '/' || request.url === '/index.html') {
    const nonce = randomBytes(18).toString('base64');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return send(200, 'text/html; charset=utf-8', html.replace('__OBSERVER_NONCE__', nonce));
  }
  if (request.url === '/api/status') {
    void status().then(data => send(200, 'application/json; charset=utf-8', JSON.stringify(data)))
      .catch(() => send(503, 'application/json; charset=utf-8', JSON.stringify({ error: '검증 기록을 확인하지 못했습니다.' })));
    return;
  }
  return send(404, 'text/plain; charset=utf-8', '경로를 찾을 수 없습니다.');
});
server.headersTimeout = 5000; server.requestTimeout = 10_000;
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(4314, '127.0.0.1', () => { console.log('읽기 전용 검증 관찰 화면: http://127.0.0.1:4314'); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); });
