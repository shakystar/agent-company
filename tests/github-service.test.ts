import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { GitHubOperationJournal } from '../server/github-journal.ts';
import { GitHubTransport, type GitHubPublishInput, type GitHubReviseInput, type GitHubPublication, type GitHubPullRequest } from '../server/github-transport.ts';
import { repositorySchemas, type GitHubPublicationResult, type RepositoryGrant } from '../shared/repositories.ts';
import type { PeerMessage, Project } from '../shared/collaboration.ts';
import type { Connection } from '../shared/types.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import { ContainerRuntime } from '../server/runtime.ts';

const repository = 'formnest-studio/studio';
const initialHead = 'a'.repeat(40), writtenHead = 'b'.repeat(40);
const forbidden = (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 403;
const writeArgs = (connectionId: string) => ({ connectionId, operationId: 'site-v1', expectedHeadSha: initialHead, files: [{ path: 'index.html', content: '<h1>Formnest</h1>' }], message: 'Publish site' });
type RemoteCall = { method: string; repository: string; signal?: AbortSignal; value?: unknown };
class FixtureGitHub {
  readonly calls: RemoteCall[] = [];
  info = { id: 100, fullName: repository, defaultBranch: 'main', private: true };
  prHead = 'agent-company/fixture/site-v1';
  response?: (call: RemoteCall) => Promise<void> | void;
  private async record(call: RemoteCall) { this.calls.push(call); await this.response?.(call); }
  async inspect(repository: string, signal?: AbortSignal) { await this.record({ method: 'inspect', repository, signal }); return { ...this.info }; }
  async listFiles(repository: string, ref: string, signal?: AbortSignal) {
    await this.record({ method: 'listFiles', repository, signal, value: ref });
    return { ref, headSha: initialHead, files: [{ path: 'README.md', sha: initialHead, size: 10 }], truncated: false as const, omittedFiles: 0 };
  }
  async readFile(repository: string, path: string, ref: string, signal?: AbortSignal) {
    await this.record({ method: 'readFile', repository, signal, value: { path, ref } });
    return { path, ref, headSha: initialHead, sha: initialHead, content: 'Public fixture text', encoding: 'utf-8' as const };
  }
  async publish(repository: string, value: GitHubPublishInput, signal?: AbortSignal): Promise<GitHubPublication> {
    await this.record({ method: 'publish', repository, signal, value });
    this.prHead = value.branch;
    return { branch: value.branch, headSha: writtenHead, commitUrl: `https://github.com/${repository}/commit/${writtenHead}`, unchanged: false, replayed: false };
  }
  async revise(repository: string, value: GitHubReviseInput, signal?: AbortSignal) {
    await this.record({ method: 'revise', repository, signal, value });
    return { number: value.number, url: `https://github.com/${repository}/pull/${value.number}`, branch: value.branch,
      headSha: 'c'.repeat(40), commitUrl: `https://github.com/${repository}/commit/${'c'.repeat(40)}`, unchanged: false, replayed: false };
  }
  async pullRequest(repository: string, value: { head: string; base: string; title: string; body: string }, signal?: AbortSignal): Promise<GitHubPullRequest> {
    await this.record({ method: 'pullRequest', repository, signal, value });
    return { number: 1, url: `https://github.com/${repository}/pull/1`, head: value.head, base: value.base, headSha: writtenHead, baseSha: initialHead, state: 'open', existing: false, title: value.title, body: value.body };
  }
  async getPullRequest(repository: string, number: number, signal?: AbortSignal): Promise<GitHubPullRequest> {
    await this.record({ method: 'getPullRequest', repository, signal, value: number });
    return { number, url: `https://github.com/${repository}/pull/${number}`, head: this.prHead, base: 'main', headSha: writtenHead, baseSha: initialHead, state: 'open', existing: true, title: 'Site', body: '' };
  }
}
async function until(check: () => boolean | Promise<boolean>, message = 'Fixture worker did not reach expected state') {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
async function fixture(t: TestContext, access: 'read' | 'write' | 'none' = 'write', persistent = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-github-service-'));
  const runtime = new StorageFixtureRuntime(randomUUID()), remote = new FixtureGitHub();
  const journal = await GitHubOperationJournal.open({ directory: join(directory, 'github-journal'), ownerKey: randomUUID() });
  const open = () => AgentService.create({ runtime,
    ...(persistent ? { dataDir: join(directory, 'data', 'db'), storage: { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'),
      ownerKey: runtime.key, freeSpace: async () => 100 * 1024 ** 3 } } : {}),
    github: { transport: remote, journal,
    status: () => ({ configured: true, writable: true, missing: [], repositories: [repository] }) } });
  let service = await open();
  t.after(async () => {
    await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /ac-github-service-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  const agent = await service.createAgent({ name: 'Studio developer', persona: 'Implement the studio' });
  const peer = await service.createAgent({ name: 'QA peer', persona: 'Review work' });
  const team = await service.createTeam({ name: 'Studio', memberIds: [agent.id, peer.id] });
  const otherTeam = await service.createTeam({ name: 'Separate team', memberIds: [agent.id] });
  const project = await service.collaboration('project_create', { name: 'Studio project', teamIds: [team.id, otherTeam.id] }) as Project;
  const otherProject = await service.collaboration('project_create', { name: 'Separate project', teamIds: [team.id] }) as Project;
  const registered = await service.createConnection({ repository, access: 'write' });
  await service.verifyConnection(registered.id);
  const current = async (): Promise<Connection> => (await service.workspace()).connections.find(c => c.id === registered.id)!;
  const update = async (changes: object) => service.updateConnection(registered.id, { expectedVersion: (await current()).version ?? 0, ...changes });
  const grant = (access: 'read' | 'write' = 'write'): RepositoryGrant => ({ agentId: agent.id, teamId: team.id, projectId: project.id, access });
  if (access !== 'none') await update({ grants: [grant(access)] });
  const start = async (agentId = agent.id, projectId = project.id, teamId = team.id) => {
    const run = await service.startRun(agentId, 'Work within the explicit project scope', projectId, teamId);
    await until(() => runtime.calls.some(call => call.input.run.id === run.id));
    const execution = runtime.calls.find(call => call.input.run.id === run.id)!;
    return { run, execution, tool: execution.hooks.onTool! };
  };
  const stop = async (runId: string) => {
    const run = await service.cancelRun(runId);
    await until(async () => (await service.workspace()).agents.find(item => item.id === run.agentId)?.status !== 'running', 'Cancelled fixture worker did not finish cleanup');
  };
  const restart = async () => { assert.equal(persistent, true); await service.close(); service = await open(); };
  return { directory, runtime, remote, journal, get service() { return service; }, restart, agent, peer, team, otherTeam, project, otherProject, connectionId: registered.id, current, update, grant, start, stop };
}

test('actual GitHub tools require the intersection of current agent, project, team and frozen run grants', async t => {
  const f = await fixture(t);
  const allowed = await f.start();
  const listed = await allowed.tool('github_files', { connectionId: f.connectionId }) as { headSha: string };
  assert.equal(listed.headSha, initialHead); assert.equal(f.remote.calls.at(-1)!.repository, repository);
  assert.ok(allowed.execution.input.collaboration?.tools.some(tool => tool.name === 'github_read'));
  await f.stop(allowed.run.id);
  const wrongTeam = await f.start(f.agent.id, f.project.id, f.otherTeam.id), beforeTeam = f.remote.calls.length;
  await assert.rejects(wrongTeam.tool('github_repository', { connectionId: f.connectionId }), forbidden);
  assert.equal(f.remote.calls.length, beforeTeam); await f.stop(wrongTeam.run.id);
  const wrongProject = await f.start(f.agent.id, f.otherProject.id, f.team.id), beforeProject = f.remote.calls.length;
  await assert.rejects(wrongProject.tool('github_read', { connectionId: f.connectionId, path: 'README.md' }), forbidden);
  assert.equal(f.remote.calls.length, beforeProject);
  const wrongAgent = await f.start(f.peer.id), beforeAgent = f.remote.calls.length;
  await assert.rejects(wrongAgent.tool('github_files', { connectionId: f.connectionId }), forbidden); assert.equal(f.remote.calls.length, beforeAgent);
});

test('cross-team inbox delivery handles the message without requiring or inheriting repository access', async t => {
  const f = await fixture(t);
  await f.service.updateTeam(f.otherTeam.id, { memberIds: [f.peer.id] });
  const origin = await f.start(f.peer.id, f.project.id, f.otherTeam.id);
  const scope = { type: 'project', id: f.project.id };
  const message = await origin.tool('message_send', { scope, recipientAgentId: f.agent.id,
    content: 'Please confirm the delivery schedule', idempotencyKey: randomUUID() }) as PeerMessage;
  await until(() => f.runtime.calls.some(call => call.input.run.messageIds?.includes(message.id)));
  const delivery = f.runtime.calls.find(call => call.input.run.messageIds?.includes(message.id))!;
  assert.equal(delivery.input.run.budgetTeamId, f.otherTeam.id);
  assert.equal(delivery.input.run.budgetProjectId, f.project.id);
  assert.equal(delivery.input.run.budgetRootRunId, origin.run.id);
  assert.deepEqual(delivery.input.agent.repositoryIds, []);
  assert.deepEqual(delivery.input.connections, []);
  assert.equal(delivery.input.repositoryTransport, undefined);
  assert.equal(delivery.input.collaboration?.tools.some(tool => tool.name.startsWith('github_')), false);
  assert.ok(delivery.input.collaboration?.tools.some(tool => tool.name === 'message_send'));
  assert.match(delivery.input.run.prompt, /저장소 없이/);
  // Run the production runtime admission too: fake only the command transport.
  // The original payload failed before launching any task because repo IDs remained.
  let taskStarted = false;
  const driver = new ContainerRuntime({ mode: 'docker', auth: 'api-key', apiKey: 'fixture-only', authFile: '',
    image: 'worker:test', model: 'fixture', timeoutMs: 10_000 }, async (_file, args, options = {}) => {
    if (args[0] === 'run') {
      const payload = JSON.parse(options.input!);
      assert.equal(payload.phase, 'task'); taskStarted = true;
      await options.onLine?.(JSON.stringify({ type: 'result', result: { result: 'Message received',
        memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0 } }));
    }
    return { code: 0, stdout: 'ok', stderr: '' };
  });
  await driver.execute(delivery.input, { signal: new AbortController().signal, onEvent: async () => {}, getSteering: async () => [] });
  assert.equal(taskStarted, true);
  const reply = await delivery.hooks.onTool!('message_send', { scope, recipientAgentId: f.peer.id,
    replyToId: message.id, content: 'Schedule request received', idempotencyKey: randomUUID() }) as PeerMessage;
  assert.equal(reply.budgetTeamId, f.otherTeam.id);
  const before = f.remote.calls.length;
  await assert.rejects(delivery.hooks.onTool!('github_read', { connectionId: f.connectionId, path: 'README.md' }), forbidden);
  // Later membership/grants cannot widen this already frozen delivery.
  await f.service.updateTeam(f.otherTeam.id, { memberIds: [f.peer.id, f.agent.id] });
  await f.update({ grants: [f.grant(), { ...f.grant(), teamId: f.otherTeam.id }] });
  await assert.rejects(delivery.hooks.onTool!('github_publish', writeArgs(f.connectionId)), forbidden);
  assert.equal(f.remote.calls.length, before);
  assert.deepEqual((await f.service.workspace()).agents.find(agent => agent.id === f.agent.id)!.repositoryIds, [f.connectionId]);
  await f.stop(delivery.input.run.id);
  const own = await f.start();
  assert.equal(own.execution.input.repositoryTransport, 'github-app-v1');
  await own.tool('github_files', { connectionId: f.connectionId });
});

test('repository-free cross-team delivery stays frozen across controller restart and later grants', async t => {
  const f = await fixture(t, 'write', true);
  await f.service.updateTeam(f.otherTeam.id, { memberIds: [f.peer.id] });
  const origin = await f.start(f.peer.id, f.project.id, f.otherTeam.id);
  const message = await origin.tool('message_send', { scope: { type: 'project', id: f.project.id },
    recipientAgentId: f.agent.id, content: 'Confirm a shared schedule', idempotencyKey: randomUUID() }) as PeerMessage;
  await until(() => f.runtime.calls.some(call => call.input.run.messageIds?.includes(message.id)));
  const first = f.runtime.calls.find(call => call.input.run.messageIds?.includes(message.id))!;
  await first.hooks.onCheckpoint!({ phase: 'task', sessionId: 'saved-cross-team-delivery' });
  await f.service.updateTeam(f.otherTeam.id, { memberIds: [f.peer.id, f.agent.id] });
  await f.update({ grants: [f.grant(), { ...f.grant(), teamId: f.otherTeam.id }] });
  const start = f.runtime.calls.length, remoteCalls = f.remote.calls.length;
  await f.restart();
  await until(() => f.runtime.calls.slice(start).some(call => call.input.run.id === first.input.run.id));
  const resumed = f.runtime.calls.slice(start).find(call => call.input.run.id === first.input.run.id)!;
  assert.deepEqual(resumed.input.agent.repositoryIds, []);
  assert.deepEqual(resumed.input.connections, []);
  assert.equal(resumed.input.repositoryTransport, undefined);
  assert.equal(resumed.input.run.budgetTeamId, f.otherTeam.id);
  assert.equal(resumed.input.checkpoint?.sessionId, 'saved-cross-team-delivery');
  await assert.rejects(resumed.hooks.onTool!('github_repository', { connectionId: f.connectionId }), forbidden);
  assert.equal(f.remote.calls.length, remoteCalls);
});

test('same-team inbox delivery keeps repository requirements and current revocation checks', async t => {
  const f = await fixture(t), origin = await f.start(f.peer.id);
  const message = await origin.tool('message_send', { scope: { type: 'project', id: f.project.id },
    recipientAgentId: f.agent.id, content: 'Check the shared source', idempotencyKey: randomUUID() }) as PeerMessage;
  await until(() => f.runtime.calls.some(call => call.input.run.messageIds?.includes(message.id)));
  const delivery = f.runtime.calls.find(call => call.input.run.messageIds?.includes(message.id))!;
  assert.deepEqual(delivery.input.agent.repositoryIds, [f.connectionId]);
  assert.equal(delivery.input.repositoryTransport, 'github-app-v1');
  await delivery.hooks.onTool!('github_files', { connectionId: f.connectionId });
  await f.update({ grants: [] });
  const before = f.remote.calls.length;
  await assert.rejects(delivery.hooks.onTool!('github_files', { connectionId: f.connectionId }), forbidden);
  assert.equal(f.remote.calls.length, before);
});

test('project conversation delivery from another billing team can answer without repository access', async t => {
  const f = await fixture(t);
  await f.service.updateTeam(f.otherTeam.id, { memberIds: [f.peer.id] });
  const conversation = await f.service.createConversation({ scope: { type: 'project', id: f.project.id },
    title: 'Cross-team coordination', budgetTeamId: f.otherTeam.id, idempotencyKey: randomUUID() });
  const message = await f.service.sendConversation(conversation.id, { content: 'Confirm the schedule',
    mode: 'task', recipientAgentId: f.agent.id, idempotencyKey: randomUUID() });
  await until(() => f.runtime.calls.some(call => call.input.run.conversationMessageId === message.id));
  const delivery = f.runtime.calls.find(call => call.input.run.conversationMessageId === message.id)!;
  assert.equal(delivery.input.run.budgetTeamId, f.otherTeam.id);
  assert.deepEqual(delivery.input.agent.repositoryIds, []);
  assert.deepEqual(delivery.input.connections, []);
  const before = f.remote.calls.length;
  await assert.rejects(delivery.hooks.onTool!('github_repository', { connectionId: f.connectionId }), forbidden);
  delivery.finish();
  await until(async () => (await f.service.getConversation(conversation.id)).messages.find(item => item.id === message.id)?.deliveries[0].status === 'answered');
  assert.equal(f.remote.calls.length, before);
});

test('grants added or upgraded after a run starts cannot widen its frozen scope', async t => {
  const f = await fixture(t, 'none'); const started = await f.start();
  await f.update({ grants: [f.grant()] }); const before = f.remote.calls.length;
  await assert.rejects(started.tool('github_repository', { connectionId: f.connectionId }), forbidden); assert.equal(f.remote.calls.length, before);
  await f.stop(started.run.id);
  await f.update({ grants: [f.grant('read')] }); const readonly = await f.start();
  await f.update({ grants: [f.grant('write')] });
  await assert.rejects(readonly.tool('github_publish', writeArgs(f.connectionId)), forbidden);
  assert.equal(f.remote.calls.filter(call => call.method === 'publish').length, 0);
  await readonly.tool('github_files', { connectionId: f.connectionId });
});

test('revocation during an in-flight read suppresses delivery and prevents further remote calls', async t => {
  const f = await fixture(t); const started = await f.start(); let complete: (() => void) | undefined;
  f.remote.response = call => call.method === 'readFile' ? new Promise<void>(resolve => { complete = resolve; }) : undefined;
  const pending = started.tool('github_read', { connectionId: f.connectionId, path: 'README.md' });
  const rejected = assert.rejects(pending);
  await until(() => Boolean(complete));
  await f.update({ grants: [] }); assert.equal(f.remote.calls.at(-1)!.signal?.aborted, true);
  complete!(); await rejected;
  const before = f.remote.calls.length;
  await assert.rejects(started.tool('github_files', { connectionId: f.connectionId }), forbidden); assert.equal(f.remote.calls.length, before);
  assert.doesNotMatch(JSON.stringify(await f.service.workspace()), /Public fixture text/);
});

test('live team membership, project association and agent selections independently revoke old runs', async t => {
  for (const kind of ['team', 'project', 'agent'] as const) {
    await t.test(kind, async sub => {
      const f = await fixture(sub); const started = await f.start();
      if (kind === 'team') await f.service.updateTeam(f.team.id, { memberIds: [f.peer.id] });
      if (kind === 'project') await f.service.collaboration('project_update', { projectId: f.project.id, expectedVersion: f.project.version, name: f.project.name, description: f.project.description, teamIds: [f.otherTeam.id] });
      if (kind === 'agent') await f.service.updateAgent(f.agent.id, { repositoryIds: [] });
      const before = f.remote.calls.length;
      await assert.rejects(started.tool('github_repository', { connectionId: f.connectionId }), forbidden); assert.equal(f.remote.calls.length, before);
    });
  }
});

test('disconnection, reconnection and changed GitHub identity invalidate older run generations', async t => {
  const f = await fixture(t); const started = await f.start(); const before = await f.current();
  await f.update({ enabled: false }); await assert.rejects(started.tool('github_files', { connectionId: f.connectionId }), forbidden);
  const reconnected = await f.service.verifyConnection(f.connectionId); assert.notEqual(reconnected.github!.generation, before.github!.generation);
  await assert.rejects(started.tool('github_files', { connectionId: f.connectionId }), forbidden);
  await f.stop(started.run.id); const next = await f.start();
  f.remote.info.id += 1; await f.service.verifyConnection(f.connectionId);
  await assert.rejects(next.tool('github_repository', { connectionId: f.connectionId }), forbidden);
});

test('cloning a connected agent never clones its project and team grants', async t => {
  const f = await fixture(t); const clone = await f.service.forkAgent(f.agent.id, { name: 'Cloned developer' });
  assert.equal((await f.current()).grants!.some(grant => grant.agentId === clone.id), false);
  await f.service.updateTeam(f.team.id, { memberIds: [f.agent.id, f.peer.id, clone.id] });
  const cloned = await f.start(clone.id), before = f.remote.calls.length;
  assert.equal(cloned.execution.input.collaboration?.tools.some(tool => tool.name.startsWith('github_')) ?? false, false);
  await assert.rejects(cloned.tool('github_files', { connectionId: f.connectionId }), forbidden); assert.equal(f.remote.calls.length, before);
});

test('read-only repository grants expose no write tools and reject forged write calls', async t => {
  const f = await fixture(t, 'read'); const started = await f.start();
  await assert.rejects(started.tool('github_publish', writeArgs(f.connectionId)), forbidden);
  const names = started.execution.input.collaboration!.tools.map(tool => tool.name);
  assert.ok(names.includes('github_read')); assert.equal(names.includes('github_publish'), false); assert.equal(names.includes('github_pull_request'), false);
  assert.equal(f.remote.calls.filter(call => call.method === 'publish').length, 0);
});

test('discussion runs retain read tools but reject writes even with a full repository grant', async t => {
  const f = await fixture(t);
  const conversation = await f.service.createConversation({ scope: { type: 'project', id: f.project.id }, budgetTeamId: f.team.id, idempotencyKey: randomUUID() });
  await f.service.sendConversation(conversation.id, { content: 'Explain the repository', mode: 'discuss', recipientAgentId: f.agent.id, idempotencyKey: randomUUID() });
  await until(() => f.runtime.calls.length === 1); const execution = f.runtime.calls[0], names = execution.input.collaboration!.tools.map(tool => tool.name);
  assert.equal(execution.input.run.interactionMode, 'discuss'); assert.ok(names.includes('github_read')); assert.equal(names.includes('github_publish'), false);
  await assert.rejects(execution.hooks.onTool!('github_publish', writeArgs(f.connectionId)), forbidden);
  await execution.hooks.onTool!('github_repository', { connectionId: f.connectionId });
});

test('publication selects a deterministic run-owned branch and journal retries are immutable', async t => {
  const f = await fixture(t); const started = await f.start(), args = writeArgs(f.connectionId);
  for (const extra of [{ branch: 'main' }, { baseBranch: 'main' }, { force: true }, { repository: 'shakystar/private' }, { files: [{ path: 'x', content: 'x', sha: null }] }]) {
    assert.equal(repositorySchemas.github_publish.safeParse({ ...args, ...extra }).success, false);
    await assert.rejects(started.tool('github_publish', { ...args, ...extra }));
  }
  const first = await started.tool('github_publish', args) as GitHubPublicationResult;
  assert.equal(first.publicationId, args.operationId);
  assert.equal(first.branch, `agent-company/${started.run.id}/${args.operationId}`);
  const actual = f.remote.calls.find(call => call.method === 'publish')!.value as GitHubPublishInput;
  assert.equal(actual.branch, first.branch); assert.equal(actual.baseBranch, 'main'); assert.equal(actual.expectedHeadSha, initialHead);
  assert.deepEqual(await started.tool('github_publish', args), first);
  await assert.rejects(started.tool('github_publish', { ...args, message: 'Changed intent' }), /작업 키/);
  assert.equal(f.remote.calls.filter(call => call.method === 'publish').length, 1);
  const prArgs = { connectionId: f.connectionId, operationId: 'pr-v1', publicationId: first.publicationId, title: 'Site', body: 'Review the site' };
  const pr = await started.tool('github_pull_request', prArgs) as GitHubPullRequest;
  assert.equal(pr.head, first.branch); assert.equal(pr.base, 'main');
  assert.equal('title' in pr, false); assert.equal('body' in pr, false);
  const records = await readdir(join(f.directory, 'github-journal'));
  const recorded = (await Promise.all(records.filter(name => name.endsWith('.json')).map(name => readFile(join(f.directory, 'github-journal', name), 'utf8')))).join('\n');
  assert.doesNotMatch(recorded, /Review the site/);
  assert.doesNotMatch(JSON.stringify((await f.service.workspace()).activities), /Review the site/);
  assert.deepEqual(await started.tool('github_pull_request', prArgs), pr); assert.equal(f.remote.calls.filter(call => call.method === 'pullRequest').length, 1);
  await f.update({ grants: [] }); const remoteCount = f.remote.calls.length;
  await assert.rejects(started.tool('github_publish', args), forbidden); assert.equal(f.remote.calls.length, remoteCount);
});

test('legacy publication receipts expose the PR handle on replay without rewriting or publishing again', async t => {
  const f = await fixture(t); const started = await f.start(), args = writeArgs(f.connectionId);
  const connection = await f.current();
  const key = `${started.run.id}/${connection.github!.generation}/github_publish/${args.operationId}`;
  const legacy: GitHubPublication = { branch: `agent-company/${started.run.id}/${args.operationId}`, headSha: writtenHead,
    commitUrl: `https://github.com/${repository}/commit/${writtenHead}`, unchanged: false, replayed: false };
  const operation = { key, runId: started.run.id, agentId: f.agent.id, connectionId: f.connectionId, repository,
    operation: 'github_publish', fingerprint: createHash('sha256').update(JSON.stringify(repositorySchemas.github_publish.parse(args))).digest('hex') };
  await f.journal.execute(operation, async () => legacy);
  const recordPath = join(f.journal.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  const before = await readFile(recordPath, 'utf8');
  assert.equal('publicationId' in JSON.parse(before).result, false);

  const publication = await started.tool('github_publish', args) as GitHubPublicationResult;
  assert.deepEqual(publication, { ...legacy, publicationId: args.operationId });
  assert.deepEqual(await started.tool('github_publish', args), publication);
  assert.equal(f.remote.calls.filter(call => call.method === 'publish').length, 0);
  assert.equal(await readFile(recordPath, 'utf8'), before);
  assert.deepEqual(await f.journal.execute(operation, async () => assert.fail('A completed legacy receipt must not dispatch')), legacy);
  await assert.rejects(started.tool('github_publish', { ...args, message: 'Changed intent' }), /작업 키/);
  assert.equal(await readFile(recordPath, 'utf8'), before);

  const pr = await started.tool('github_pull_request', { connectionId: f.connectionId, operationId: 'pr-from-legacy',
    publicationId: publication.publicationId, title: 'Site', body: 'Review the existing publication' }) as GitHubPullRequest;
  assert.equal(pr.head, legacy.branch); assert.equal(pr.headSha, legacy.headSha);
  assert.equal(f.remote.calls.filter(call => call.method === 'pullRequest').length, 1);
  assert.equal(f.remote.calls.filter(call => call.method === 'publish').length, 0);
  assert.equal(await readFile(recordPath, 'utf8'), before);
});

const revisionArgs = (connectionId: string) => ({ ...writeArgs(connectionId), number: 1, operationId: 'revise-copy', expectedHeadSha: writtenHead,
  files: [{ path: 'index.html', content: '<h1>Improved studio</h1>' }], message: 'Improve copy' });

test('same Run and later authorized teammate revise the original PR without rewriting its legacy publication receipt', async t => {
  const f = await fixture(t), first = await f.start();
  const published = await first.tool('github_publish', writeArgs(f.connectionId)) as GitHubPublicationResult;
  const connection = await f.current(), key = `${first.run.id}/${connection.github!.generation}/github_publish/site-v1`;
  const recordPath = join(f.journal.directory, `${createHash('sha256').update(key).digest('hex')}.json`), before = await readFile(recordPath, 'utf8');
  const same = await first.tool('github_revise', revisionArgs(f.connectionId)) as GitHubPublication;
  assert.equal(same.branch, published.branch); assert.notEqual(same.headSha, published.headSha);
  assert.deepEqual(await first.tool('github_revise', revisionArgs(f.connectionId)), same);
  await assert.rejects(first.tool('github_revise', { ...revisionArgs(f.connectionId), message: 'Different input, same ID' }), /작업 키/);
  await f.stop(first.run.id);
  // The original author can leave. Authority comes from the recipient's current
  // and frozen grants, plus the original recorded scope, not an old live grant.
  await f.update({ grants: [{ ...f.grant(), agentId: f.peer.id }] });
  await f.service.updateTeam(f.team.id, { memberIds: [f.peer.id] });
  const next = await f.start(f.peer.id);
  assert.ok(next.execution.input.collaboration!.tools.some(tool => tool.name === 'github_revise'));
  const result = await next.tool('github_revise', { ...revisionArgs(f.connectionId), operationId: 'peer-revision' }) as GitHubPublication;
  assert.equal(result.branch, published.branch);
  const revisions = f.remote.calls.filter(call => call.method === 'revise'); assert.equal(revisions.length, 2);
  for (const call of revisions) { const args = call.value as GitHubReviseInput; assert.equal(args.number, 1); assert.equal(args.branch, published.branch); assert.equal(args.baseBranch, 'main'); assert.equal(args.expectedHeadSha, writtenHead); }
  assert.equal(f.remote.calls.filter(call => call.method === 'publish').length, 1);
  assert.equal(await readFile(recordPath, 'utf8'), before);
});

test('write access to the repository does not transfer another project or team publication', async t => {
  const f = await fixture(t), first = await f.start(); await first.tool('github_publish', writeArgs(f.connectionId)); await f.stop(first.run.id);
  await f.update({ grants: [f.grant(), { ...f.grant(), teamId: f.otherTeam.id }, { ...f.grant(), projectId: f.otherProject.id }] });
  for (const [projectId, teamId] of [[f.project.id, f.otherTeam.id], [f.otherProject.id, f.team.id]]) {
    const next = await f.start(f.agent.id, projectId, teamId);
    await next.tool('github_repository', { connectionId: f.connectionId });
    await assert.rejects(next.tool('github_revise', revisionArgs(f.connectionId)), forbidden);
    await f.stop(next.run.id);
  }
  assert.equal(f.remote.calls.filter(call => call.method === 'revise').length, 0);
});

test('matching PR branch names without a completed publication receipt do not grant revision authority', async t => {
  const f = await fixture(t), origin = await f.start();
  f.remote.prHead = `agent-company/${origin.run.id}/site-v1`;
  await assert.rejects(origin.tool('github_revise', revisionArgs(f.connectionId)), /완료 영수증/);
  const connection = await f.current();
  const operation = { key: `${origin.run.id}/${connection.github!.generation}/github_publish/site-v1`, runId: origin.run.id,
    agentId: f.agent.id, connectionId: f.connectionId, repository, operation: 'github_publish', fingerprint: 'a'.repeat(64) };
  await assert.rejects(f.journal.execute(operation, async () => { throw new Error('Uncertain publication'); }));
  await assert.rejects(origin.tool('github_revise', { ...revisionArgs(f.connectionId), operationId: 'uncertain-origin' }), /완료 상태 또는 귀속/);
  f.remote.prHead = `agent-company/${randomUUID()}/site-v1`;
  await assert.rejects(origin.tool('github_revise', { ...revisionArgs(f.connectionId), operationId: 'forged-origin' }), forbidden);
  assert.equal(f.remote.calls.filter(call => call.method === 'revise').length, 0);
});

test('reconnection invalidates old publication authority even for a newly authorized Run', async t => {
  const f = await fixture(t), origin = await f.start(); await origin.tool('github_publish', writeArgs(f.connectionId)); await f.stop(origin.run.id);
  const previous = await f.current(); await f.update({ enabled: false }); await f.service.verifyConnection(f.connectionId);
  assert.notEqual((await f.current()).github!.generation, previous.github!.generation);
  await f.update({ grants: [f.grant()] });
  const current = await f.start(); await current.tool('github_files', { connectionId: f.connectionId });
  await assert.rejects(current.tool('github_revise', revisionArgs(f.connectionId)), forbidden);
  assert.equal(f.remote.calls.filter(call => call.method === 'revise').length, 0);
});

test('real backup restore preserves old receipts but never reauthorizes their publication generation', async t => {
  const f = await fixture(t, 'write', true), origin = await f.start();
  await origin.tool('github_publish', writeArgs(f.connectionId));
  origin.execution.finish(); await until(async () => (await f.service.workspace()).runs.find(run => run.id === origin.run.id)?.status === 'succeeded');
  const before = await f.current();
  const receiptLookup = { key: `${origin.run.id}/${before.github!.generation}/github_publish/site-v1`, runId: origin.run.id,
    agentId: f.agent.id, connectionId: f.connectionId, repository, operation: 'github_publish' };
  const receipt = await f.journal.completed(receiptLookup);
  const backup = (await f.service.createBackup()).backups[0];
  const prepared = await f.service.prepareRestore(backup.id); await f.service.activateRestore(prepared.id);
  assert.deepEqual(await f.journal.completed(receiptLookup), receipt);
  const restored = await f.current(); assert.equal(restored.github!.status, 'disconnected'); assert.deepEqual(restored.grants, []);
  assert.notEqual(restored.github!.generation, before.github!.generation);
  await f.service.resumeStorage(); await f.service.verifyConnection(f.connectionId); await f.update({ grants: [f.grant()] });
  const next = await f.start(); await next.tool('github_repository', { connectionId: f.connectionId });
  await assert.rejects(next.tool('github_revise', revisionArgs(f.connectionId)), forbidden);
  assert.equal(f.remote.calls.filter(call => call.method === 'revise').length, 0);
});

test('revision keeps current and frozen write checks and strict caller inputs', async t => {
  const f = await fixture(t), origin = await f.start(); await origin.tool('github_publish', writeArgs(f.connectionId)); await f.stop(origin.run.id);
  await f.update({ grants: [f.grant('read')] }); const readonly = await f.start();
  await f.update({ grants: [f.grant('write')] });
  assert.equal(readonly.execution.input.collaboration!.tools.some(tool => tool.name === 'github_revise'), false);
  await assert.rejects(readonly.tool('github_revise', revisionArgs(f.connectionId)), forbidden); await f.stop(readonly.run.id);
  const next = await f.start();
  for (const extra of [{ branch: 'main' }, { sourceRunId: origin.run.id }, { force: true }, { baseBranch: 'main' }, { repositoryId: 100 }]) {
    assert.equal(repositorySchemas.github_revise.safeParse({ ...revisionArgs(f.connectionId), ...extra }).success, false);
    await assert.rejects(next.tool('github_revise', { ...revisionArgs(f.connectionId), ...extra }));
  }
  await f.update({ grants: [] }); await assert.rejects(next.tool('github_revise', revisionArgs(f.connectionId)), forbidden);
  assert.equal(f.remote.calls.filter(call => call.method === 'revise').length, 0);
});

test('write receipt survives permission revocation after dispatch without delivering a stale success', async t => {
  const f = await fixture(t); const started = await f.start(); let complete: (() => void) | undefined;
  f.remote.response = call => call.method === 'publish' ? new Promise<void>(resolve => { complete = resolve; }) : undefined;
  const pending = started.tool('github_publish', writeArgs(f.connectionId)); const rejected = assert.rejects(pending);
  await until(() => Boolean(complete)); await f.update({ grants: [] }); complete!(); await rejected;
  const records = await Promise.all((await readdir(f.journal.directory)).filter(name => name !== 'identity.json' && name.endsWith('.json')).map(name => readFile(join(f.journal.directory, name), 'utf8').then(JSON.parse)));
  assert.equal(records.length, 1); assert.equal(records[0].status, 'completed'); assert.equal(records[0].result.headSha, writtenHead);
  assert.equal((await f.service.workspace()).activities.some(activity => activity.runId === started.run.id && activity.title === 'github_publish'), false);
});

test('credentials never enter worker inputs, workspace or journal; network errors remain sanitized', async t => {
  const f = await fixture(t); const secret = 'PRIVATE-INSTALLATION-TOKEN-DO-NOT-PERSIST';
  const unsafe = new GitHubTransport({ token: async () => secret, fetch: async () => { throw new Error(`Remote failure ${secret}`); } });
  const started = await f.start();
  await started.tool('github_publish', writeArgs(f.connectionId));
  f.remote.response = call => call.method === 'inspect' ? unsafe.inspect(repository).then(() => undefined) : undefined;
  await assert.rejects(started.tool('github_repository', { connectionId: f.connectionId }), error => error instanceof Error && !String(error).includes(secret));
  assert.equal(JSON.stringify(started.execution.input).includes(secret), false); assert.equal(JSON.stringify(await f.service.workspace()).includes(secret), false);
  for (const name of (await readdir(f.journal.directory)).filter(name => name.endsWith('.json'))) {
    const record = await readFile(join(f.journal.directory, name), 'utf8'); assert.equal(record.includes(secret), false); assert.equal(record.includes('<h1>Formnest</h1>'), false);
  }
});

test('connection updates reject stale expectedVersion and invalid cross-team grants', async t => {
  const f = await fixture(t); const before = await f.current();
  await f.update({ grants: [f.grant('read')] });
  await assert.rejects(f.service.updateConnection(f.connectionId, { expectedVersion: before.version, grants: [] }), /연결 설정이 변경/);
  await assert.rejects(f.update({ grants: [{ ...f.grant(), agentId: f.peer.id, teamId: f.otherTeam.id }] }), forbidden);
  await assert.rejects(f.update({ access: 'read', grants: [f.grant('write')] }), /읽기 전용/);
});
