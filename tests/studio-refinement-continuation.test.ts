import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { continueRefinement, assertRefinementMessage, inspectRefinement, refinementContent, refinementMessageKey,
  type RefinementEffects, type RefinementInputs, type RefinementManifest, type RefinementWorkspace } from '../scripts/continue-studio-refinement.ts';
import type { ConversationMessage } from '../shared/conversations.ts';
import type { GitHubStatus } from '../shared/repositories.ts';
import type { Run } from '../shared/types.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const at = '2026-09-11T00:00:00.000Z';
const roles = ['research', 'design', 'development', 'quality'] as const;
const sourceNames = ['site/index.html', 'site/demo/index.html', 'site/demo/style.css', 'site/demo/app.js', 'site/demo/core.js', 'site/tests/core.test.cjs', 'site/README.md'];
function fixture() {
  const agentIds = { research: randomUUID(), design: randomUUID(), development: randomUUID(), quality: randomUUID() };
  const projectId = randomUUID(), teamId = randomUUID(), conversationId = randomUUID(), connectionId = randomUUID();
  const brief = 'Formnest 완성 작업입니다.\n\n최신 자료를 읽고 동료와 협력합니다.\n';
  const inputs: RefinementInputs = { launch: { key: 'studio-launch-20260907', ready: true, briefSha256: hash('original'), agentIds, projectId, teamId, conversationId },
    launchSha256: hash('launch'), originalBriefSha256: hash('original'), githubBriefSha256: hash('github'), briefSha256: hash(brief), brief };
  const workspace: RefinementWorkspace = { agents: roles.map(role => ({ id: agentIds[role], name: role, description: `[studio-launch-20260907/${role}]`, persona: role,
    color: '#000000', model: 'gpt-6-astra', status: 'idle', generation: 1, parentId: null, parentSnapshotId: null, version: 1, allowWeb: true,
    repositoryIds: [connectionId], createdAt: at, updatedAt: at })), runs: [], memories: [], skills: [], snapshots: [], activities: [], approvals: [],
    teams: [{ id: teamId, name: 'Studio', description: '', workflow: 'Original workflow', autoDiscoverTasks: true, memberIds: Object.values(agentIds), version: 1, createdAt: at, updatedAt: at }],
    projects: [{ id: projectId, name: 'Studio site', description: '', teamIds: [teamId], version: 1, createdAt: at, updatedAt: at }],
    conversations: [{ id: conversationId, scope: { type: 'project', id: projectId }, title: 'Workroom', participantAgentIds: Object.values(agentIds), createdAt: at, updatedAt: at,
      budgetProjectId: projectId, budgetTeamId: teamId }], conversationMessages: [],
    connections: [{ id: connectionId, repository: 'formnest-studio/studio-site', access: 'write', createdAt: at,
      github: { status: 'connected', repositoryId: 1362601656, defaultBranch: 'main', generation: randomUUID(), verifiedAt: at },
      grants: roles.map(role => ({ agentId: agentIds[role], projectId, teamId, access: role === 'research' || role === 'quality' ? 'read' : 'write' })) }],
    sharedArtifacts: sourceNames.map(name => ({ id: randomUUID(), scope: { type: 'project', id: projectId }, name, mediaType: 'text/plain', content: `current ${name}`,
      version: 4, authorAgentId: agentIds.development, history: [], createdAt: at, updatedAt: at })),
    runtime: { mode: 'docker', available: true, authenticated: true, image: 'sha256:existing', model: 'gpt-6-astra', message: '', version: '29' },
    resources: { capacity: { memoryMiB: 3072, cpus: 4 }, reserved: { memoryMiB: 0, cpus: 0 }, available: { memoryMiB: 3072, cpus: 4 }, running: [], waiting: [] } };
  const github: GitHubStatus = { configured: true, writable: true, missing: [], repositories: ['formnest-studio/studio-site'] };
  const persisted: RefinementManifest[] = [], posts: Array<{ path: string; payload: unknown }> = [];
  const effects: RefinementEffects = { persist: async record => { persisted.push(structuredClone(record)); }, post: async (path, payload) => {
    posts.push({ path, payload: structuredClone(payload) });
    return { id: randomUUID(), conversationId, senderAgentId: null, content: payload.content, mode: payload.mode, replyToId: null, sourceRunId: null,
      idempotencyKey: payload.idempotencyKey, budgetProjectId: projectId, budgetTeamId: teamId,
      deliveries: [{ agentId: agentIds.design, runId: randomUUID(), steeringIndex: null, status: 'delivered' }], createdAt: at };
  } };
  const prepare = () => continueRefinement('prepare', inputs, workspace, github, null, effects, at);
  return { inputs, workspace, github, persisted, posts, effects, prepare };
}

