import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { atomicJson, secureDirectory } from '../server/storage.ts';
import { sendConversationSchema, type ConversationMessage } from '../shared/conversations.ts';
import type { GitHubStatus } from '../shared/repositories.ts';
import type { Connection, Workspace } from '../shared/types.ts';

const origin = 'http://127.0.0.1:4310';
const campaign = 'studio-github-20260909';
const repository = 'formnest-studio/studio-site';
const repositoryId = 1362601656;
const defaultBranch = 'main';
const paths = { launch: resolve('.verification/studio-launch-20260907/launch.json'), originalBrief: resolve('docs/launches/studio-team.md'),
  brief: resolve('docs/launches/studio-github.md'), directory: resolve('.verification/github-20260909'), record: resolve('.verification/github-20260909/team-continuation.json') };
const roles = ['research', 'design', 'development', 'quality'] as const;
type Role = typeof roles[number];
const roleAccess: Record<Role, 'read' | 'write'> = { research: 'read', design: 'write', development: 'write', quality: 'read' };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const launchSchema = z.object({ key: z.literal('studio-launch-20260907'), ready: z.literal(true), briefSha256: z.string().regex(/^[a-f0-9]{64}$/),
  agentIds: z.object({ research: z.uuid(), design: z.uuid(), development: z.uuid(), quality: z.uuid() }), teamId: z.uuid(), projectId: z.uuid(), conversationId: z.uuid() });
type Launch = z.infer<typeof launchSchema>;
interface Binding { id: string; repositoryId: number; generation: string; defaultBranch: string }
interface Manifest {
  version: 1; campaign: string; repository: string; repositoryId: number; defaultBranch: string;
  createdAt: string; launchSha256: string; originalBriefSha256: string; briefSha256: string;
  teamId: string; projectId: string; conversationId: string; agentIds: Record<Role, string>;
  idempotencyKey: string; content: string; contentSha256: string;
  connection: Binding | null; status: 'prepared' | 'dispatching' | 'uncertain' | 'sent';
  messageId: string | null; inspectedAt: string; blockers: string[];
}
const manifestSchema = z.object({ version: z.literal(1), campaign: z.literal(campaign), repository: z.literal(repository), repositoryId: z.literal(repositoryId), defaultBranch: z.literal(defaultBranch),
  createdAt: z.iso.datetime(), launchSha256: z.string().length(64), originalBriefSha256: z.string().length(64), briefSha256: z.string().length(64),
  teamId: z.uuid(), projectId: z.uuid(), conversationId: z.uuid(), agentIds: launchSchema.shape.agentIds,
  idempotencyKey: z.uuid(), content: z.string().max(20_000), contentSha256: z.string().length(64),
  connection: z.object({ id: z.uuid(), repositoryId: z.number().int().positive(), generation: z.uuid(), defaultBranch: z.string() }).nullable(),
  status: z.enum(['prepared', 'dispatching', 'uncertain', 'sent']), messageId: z.uuid().nullable(), inspectedAt: z.iso.datetime(), blockers: z.array(z.string().max(1000)).max(100) }).strict();

