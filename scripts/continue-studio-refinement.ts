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
import type { Workspace } from '../shared/types.ts';

const origin = 'http://127.0.0.1:4310';
const campaign = 'studio-refinement-20260911';
const repository = 'formnest-studio/studio-site', repositoryId = 1362601656, defaultBranch = 'main';
const roles = ['research', 'design', 'development', 'quality'] as const;
const roleAccess = { research: 'read', design: 'write', development: 'write', quality: 'read' } as const;
const paths = { launch: resolve('.verification/studio-launch-20260907/launch.json'), originalBrief: resolve('docs/launches/studio-team.md'),
  githubBrief: resolve('docs/launches/studio-github.md'), brief: resolve('docs/launches/studio-refinement.md'),
  directory: resolve('.verification/studio-refinement-20260911'), record: resolve('.verification/studio-refinement-20260911/continuation.json') };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const launchSchema = z.object({ key: z.literal('studio-launch-20260907'), ready: z.literal(true), briefSha256: sha256,
  agentIds: z.object({ research: z.uuid(), design: z.uuid(), development: z.uuid(), quality: z.uuid() }), teamId: z.uuid(), projectId: z.uuid(), conversationId: z.uuid() });
export type RefinementLaunch = z.infer<typeof launchSchema>;
export interface RefinementInputs {
  launch: RefinementLaunch; launchSha256: string; originalBriefSha256: string; githubBriefSha256: string; briefSha256: string; brief: string;
}
const sourceSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(200), version: z.number().int().positive(), sha256 }).strict();
const connectionSchema = z.object({ id: z.uuid(), repositoryId: z.literal(repositoryId), generation: z.uuid(), defaultBranch: z.literal(defaultBranch) }).strict();
export const refinementManifestSchema = z.object({ version: z.literal(1), campaign: z.literal(campaign), repository: z.literal(repository),
  repositoryId: z.literal(repositoryId), pullRequestNumber: z.literal(1), createdAt: z.iso.datetime(), inspectedAt: z.iso.datetime(),
  launchSha256: sha256, originalBriefSha256: sha256, githubBriefSha256: sha256, briefSha256: sha256,
  teamId: z.uuid(), projectId: z.uuid(), conversationId: z.uuid(), agentIds: launchSchema.shape.agentIds,
  content: z.string().min(1).max(20_000), contentSha256: sha256, idempotencyKey: z.uuid(),
  connection: connectionSchema.nullable(), sources: z.array(sourceSchema).max(2000),
  status: z.enum(['prepared', 'dispatching', 'uncertain', 'sent']), messageId: z.uuid().nullable(), blockers: z.array(z.string()).max(100),
}).strict();
export type RefinementManifest = z.infer<typeof refinementManifestSchema>;
export type RefinementWorkspace = Workspace & { operatorPaused?: boolean };
export type RefinementMode = 'inspect' | 'prepare' | 'start';
const requiredSources = ['site/index.html', 'site/demo/index.html', 'site/demo/style.css', 'site/demo/app.js', 'site/demo/core.js', 'site/tests/core.test.cjs', 'site/README.md'];