test('inspect is read-only and default preparation persists intent without POST or operational mutation', async () => {
  const f = fixture(), before = structuredClone(f.workspace);
  const inspected = await continueRefinement('inspect', f.inputs, f.workspace, f.github, null, f.effects, at);
  assert.equal(inspected.status, 'inspection-ready-not-started'); assert.equal(f.persisted.length, 0); assert.equal(f.posts.length, 0);
  const prepared = await f.prepare();
  assert.equal(prepared.status, 'prepared-not-started'); assert.equal(prepared.record.sources.length, 7); assert.equal(f.persisted.length, 1); assert.equal(f.posts.length, 0);
  assert.equal(prepared.record.agentIds.design, f.inputs.launch.agentIds.design); assert.equal(prepared.autoDiscoverTasksUnchanged, true);
  assert.deepEqual(f.workspace, before);
});

test('start requires preparation and sends exactly one canonical task to the existing design peer', async () => {
  const f = fixture();
  await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, null, f.effects, at), /--prepare/);
  assert.equal(f.posts.length, 0); assert.equal(f.persisted.length, 0);
  const { record } = await f.prepare(), original = structuredClone(record), before = structuredClone(f.workspace);
  const result = await continueRefinement('start', f.inputs, f.workspace, f.github, record, f.effects, at);
  assert.equal(result.status, 'one-design-task-recorded-not-yet-verified'); assert.equal(result.record.status, 'sent'); assert.equal(f.posts.length, 1);
  assert.deepEqual(f.persisted.map(item => item.status), ['prepared', 'dispatching', 'sent']);
  assert.equal(f.posts[0].path, `/api/conversations/${record.conversationId}/messages`);
  assert.deepEqual(f.posts[0].payload, { content: record.content.trim(), mode: 'task', recipientAgentId: record.agentIds.design, idempotencyKey: record.idempotencyKey });
  assert.ok(record.content.endsWith('\n')); assert.equal(result.record.content, record.content); assert.equal(result.record.contentSha256, hash(record.content));
  assert.deepEqual(record, original); assert.deepEqual(f.workspace, before);
});

test('current scope, read/write grants, authenticated runtime and all unfinished run states block starts', async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.workspace.teams[0].memberIds.pop(); }, f => { f.workspace.projects![0].teamIds.push(randomUUID()); },
    f => { f.workspace.conversations![0].budgetTeamId = randomUUID(); }, f => { f.workspace.conversations![0].participantAgentIds.pop(); },
    f => { f.workspace.agents[0].description = 'different identity'; }, f => { f.workspace.agents[0].status = 'paused'; },
    f => { f.workspace.connections[0].github!.repositoryId++; }, f => { f.workspace.connections[0].github!.defaultBranch = 'other'; },
    f => { f.workspace.connections[0].github!.status = 'disconnected'; }, f => { f.workspace.connections[0].grants![0].access = 'write'; },
    f => { f.workspace.connections[0].grants![1].teamId = randomUUID(); }, f => { f.workspace.agents[0].repositoryIds.push(randomUUID()); },
    f => { f.workspace.runtime.authenticated = false; }, f => { f.workspace.runtime.simulation = true; },
    f => { f.workspace.runtime.model = 'other'; }, f => { f.workspace.operatorPaused = true; },
    f => { f.github.repositories.push('other/repository'); }, f => { f.github.writable = false; },
    ...(['queued', 'starting', 'running', 'waiting', 'paused'] as const).map(status => (f: ReturnType<typeof fixture>) => {
      f.workspace.runs.push({ id: randomUUID(), agentId: f.inputs.launch.agentIds.quality, status } as Run);
    }),
  ];
  for (const mutate of mutations) {
    const f = fixture(), { record } = await f.prepare(); mutate(f);
    assert.ok(inspectRefinement(f.inputs, f.workspace, f.github).blockers.length);
    await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, record, f.effects, at)); assert.equal(f.posts.length, 0);
  }
});