async function regular(path: string): Promise<Buffer> {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 256 * 1024, '준비 기록은 256KiB 이하의 독립된 일반 파일이어야 합니다.');
  return readFile(path);
}
async function existingManifest(): Promise<Manifest | null> {
  try { return manifestSchema.parse(JSON.parse((await regular(paths.record)).toString('utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function localInputs() {
  const [launchBytes, originalBytes, briefBytes] = await Promise.all([regular(paths.launch), regular(paths.originalBrief), regular(paths.brief)]);
  const launch = launchSchema.parse(JSON.parse(launchBytes.toString('utf8')));
  assert.equal(new Set(roles.map(role => launch.agentIds[role])).size, 4, '원래 4인 팀의 식별자가 중복됐습니다.');
  assert.equal(hash(originalBytes), launch.briefSha256, '원래 브리프가 변경됐습니다. 기존 목표 해시를 보존해야 합니다.');
  return { launch, launchSha256: hash(launchBytes), originalBriefSha256: hash(originalBytes), briefSha256: hash(briefBytes), brief: briefBytes.toString('utf8') };
}
/** Deterministic UUIDv5: losing a local preparation file cannot create a new message key. */
function messageKey(launch: Launch) {
  const namespace = Buffer.from('c391213bc0194e4fb38e292f6c791efe', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`${campaign}/${repository}/${launch.conversationId}/${launch.agentIds.development}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function contentFor(inputs: Awaited<ReturnType<typeof localInputs>>) {
  const { launch } = inputs;
  return `사용자가 승인한 기존 4인 Formnest 팀의 GitHub 연결 후속 작업입니다. 플랫폼 운영자가 사이트를 대신 제작하지 않습니다.\n`
    + `기존 프로젝트 ${launch.projectId}, 팀 ${launch.teamId}, 공동 대화 ${launch.conversationId} 안에서 아래 작업을 수행합니다.\n`
    + `개발 담당 ${launch.agentIds.development}, 품질 검증 동료 ${launch.agentIds.quality}, 디자인 동료 ${launch.agentIds.design}, 리서치 동료 ${launch.agentIds.research}입니다.\n`
    + `원래 브리프 SHA256=${inputs.originalBriefSha256}, 이 추가 지시 SHA256=${inputs.briefSha256}입니다. 원래 목표·공유자료는 보존합니다.\n`
    + `저장소는 ${repository} (ID ${repositoryId}, 기본 브랜치 ${defaultBranch}) 한 개입니다. 실제 실행의 협업 context.repositories에서 이 저장소의 connectionId를 사용합니다.\n\n${inputs.brief}`;
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  assert.ok(path.startsWith('/api/') && !path.includes('..'), '고정된 로컬 API 경로만 사용합니다.');
  const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`로컬 API ${body === undefined ? 'GET' : 'POST'} ${path}: HTTP ${response.status}`); }
  const length = Number(response.headers.get('content-length'));
  assert.ok(!Number.isFinite(length) || length <= 32 * 1024 * 1024, '작업실 점검 응답이 한도를 초과했습니다.');
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 32 * 1024 * 1024, '작업실 점검 응답이 한도를 초과했습니다.');
  return JSON.parse(text) as T;
}
function binding(connection: Connection): Binding {
  return { id: connection.id, repositoryId: connection.github!.repositoryId, generation: connection.github!.generation, defaultBranch: connection.github!.defaultBranch };
}
function inspection(launch: Launch, workspace: Workspace, github: GitHubStatus) {
  const blockers: string[] = [];
  const team = workspace.teams.find(item => item.id === launch.teamId), project = workspace.projects?.find(item => item.id === launch.projectId);
  const conversation = workspace.conversations?.find(item => item.id === launch.conversationId);
  if (!team || team.memberIds.length !== 4 || roles.some(role => !team.memberIds.includes(launch.agentIds[role]))) blockers.push('승인된 기존 4인 팀 구성이 일치하지 않습니다.');
  if (!project || project.teamIds.length !== 1 || project.teamIds[0] !== launch.teamId) blockers.push('기존 프로젝트의 팀 연결이 일치하지 않습니다.');
  if (!conversation || conversation.scope.type !== 'project' || conversation.scope.id !== launch.projectId
    || conversation.budgetProjectId !== launch.projectId || conversation.budgetTeamId !== launch.teamId) blockers.push('기존 공동 대화의 프로젝트·팀 귀속이 일치하지 않습니다.');
  for (const role of roles) {
    const agent = workspace.agents.find(item => item.id === launch.agentIds[role]);
    if (!agent || !agent.description.includes(`[${launch.key}/${role}]`)) blockers.push(`기존 ${role} 역할의 에이전트를 확인할 수 없습니다.`);
    if (agent && agent.status !== 'idle') blockers.push(`${role} 에이전트가 idle 상태가 아닙니다. 기존 실행을 자동으로 재개·중단하지 않습니다.`);
  }
  if (workspace.runs.some(run => roles.some(role => launch.agentIds[role] === run.agentId) && ['queued', 'running', 'paused'].includes(run.status))) blockers.push('기존 4인 팀에 미완료 실행이 있습니다.');
  if (workspace.runtime.mode !== 'docker' || !workspace.runtime.available || !workspace.runtime.authenticated || workspace.runtime.model !== 'gpt-6-astra') blockers.push('승인된 Docker·astra 모델 실행 환경이 준비되지 않았습니다.');
  if (!github.configured || !github.writable || github.repositories.length !== 1 || github.repositories[0] !== repository) blockers.push('GitHub 인증·작업 원장 또는 정확한 단일 저장소 설정이 준비되지 않았습니다.');
  const connections = workspace.connections.filter(item => item.repository.toLowerCase() === repository.toLowerCase());
  const connection = connections.length === 1 ? connections[0] : null;
  if (!connection || connection.repository !== repository || connection.access !== 'write' || connection.github?.status !== 'connected'
    || connection.github.repositoryId !== repositoryId || connection.github.defaultBranch !== defaultBranch) blockers.push('실제 접속 확인된 정확한 저장소 연결이 없습니다.');
  if (connection) {
    const grants = connection.grants ?? [];
    if (grants.length !== 4 || roles.some(role => grants.filter(g => g.agentId === launch.agentIds[role] && g.teamId === launch.teamId && g.projectId === launch.projectId && g.access === roleAccess[role]).length !== 1)) blockers.push('리서치·QA 읽기, 디자인·개발 쓰기의 정확한 4인 grants가 필요합니다.');
    for (const role of roles) {
      const agent = workspace.agents.find(item => item.id === launch.agentIds[role]);
      if (agent && (agent.repositoryIds.length !== 1 || agent.repositoryIds[0] !== connection.id)) blockers.push(`${role} 에이전트의 저장소 범위가 이 연결 한 개로 고정되지 않았습니다.`);
    }
  }
  return { blockers, connection: connection?.github?.status === 'connected' && connection.github.repositoryId === repositoryId && connection.github.defaultBranch === defaultBranch ? binding(connection) : null,
    autoDiscoverTasks: team?.autoDiscoverTasks ?? false };
}
function validateManifest(record: Manifest, inputs: Awaited<ReturnType<typeof localInputs>>, content: string) {
  assert.equal(record.launchSha256, inputs.launchSha256, '원래 launch.json이 준비 이후 변경됐습니다.');
  assert.equal(record.originalBriefSha256, inputs.originalBriefSha256, '원래 브리프 해시가 달라졌습니다.');
  assert.equal(record.briefSha256, inputs.briefSha256, '검토할 추가 지시가 준비 이후 변경됐습니다. 기록을 조용히 덮어쓰지 않습니다.');
  assert.equal(record.idempotencyKey, messageKey(inputs.launch)); assert.equal(record.content, content); assert.equal(record.contentSha256, hash(content));
  for (const name of ['teamId', 'projectId', 'conversationId'] as const) assert.equal(record[name], inputs.launch[name]);
  assert.deepEqual(record.agentIds, inputs.launch.agentIds);
}
export type ContinuationReceipt = Pick<Manifest, 'idempotencyKey' | 'conversationId' | 'agentIds' | 'content' | 'contentSha256' | 'messageId'>;
/** Keep the prepared raw text/hash immutable, but compare the response with the
 * exact canonical text accepted by the same schema used for the POST. Only the
 * expected side is normalized; altered server text is not silently repaired. */
export function assertContinuationMessage(message: ConversationMessage, record: ContinuationReceipt): void {
  assert.equal(hash(record.content), record.contentSha256, '보존된 원본 전달 내용의 해시가 일치하지 않습니다.');
  const expected = sendConversationSchema.parse({ content: record.content, mode: 'task', recipientAgentId: record.agentIds.development, idempotencyKey: record.idempotencyKey });
  z.uuid().parse(message.id);
  assert.equal(message.idempotencyKey, expected.idempotencyKey); assert.equal(message.conversationId, record.conversationId);
  assert.equal(message.content, expected.content); assert.equal(message.mode, expected.mode);
  assert.equal(message.senderAgentId, null); assert.equal(message.deliveries.length, 1); assert.equal(message.deliveries[0].agentId, expected.recipientAgentId);
  if (record.messageId) assert.equal(message.id, record.messageId);
}
export function existingMessage(workspace: Pick<Workspace, 'conversationMessages'>, record: ContinuationReceipt): ConversationMessage | null {
  const matches = workspace.conversationMessages?.filter(item => item.idempotencyKey === record.idempotencyKey) ?? [];
  assert.ok(matches.length <= 1, '같은 전달 키가 중복됐습니다.');
  const message = matches[0]; if (!message) return null;
  assertContinuationMessage(message, record);
  return message;
}
async function run(mode: 'prepare' | 'inspect' | 'start') {
  const inputs = await localInputs(), content = contentFor(inputs), key = messageKey(inputs.launch);
  const payload = sendConversationSchema.parse({ content, mode: 'task', recipientAgentId: inputs.launch.agentIds.development, idempotencyKey: key });
  const [workspace, github] = await Promise.all([request<Workspace>('/api/workspace'), request<GitHubStatus>('/api/github')]);
  const inspected = inspection(inputs.launch, workspace, github), prior = await existingManifest();
  if (prior) validateManifest(prior, inputs, content);
  const at = new Date().toISOString();
  const record: Manifest = prior ?? { version: 1, campaign, repository, repositoryId, defaultBranch, createdAt: at, launchSha256: inputs.launchSha256,
    originalBriefSha256: inputs.originalBriefSha256, briefSha256: inputs.briefSha256, teamId: inputs.launch.teamId, projectId: inputs.launch.projectId,
    conversationId: inputs.launch.conversationId, agentIds: inputs.launch.agentIds, idempotencyKey: key, content, contentSha256: hash(content),
    connection: null, status: 'prepared', messageId: null, inspectedAt: at, blockers: [] };
  const existing = existingMessage(workspace, record);
  const report = (status: string) => console.log(JSON.stringify({ status, repository, repositoryId, connection: record.connection,
    teamId: record.teamId, projectId: record.projectId, agentIds: record.agentIds, conversationUrl: `${origin}/#conversation/${record.conversationId}`,
    idempotencyKey: key, contentSha256: record.contentSha256, originalBriefSha256: record.originalBriefSha256, messageId: existing?.id ?? record.messageId,
    blockers: inspected.blockers, autoDiscoverTasksUnchanged: inspected.autoDiscoverTasks, note: '사이트 제작·권한·팀·예산·자동 탐색 설정은 변경하지 않습니다.' }, null, 2));
  if (mode === 'inspect') { report(existing ? 'existing-message-observed' : inspected.blockers.length ? 'inspection-blocked' : 'inspection-ready-not-started'); return; }
  if (existing) { record.status = 'sent'; record.messageId = existing.id; record.inspectedAt = at; await atomicJson(paths.record, record); report('existing-message-preserved-no-post'); return; }
  if (record.status !== 'prepared') throw new Error('이전 전달이 기록됐거나 결과가 불명확하지만 대화에서 확인되지 않습니다. 자동 재전송하지 않습니다.');
  if (record.connection && inspected.connection) assert.deepEqual(record.connection, inspected.connection, '준비 이후 GitHub 연결 세대가 변경됐습니다.');
  record.inspectedAt = at; record.blockers = inspected.blockers;
  if (mode === 'prepare') {
    if (!inspected.blockers.length) record.connection = inspected.connection;
    await atomicJson(paths.record, record); report(inspected.blockers.length ? 'prepared-with-blockers-not-started' : 'prepared-not-started'); return;
  }
  assert.ok(prior?.connection, '--start 전 준비 단계에서 검증된 연결을 기록해야 합니다.');
  assert.equal(inspected.blockers.length, 0, `실행 전 점검이 막혔습니다: ${inspected.blockers.join(' ')}`);
  assert.deepEqual(record.connection, inspected.connection, '연결 식별자·세대가 일치하지 않습니다.');
  record.status = 'dispatching'; await atomicJson(paths.record, record);
  try {
    // The only POST in this script. It targets the existing real workroom and
    // developer, preserving the current project/team budget attribution.
    const message = await request<ConversationMessage>(`/api/conversations/${record.conversationId}/messages`, payload);
    assertContinuationMessage(message, record);
    record.status = 'sent'; record.messageId = z.uuid().parse(message.id); record.inspectedAt = new Date().toISOString();
    await atomicJson(paths.record, record); report('one-development-task-recorded-not-yet-verified');
  } catch (error) {
    record.status = 'uncertain'; record.inspectedAt = new Date().toISOString(); await atomicJson(paths.record, record);
    throw new Error(`작업 전달 결과가 불명확합니다. 같은 키의 대화 기록을 먼저 점검해야 합니다. ${error instanceof Error && error.message.startsWith('로컬 API ') ? error.message : ''}`.trim());
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log('npx tsx scripts/continue-studio-github.ts [--prepare|--inspect|--start]\n기본: GET 점검 및 로컬 준비만 수행합니다. --start만 실제 개발 task 1건을 전달합니다.'); return; }
  assert.ok(args.length <= 1 && (!args.length || ['--prepare', '--inspect', '--start'].includes(args[0])), '지원되는 인수는 --prepare, --inspect, --start입니다.');
  const mode = args[0] === '--start' ? 'start' : args[0] === '--inspect' ? 'inspect' : 'prepare';
  if (mode === 'inspect') { await run(mode); return; }
  await secureDirectory(paths.directory);
  const release = await lockfile.lock(paths.record, { realpath: false, lockfilePath: resolve(paths.directory, 'team-continuation.lock'), stale: 60_000, update: 10_000, retries: 0 });
  try { await run(mode); } finally { await release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