async function regular(path: string): Promise<Buffer> {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1024 * 1024, '입력·준비 기록은 1MiB 이하의 독립된 일반 파일이어야 합니다.');
  return readFile(path);
}
async function localInputs(): Promise<RefinementInputs> {
  const [launchBytes, originalBytes, githubBytes, briefBytes] = await Promise.all([regular(paths.launch), regular(paths.originalBrief), regular(paths.githubBrief), regular(paths.brief)]);
  const launch = launchSchema.parse(JSON.parse(launchBytes.toString('utf8')));
  assert.equal(new Set(Object.values(launch.agentIds)).size, 4, '원래 4인 팀 식별자가 중복됐습니다.');
  assert.equal(hash(originalBytes), launch.briefSha256, '원래 브리프가 변경됐습니다. 해시로 연결된 원본을 보존해야 합니다.');
  return { launch, launchSha256: hash(launchBytes), originalBriefSha256: hash(originalBytes), githubBriefSha256: hash(githubBytes), briefSha256: hash(briefBytes), brief: briefBytes.toString('utf8') };
}
async function existingManifest(): Promise<RefinementManifest | null> {
  try { return refinementManifestSchema.parse(JSON.parse((await regular(paths.record)).toString('utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** One logical campaign retains its UUIDv5 even if its local receipt is lost. */
export function refinementMessageKey(launch: RefinementLaunch): string {
  const namespace = Buffer.from('c391213bc0194e4fb38e292f6c791efe', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`${campaign}/${repository}/${launch.projectId}/${launch.teamId}/${launch.conversationId}/${launch.agentIds.design}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function refinementContent(inputs: RefinementInputs): string {
  const { launch } = inputs;
  return `사용자가 승인한 Formnest 대표 사이트·대표 작품의 완성 작업을 기존 팀에서 이어갑니다. 디자인·콘텐츠 동료에게 첫 task 한 건을 전달하며 나머지 동료와의 협력과 목표 안의 세부 과제를 포함합니다.\n`
    + `기존 프로젝트 ${launch.projectId}, 팀 ${launch.teamId}, 공동 대화 ${launch.conversationId}입니다.\n`
    + `디자인 ${launch.agentIds.design}, 브랜드·리서치 ${launch.agentIds.research}, 개발 ${launch.agentIds.development}, 품질 검증 ${launch.agentIds.quality}입니다.\n`
    + `원래 브리프 SHA256=${inputs.originalBriefSha256}, 추가 브리프 SHA256=${inputs.briefSha256}입니다. 기존 GitHub 연결 검증에서만 적용한 '사이트 변경 없이 게시·검증 후 대기' 단계는 끝났으며 아래 승인된 제작 범위로 이어갑니다.\n`
    + `저장소 ${repository} (ID ${repositoryId})의 기존 PR #1을 이어 수정합니다. 실제 제공된 context.repositories의 connectionId와 현재 PR HEAD를 확인합니다.\n\n${inputs.brief}`;
}
export function inspectRefinement(inputs: RefinementInputs, workspace: RefinementWorkspace, github: GitHubStatus) {
  const { launch } = inputs, blockers: string[] = [];
  const team = workspace.teams.find(item => item.id === launch.teamId), project = workspace.projects?.find(item => item.id === launch.projectId);
  const conversation = workspace.conversations?.find(item => item.id === launch.conversationId);
  if (!team || team.memberIds.length !== 4 || roles.some(role => !team.memberIds.includes(launch.agentIds[role]))) blockers.push('승인된 기존 4인 팀 구성이 일치하지 않습니다.');
  if (!project || project.teamIds.length !== 1 || project.teamIds[0] !== launch.teamId) blockers.push('기존 프로젝트의 팀 연결이 일치하지 않습니다.');
  if (!conversation || conversation.scope.type !== 'project' || conversation.scope.id !== launch.projectId || conversation.budgetProjectId !== launch.projectId
    || conversation.budgetTeamId !== launch.teamId || conversation.participantAgentIds.length !== 4 || roles.some(role => !conversation.participantAgentIds.includes(launch.agentIds[role]))) blockers.push('기존 공동 대화의 구성원·프로젝트·팀 귀속이 일치하지 않습니다.');
  for (const role of roles) {
    const agent = workspace.agents.find(item => item.id === launch.agentIds[role]);
    if (!agent || !agent.description.includes(`[${launch.key}/${role}]`)) blockers.push(`기존 ${role} 역할의 에이전트를 확인할 수 없습니다.`);
    if (agent && agent.status !== 'idle') blockers.push(`${role} 에이전트의 기존 작업이 진행 중이거나 중지 상태입니다.`);
  }
  if (workspace.runs.some(run => roles.some(role => launch.agentIds[role] === run.agentId) && !['succeeded', 'failed', 'cancelled'].includes(run.status))) blockers.push('기존 4인 팀에 미완료 실행이 있습니다.');
  if (workspace.operatorPaused) blockers.push('운영자가 일시 중지한 상태입니다.');
  if (workspace.runtime.simulation || workspace.runtime.mode !== 'docker' || !workspace.runtime.available || !workspace.runtime.authenticated || workspace.runtime.model !== 'gpt-6-astra') blockers.push('승인된 실제 Docker·astra 실행 환경이 준비되지 않았습니다.');
  if (!github.configured || !github.writable || github.repositories.length !== 1 || github.repositories[0] !== repository) blockers.push('정확한 단일 저장소의 GitHub 인증·쓰기 경로가 준비되지 않았습니다.');
  const matches = workspace.connections.filter(item => item.repository.toLowerCase() === repository.toLowerCase());
  const connection = matches.length === 1 ? matches[0] : undefined;
  if (!connection || connection.repository !== repository || connection.access !== 'write' || connection.github?.status !== 'connected'
    || connection.github.repositoryId !== repositoryId || connection.github.defaultBranch !== defaultBranch) blockers.push('확인된 저장소 ID·기본 브랜치·쓰기 연결이 일치하지 않습니다.');
  if (connection) {
    const grants = connection.grants ?? [];
    if (grants.length !== 4 || roles.some(role => grants.filter(g => g.agentId === launch.agentIds[role] && g.teamId === launch.teamId && g.projectId === launch.projectId && g.access === roleAccess[role]).length !== 1)) blockers.push('리서치·QA 읽기, 디자인·개발 쓰기의 기존 네 권한이 일치하지 않습니다.');
    for (const role of roles) {
      const agent = workspace.agents.find(item => item.id === launch.agentIds[role]);
      if (agent && (agent.repositoryIds.length !== 1 || agent.repositoryIds[0] !== connection.id)) blockers.push(`${role} 에이전트의 저장소 접근 범위가 일치하지 않습니다.`);
    }
  }
  const artifacts = (workspace.sharedArtifacts ?? []).filter(item => item.scope.type === 'project' && item.scope.id === launch.projectId);
  if (new Set(artifacts.map(item => item.name)).size !== artifacts.length || new Set(artifacts.map(item => item.id)).size !== artifacts.length) blockers.push('프로젝트 공유 자료의 이름이나 식별자가 중복됐습니다.');
  for (const name of requiredSources) if (!artifacts.some(item => item.name === name)) blockers.push(`기존 공유 소스를 확인할 수 없습니다: ${name}`);
  const sources = artifacts.map(item => sourceSchema.parse({ id: item.id, name: item.name, version: item.version, sha256: hash(item.content) })).sort((a, b) => a.name.localeCompare(b.name));
  const bound = connection?.github?.status === 'connected' && connection.github.repositoryId === repositoryId && connection.github.defaultBranch === defaultBranch
    ? connectionSchema.parse({ id: connection.id, repositoryId, generation: connection.github.generation, defaultBranch }) : null;
  return { blockers, connection: bound, sources, autoDiscoverTasks: team?.autoDiscoverTasks ?? false };
}
type Receipt = Pick<RefinementManifest, 'content' | 'contentSha256' | 'idempotencyKey' | 'conversationId' | 'agentIds' | 'messageId' | 'projectId' | 'teamId'>;
export function assertRefinementMessage(message: ConversationMessage, record: Receipt): void {
  assert.equal(hash(record.content), record.contentSha256, '보존된 전달 원문의 해시가 일치하지 않습니다.');
  const expected = sendConversationSchema.parse({ content: record.content, mode: 'task', recipientAgentId: record.agentIds.design, idempotencyKey: record.idempotencyKey });
  z.uuid().parse(message.id);
  assert.equal(message.idempotencyKey, expected.idempotencyKey); assert.equal(message.conversationId, record.conversationId);
  assert.equal(message.content, expected.content); assert.equal(message.mode, expected.mode); assert.equal(message.senderAgentId, null);
  assert.equal(message.sourceRunId, null); assert.equal(message.replyToId, null);
  assert.equal(message.deliveries.length, 1); assert.equal(message.deliveries[0].agentId, record.agentIds.design);
  if (message.budgetProjectId !== undefined) assert.equal(message.budgetProjectId, record.projectId);
  if (message.budgetTeamId !== undefined) assert.equal(message.budgetTeamId, record.teamId);
  if (record.messageId) assert.equal(message.id, record.messageId);
}
function validateManifest(record: RefinementManifest, inputs: RefinementInputs, content: string): void {
  refinementManifestSchema.parse(record);
  for (const field of ['launchSha256', 'originalBriefSha256', 'githubBriefSha256', 'briefSha256'] as const) assert.equal(record[field], inputs[field], `준비 이후 ${field}가 변경됐습니다. 원본이나 전달 의도를 조용히 덮어쓰지 않습니다.`);
  for (const field of ['teamId', 'projectId', 'conversationId'] as const) assert.equal(record[field], inputs.launch[field]);
  assert.deepEqual(record.agentIds, inputs.launch.agentIds); assert.equal(record.idempotencyKey, refinementMessageKey(inputs.launch));
  assert.equal(record.content, content); assert.equal(record.contentSha256, hash(content));
}
export interface RefinementEffects {
  persist: (record: RefinementManifest) => Promise<void>;
  post: (path: string, payload: z.infer<typeof sendConversationSchema>) => Promise<ConversationMessage>;
}
/** Only the explicit start branch can invoke post; inspect cannot persist either. */
export async function continueRefinement(mode: RefinementMode, inputs: RefinementInputs, workspace: RefinementWorkspace, github: GitHubStatus,
  prior: RefinementManifest | null, effects: RefinementEffects, at = new Date().toISOString()) {
  launchSchema.parse(inputs.launch);
  assert.equal(new Set(Object.values(inputs.launch.agentIds)).size, 4);
  assert.equal(inputs.launch.briefSha256, inputs.originalBriefSha256, '원래 브리프 해시가 일치하지 않습니다.');
  assert.equal(hash(inputs.brief), inputs.briefSha256, '추가 브리프 해시가 일치하지 않습니다.');
  const content = refinementContent(inputs), inspected = inspectRefinement(inputs, workspace, github);
  if (prior) validateManifest(prior, inputs, content);
  const record: RefinementManifest = prior ? structuredClone(prior) : refinementManifestSchema.parse({ version: 1, campaign, repository, repositoryId, pullRequestNumber: 1,
    createdAt: at, inspectedAt: at, launchSha256: inputs.launchSha256, originalBriefSha256: inputs.originalBriefSha256, githubBriefSha256: inputs.githubBriefSha256,
    briefSha256: inputs.briefSha256, teamId: inputs.launch.teamId, projectId: inputs.launch.projectId, conversationId: inputs.launch.conversationId, agentIds: inputs.launch.agentIds,
    content, contentSha256: hash(content), idempotencyKey: refinementMessageKey(inputs.launch), connection: null, sources: [], status: 'prepared', messageId: null, blockers: [] });
  const payload = sendConversationSchema.parse({ content, mode: 'task', recipientAgentId: record.agentIds.design, idempotencyKey: record.idempotencyKey });
  const messages = workspace.conversationMessages?.filter(item => item.idempotencyKey === record.idempotencyKey) ?? [];
  assert.ok(messages.length <= 1, '같은 전달 키가 중복됐습니다.');
  const existing = messages[0]; if (existing) assertRefinementMessage(existing, record);
  const result = (status: string) => ({ status, record, blockers: inspected.blockers, observedConnection: inspected.connection, sourceCount: inspected.sources.length,
    autoDiscoverTasksUnchanged: inspected.autoDiscoverTasks, conversationUrl: `${origin}/#conversation/${record.conversationId}` });
  if (mode === 'inspect') return result(existing ? 'existing-message-observed' : inspected.blockers.length ? 'inspection-blocked' : 'inspection-ready-not-started');
  if (existing) {
    record.status = 'sent'; record.messageId = existing.id; record.inspectedAt = at;
    await effects.persist(record); return result('existing-message-preserved-no-post');
  }
  if (record.status !== 'prepared') throw new Error('이전 전달이 기록됐거나 불명확하지만 대화에서 확인되지 않습니다. 자동 재전송하지 않습니다.');
  if (record.connection && inspected.connection) assert.deepEqual(record.connection, inspected.connection, '준비 이후 저장소 연결 세대가 변경됐습니다.');
  record.inspectedAt = at; record.blockers = inspected.blockers;
  if (mode === 'prepare') {
    if (!inspected.blockers.length) { record.connection = inspected.connection; record.sources = inspected.sources; }
    await effects.persist(record); return result(inspected.blockers.length ? 'prepared-with-blockers-not-started' : 'prepared-not-started');
  }
  assert.ok(prior?.connection && prior.sources.length, '--start 전 --prepare로 확인된 연결과 공유자료를 보존해야 합니다.');
  assert.equal(inspected.blockers.length, 0, `실행 전 점검이 막혔습니다: ${inspected.blockers.join(' ')}`);
  assert.deepEqual(record.connection, inspected.connection, '준비 이후 저장소 연결이 변경됐습니다.');
  assert.deepEqual(record.sources, inspected.sources, '준비 이후 공유 자료가 변경됐습니다. --prepare로 최신 자료를 다시 점검해야 합니다.');
  record.status = 'dispatching'; await effects.persist(record);
  try {
    const message = await effects.post(`/api/conversations/${record.conversationId}/messages`, payload);
    assertRefinementMessage(message, record);
    record.status = 'sent'; record.messageId = message.id; record.inspectedAt = new Date().toISOString();
    await effects.persist(record); return result('one-design-task-recorded-not-yet-verified');
  } catch {
    record.status = 'uncertain'; record.inspectedAt = new Date().toISOString(); await effects.persist(record);
    throw new Error('작업 전달 결과가 불명확합니다. 같은 키의 공동 대화 기록을 확인하며 자동 재전송하지 않습니다.');
  }
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  assert.ok(path.startsWith('/api/') && !path.includes('..'), '고정된 로컬 API 경로만 사용합니다.');
  const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`로컬 API ${body === undefined ? 'GET' : 'POST'} ${path}: HTTP ${response.status}`); }
  const limit = 32 * 1024 * 1024, declared = Number(response.headers.get('content-length'));
  assert.ok(!Number.isFinite(declared) || declared <= limit, '작업실 점검 응답이 한도를 초과했습니다.');
  const reader = response.body?.getReader(); assert.ok(reader, '작업실 점검 응답이 비었습니다.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; assert.ok(size <= limit, '작업실 점검 응답이 한도를 초과했습니다.'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
async function run(mode: RefinementMode) {
  const inputs = await localInputs();
  const [workspace, github, prior] = await Promise.all([request<RefinementWorkspace>('/api/workspace'), request<GitHubStatus>('/api/github'), existingManifest()]);
  const result = await continueRefinement(mode, inputs, workspace, github, prior, { persist: record => atomicJson(paths.record, record), post: request<ConversationMessage> });
  console.log(JSON.stringify({ status: result.status, repository, repositoryId, pullRequestNumber: 1, connection: result.observedConnection,
    teamId: result.record.teamId, projectId: result.record.projectId, conversationUrl: result.conversationUrl, recipientAgentId: result.record.agentIds.design,
    idempotencyKey: result.record.idempotencyKey, contentSha256: result.record.contentSha256, messageId: result.record.messageId,
    sources: result.sourceCount, blockers: result.blockers, autoDiscoverTasksUnchanged: result.autoDiscoverTasksUnchanged,
    note: '사이트 제작·권한·팀·모델·자원·예산 설정은 변경하지 않습니다.' }, null, 2));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log('npx tsx scripts/continue-studio-refinement.ts [--prepare|--inspect|--start]\n기본: GET 점검과 로컬 준비만 수행합니다. --inspect는 쓰기가 없으며 --start만 디자인 동료에게 실제 task 한 건을 전달합니다.'); return; }
  assert.ok(args.length <= 1 && (!args.length || ['--prepare', '--inspect', '--start'].includes(args[0])), '지원되는 인수는 --prepare, --inspect, --start입니다.');
  const mode: RefinementMode = args[0] === '--start' ? 'start' : args[0] === '--inspect' ? 'inspect' : 'prepare';
  if (mode === 'inspect') { await run(mode); return; }
  await secureDirectory(paths.directory);
  const release = await lockfile.lock(paths.record, { realpath: false, lockfilePath: resolve(paths.directory, 'continuation.lock'), stale: 60_000, update: 10_000, retries: 0 });
  try { await run(mode); } finally { await release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