test('preparation with a blocker cannot create a verified connection or start work', async () => {
  const f = fixture(); f.github.configured = false;
  const { record, status } = await f.prepare(); assert.equal(status, 'prepared-with-blockers-not-started'); assert.equal(record.connection, null); assert.deepEqual(record.sources, []);
  assert.equal(f.posts.length, 0); f.github.configured = true;
  await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, record, f.effects, at), /--prepare/);
});

test('latest project artifact identity and bytes are pinned, not old versions or another scope', async () => {
  const f = fixture(), { record } = await f.prepare();
  assert.equal(record.sources.find(item => item.name === 'site/index.html')!.sha256, hash(f.workspace.sharedArtifacts![0].content));
  f.workspace.sharedArtifacts![0].content = 'new current content'; f.workspace.sharedArtifacts![0].version++;
  await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, record, f.effects, at), /공유 자료가 변경/); assert.equal(f.posts.length, 0);
  const renewed = await continueRefinement('prepare', f.inputs, f.workspace, f.github, record, f.effects, at);
  assert.notDeepEqual(renewed.record.sources, record.sources); assert.equal(renewed.record.idempotencyKey, record.idempotencyKey);
  for (const mutate of [(w: RefinementWorkspace) => { w.sharedArtifacts![0].scope.id = randomUUID(); },
    (w: RefinementWorkspace) => { w.sharedArtifacts!.push(structuredClone(w.sharedArtifacts![0])); }]) {
    const other = fixture(); mutate(other.workspace); assert.ok(inspectRefinement(other.inputs, other.workspace, other.github).blockers.length);
  }
});

test('changed local intent, raw hash, team binding or repository generation cannot be silently repurposed', async () => {
  const f = fixture(), { record } = await f.prepare();
  for (const field of ['launchSha256', 'originalBriefSha256', 'githubBriefSha256', 'briefSha256', 'contentSha256'] as const) {
    await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, { ...record, [field]: hash('changed') }, f.effects, at));
  }
  await assert.rejects(continueRefinement('prepare', f.inputs, f.workspace, f.github, { ...record, content: `${record.content}altered` }, f.effects, at));
  await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, { ...record, teamId: randomUUID() }, f.effects, at));
  f.workspace.connections[0].github!.generation = randomUUID();
  await assert.rejects(continueRefinement('prepare', f.inputs, f.workspace, f.github, record, f.effects, at), /연결 세대/);
  assert.equal(f.posts.length, 0);
});

test('a lost response remains uncertain and never retries without observing the same canonical message', async () => {
  const f = fixture(), { record } = await f.prepare(); const normalPost = f.effects.post; let accepted: ConversationMessage | undefined;
  f.effects.post = async (path, payload) => { accepted = await normalPost(path, payload); throw Error('Lost response'); };
  await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, record, f.effects, at), /불명확/);
  const uncertain = f.persisted.at(-1)!; assert.equal(uncertain.status, 'uncertain'); assert.equal(f.posts.length, 1);
  for (const mode of ['prepare', 'start'] as const) await assert.rejects(continueRefinement(mode, f.inputs, f.workspace, f.github, uncertain, f.effects, at), /자동 재전송/);
  assert.equal(f.posts.length, 1); f.workspace.conversationMessages!.push(accepted!);
  // Recovery is readback, so active work or new artifacts after delivery are not reasons to repost.
  f.workspace.agents[1].status = 'running'; f.workspace.sharedArtifacts![0].version++;
  const recovered = await continueRefinement('prepare', f.inputs, f.workspace, f.github, uncertain, f.effects, at);
  assert.equal(recovered.status, 'existing-message-preserved-no-post'); assert.equal(recovered.record.messageId, accepted!.id); assert.equal(f.posts.length, 1);
  assert.equal(recovered.record.content, record.content); assert.equal(recovered.record.idempotencyKey, record.idempotencyKey);
});

test('lost local receipts retain the campaign key and recover existing work without POST', async () => {
  const f = fixture(), { record } = await f.prepare();
  assert.equal(refinementMessageKey(structuredClone(f.inputs.launch)), record.idempotencyKey);
  const message = await f.effects.post('/test-fixture-only', { content: record.content.trim(), mode: 'task', recipientAgentId: record.agentIds.design, idempotencyKey: record.idempotencyKey });
  f.posts.length = 0; f.workspace.conversationMessages = [message];
  const result = await continueRefinement('start', f.inputs, f.workspace, f.github, null, f.effects, at);
  assert.equal(result.status, 'existing-message-preserved-no-post'); assert.equal(f.posts.length, 0);
  const writes = f.persisted.length;
  assert.equal((await continueRefinement('inspect', f.inputs, f.workspace, f.github, result.record, f.effects, at)).status, 'existing-message-observed');
  assert.equal(f.persisted.length, writes);
});

test('same-key content, recipient, sender, budget, mode and duplicate receipt mismatches fail closed', async () => {
  const f = fixture(), { record } = await f.prepare();
  const message = await f.effects.post('/test-fixture-only', { content: record.content.trim(), mode: 'task', recipientAgentId: record.agentIds.design, idempotencyKey: record.idempotencyKey });
  assertRefinementMessage(message, record);
  for (const change of [{ content: `${message.content}\n` }, { content: message.content.replace('Formnest', 'Other') }, { senderAgentId: randomUUID() },
    { mode: 'discuss' as const }, { conversationId: randomUUID() }, { budgetTeamId: randomUUID() }, { budgetProjectId: null },
    { deliveries: [{ ...message.deliveries[0], agentId: record.agentIds.development }] }, { deliveries: [...message.deliveries, message.deliveries[0]] },
    { idempotencyKey: randomUUID() }, { sourceRunId: randomUUID() }, { replyToId: randomUUID() }]) assert.throws(() => assertRefinementMessage({ ...message, ...change }, record));
  f.workspace.conversationMessages = [message, { ...message, id: randomUUID() }]; f.posts.length = 0;
  await assert.rejects(continueRefinement('start', f.inputs, f.workspace, f.github, record, f.effects, at), /중복/); assert.equal(f.posts.length, 0);
});

test('the approved brief leaves design and task subdivision to peers and keeps deferred external actions separate', async () => {
  const brief = await readFile(new URL('../docs/launches/studio-refinement.md', import.meta.url), 'utf8');
  assert.match(brief, /기존 시안은 출발점이지 유지 조건이 아닙니다/); assert.match(brief, /분담 순서나 산출물 형식을 고정하지 않습니다/);
  assert.match(brief, /세부 과제는 같은 프로젝트·팀 안에서 생성/); assert.match(brief, /github_revise/); assert.match(brief, /기존 PR #1/);
  assert.match(brief, /이메일 주소의 공개 적용, 실제 문의 접수 연동/); assert.match(brief, /상위 목표 자동 생성 엔진이나 성장 시험은 이번 제작의 완료 조건이 아닙니다/);
  assert.match(brief, /최종 디자인 확인을 기다립니다/);
  const f = fixture(); f.inputs.brief = brief; f.inputs.briefSha256 = hash(brief);
  const content = refinementContent(f.inputs); assert.ok(content.length <= 20_000); assert.ok(content.includes(f.inputs.launch.agentIds.quality));
});
