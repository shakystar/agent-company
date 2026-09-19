import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { GitHubTransport } from '../server/github-transport.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import type { Project } from '../shared/collaboration.ts';
import { repositorySchemas, repositoryTools, repositoryJsonBytes, repositoryResultEncodedBytes,
  GITHUB_REQUEST_JSON_MAX_BYTES, GITHUB_RESULT_ENCODED_MAX_BYTES, GITHUB_READ_MAX_BYTES, type RepositoryOperation } from '../shared/repositories.ts';

// Exercise the unchanged source copied into the worker image: both controller
// JSONL input and the Unix-socket/Windows-pipe MCP JSON-in-text response path.
const { createTeamBridge, createWorkerChannel } = await import(new URL('../worker/team-mcp.mjs', import.meta.url).href);
const head = 'a'.repeat(40), tree = 'b'.repeat(40), repository = 'formnest-studio/studio';
const blobSha = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
async function harness(t: TestContext, perform: (name: RepositoryOperation, args: any) => Promise<unknown> | unknown,
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = repositoryTools) {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ac-github-bridge-${randomUUID()}` : join(tmpdir(), `ac-github-bridge-${randomUUID()}.sock`);
  const stream = new PassThrough(), channel = createWorkerChannel(stream);
  stream.write('{"interactiveCollaboration":true}\n'); await channel.payload;
  const requests: unknown[] = [], responseLines: string[] = [];
  const bridge = await createTeamBridge({ socketPath, tools, timeoutMs: 5000,
    emit: (request: { id: string; name: RepositoryOperation; arguments: unknown }) => {
      requests.push(request);
      void Promise.resolve().then(() => perform(request.name, repositorySchemas[request.name].parse(request.arguments))).then(
        result => ({ type: 'tool_response', id: request.id, result }),
        error => ({ type: 'tool_response', id: request.id, error: String(error.message ?? error) }),
      ).then(response => { const line = `${JSON.stringify(response)}\n`; responseLines.push(line); stream.write(line); });
    } });
  channel.onResponse((response: unknown) => bridge.acceptResponse(response));
  const socket = createConnection({ path: socketPath }); await once(socket, 'connect');
  const lines = createInterface({ input: socket, crlfDelay: Infinity }), iterator = lines[Symbol.asyncIterator]();
  t.after(async () => { socket.destroy(); lines.close(); channel.close(); stream.destroy(); await bridge.close(); });
  const receive = async () => { const line = await iterator.next(); assert.equal(line.done, false, 'MCP pipe closed'); return { bytes: Buffer.byteLength(line.value!), value: JSON.parse(line.value!) }; };
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  assert.equal((await receive()).value.result.serverInfo.name, 'agent-company-team');
  let sequence = 0;
  const call = async (name: RepositoryOperation, args: unknown) => {
    const wire = JSON.stringify({ jsonrpc: '2.0', id: `${++sequence}-${'\u0001'.repeat(190)}`, method: 'tools/call', params: { name, arguments: args } });
    assert.ok(Buffer.byteLength(wire) < 256 * 1024, 'accepted request must fit the existing MCP line limit');
    socket.write(`${wire}\n`);
    const response = await receive(); assert.equal(channel.signal.aborted, false);
    assert.ok(response.bytes < 1024 * 1024); return response.value;
  };
  const list = async () => {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/list' })}\n`);
    return (await receive()).value.result.tools as typeof tools;
  };
  return { call, list, requests, responseLines, channel };
}
function publicationAtLimit(unit: string) {
  const shape = (content: string) => ({ connectionId: 'acbf2b11-a9f0-4260-aab8-2d006d358094', operationId: 'boundary', expectedHeadSha: head,
    files: [{ path: '페이지/인용"문.txt', content }], message: 'Boundary publication' });
  const available = GITHUB_REQUEST_JSON_MAX_BYTES - repositoryJsonBytes(shape('')), cost = repositoryJsonBytes(unit) - 2;
  return shape(unit.repeat(Math.floor(available / cost)) + 'x'.repeat(available % cost));
}
function readTransport(content: string) {
  const sha = blobSha(content), file = { path: 'boundary.txt', sha, size: Buffer.byteLength(content), type: 'blob', mode: '100644' };
  return new GitHubTransport({ token: async () => 'fixture-token-no-network', fetch: async input => {
    const path = new URL(String(input)).pathname;
    const value = path.includes('/git/commits/') ? { sha: head, tree: { sha: tree }, parents: [], message: 'Fixture' }
      : path.includes('/git/trees/') ? { sha: tree, truncated: false, tree: [file] }
        : { sha, size: file.size, encoding: 'base64', content: Buffer.from(content).toString('base64') };
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  } });
}
const readResult = (content: string) => ({ path: 'boundary.txt', ref: head, headSha: head, sha: blobSha(content), content, encoding: 'utf-8' });
function maximumReadable(unit: string) {
  let low = 0, high = Math.floor(GITHUB_READ_MAX_BYTES / Buffer.byteLength(unit));
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (repositoryResultEncodedBytes(readResult(unit.repeat(middle))) <= GITHUB_RESULT_ENCODED_MAX_BYTES) low = middle; else high = middle - 1; }
  return unit.repeat(low);
}

test('128KiB publication JSON including unicode and escaping survives the unchanged worker request path', { timeout: 10_000 }, async t => {
  let dispatched = 0;
  const h = await harness(t, (name, args) => { dispatched++; return { accepted: name, jsonBytes: repositoryJsonBytes(args) }; });
  for (const unit of ['x', '한글🙂', '"\\\n\t\u0001']) {
    const args = publicationAtLimit(unit); assert.equal(repositoryJsonBytes(args), GITHUB_REQUEST_JSON_MAX_BYTES);
    assert.equal(repositorySchemas.github_publish.safeParse(args).success, true);
    const response = await h.call('github_publish', args); assert.equal(response.result.isError, undefined);
    assert.equal(JSON.parse(response.result.content[0].text).jsonBytes, GITHUB_REQUEST_JSON_MAX_BYTES);
    assert.ok(repositoryJsonBytes(h.requests.at(-1)) < 256 * 1024);
  }
  assert.equal(dispatched, 3);
});

test('new revision tool is carried by the existing dynamic worker catalog and request/result pipe', async t => {
  const args = { ...publicationAtLimit('x'), number: 1, files: [{ path: 'index.html', content: 'Updated page' }] };
  const h = await harness(t, (name, input) => ({ name, number: input.number, branch: 'agent-company/original/site', headSha: head }));
  assert.ok((await h.list()).some(tool => tool.name === 'github_revise'));
  const response = await h.call('github_revise', args);
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(JSON.parse(response.result.content[0].text), { name: 'github_revise', number: 1, branch: 'agent-company/original/site', headSha: head });
});

test('schema rejects one extra JSON byte before dispatch while the actual worker connection remains usable', { timeout: 10_000 }, async t => {
  let dispatched = 0; const h = await harness(t, () => { dispatched++; return { accepted: true }; });
  for (const unit of ['x', '한글🙂', '"\\\n\u0001']) {
    const args = publicationAtLimit(unit); args.files[0].content += 'x';
    assert.equal(repositoryJsonBytes(args), GITHUB_REQUEST_JSON_MAX_BYTES + 1); assert.equal(repositorySchemas.github_publish.safeParse(args).success, false);
    const rejected = await h.call('github_publish', args); assert.equal(rejected.result.isError, true);
  }
  assert.equal(dispatched, 0);
  const accepted = await h.call('github_repository', { connectionId: randomUUID() }); assert.equal(accepted.result.isError, undefined); assert.equal(dispatched, 1);
  assert.equal(repositorySchemas.github_pull_request.safeParse({ connectionId: randomUUID(), operationId: 'pr', publicationId: 'publish', title: 'PR', body: '\u0001'.repeat(30_000) }).success, false);
});

test('maximum UTF8 and escaped read results traverse controller JSONL and twice-encoded MCP responses intact', { timeout: 10_000 }, async t => {
  let content = '', transport = readTransport(content);
  const h = await harness(t, () => transport.readFile(repository, 'boundary.txt', head));
  for (const unit of ['x', '한글🙂', '"\\\n\t\u0001']) {
    content = maximumReadable(unit); transport = readTransport(content);
    assert.ok(Buffer.byteLength(content) <= GITHUB_READ_MAX_BYTES);
    assert.ok(repositoryResultEncodedBytes(readResult(content)) <= GITHUB_RESULT_ENCODED_MAX_BYTES);
    const response = await h.call('github_read', { connectionId: randomUUID(), path: 'boundary.txt', ref: head });
    assert.equal(response.result.isError, undefined); assert.equal(JSON.parse(response.result.content[0].text).content, content);
    assert.ok(Buffer.byteLength(h.responseLines.at(-1)!) < 1024 * 1024 - 1024);
    content += unit; transport = readTransport(content);
    const rejected = await h.call('github_read', { connectionId: randomUUID(), path: 'boundary.txt', ref: head });
    assert.equal(rejected.result.isError, true); assert.equal(h.channel.signal.aborted, false);
  }
});

test('service-generated QA catalog crosses the real worker MCP path and forged writes never reach dispatch', { timeout: 10_000 }, async t => {
  // The service and worker IPC are real; DB is in memory, runtime is a fixture,
  // and all repository methods are local doubles. No ChatGPT or GitHub call.
  const runtime = new StorageFixtureRuntime(randomUUID());
  let reads = 0, writes = 0, journalCalls = 0;
  const writeTrap = async (): Promise<never> => { writes++; throw new Error('QA write escaped its scope'); };
  const service = await AgentService.create({ runtime, github: {
    status: () => ({ configured: true, writable: true, missing: [], repositories: [repository] }),
    journal: { execute: async () => { journalCalls++; throw new Error('QA write reached the journal'); } },
    transport: { inspect: async () => ({ id: 19, fullName: repository, defaultBranch: 'main', private: true }),
      listFiles: async (_repository, ref) => ({ ref, headSha: head, files: [{ path: 'README.md', sha: head, size: 10 }], truncated: false, omittedFiles: 0 }),
      readFile: async (_repository, path, ref) => { reads++; return { path, ref, headSha: head, sha: head, content: 'QA fixture remote content', encoding: 'utf-8' }; },
      publish: writeTrap, pullRequest: writeTrap, getPullRequest: async () => { throw new Error('Unused read fixture'); } },
  } });
  t.after(() => service.close());
  const qa = await service.createAgent({ name: 'QA transport fixture', persona: 'Read and review authorized repository content' });
  const team = await service.createTeam({ name: 'QA fixture team', memberIds: [qa.id] });
  const project = await service.collaboration('project_create', { name: 'QA fixture project', teamIds: [team.id] }) as Project;
  const connection = await service.createConnection({ repository, access: 'write' });
  const verified = await service.verifyConnection(connection.id);
  await service.updateConnection(connection.id, { expectedVersion: verified.version, grants: [{ agentId: qa.id, teamId: team.id, projectId: project.id, access: 'read' }] });
  const run = await service.startRun(qa.id, 'Review the scoped repository', project.id, team.id);
  for (let attempt = 0; !runtime.calls.length && attempt < 150; attempt++) await delay(10);
  assert.equal(runtime.calls.length, 1, 'The model-free fixture execution did not start');
  const execution = runtime.calls[0];
  assert.equal(execution.input.run.id, run.id); assert.equal(execution.input.repositoryTransport, 'github-app-v1');
  const tools = execution.input.collaboration!.tools;
  const h = await harness(t, (name, args) => execution.hooks.onTool!(name, args), tools);
  const actualCatalog = await h.list();
  assert.deepEqual(actualCatalog, tools, 'MCP must expose exactly the service-owned catalog');
  const names = actualCatalog.map(tool => tool.name);
  for (const name of ['github_repository', 'github_files', 'github_read', 'github_pull_request_read']) assert.ok(names.includes(name));
  assert.equal(names.includes('github_publish'), false); assert.equal(names.includes('github_pull_request'), false); assert.equal(names.includes('github_revise'), false);
  const valid = await h.call('github_read', { connectionId: connection.id, path: 'README.md', ref: head });
  assert.equal(valid.result.isError, undefined); assert.equal(JSON.parse(valid.result.content[0].text).content, 'QA fixture remote content');
  assert.equal(reads, 1);
  const priorDispatches = h.requests.length;
  const forgedPublish = { connectionId: connection.id, operationId: 'must-deny', expectedHeadSha: head, files: [{ path: 'deny.txt', content: 'must not publish' }], message: 'Must deny' };
  const forgedPr = { connectionId: connection.id, operationId: 'must-deny', publicationId: 'must-deny', title: 'Must deny', body: '' };
  const forgedRevision = { ...forgedPublish, number: 1 };
  const revisionDenied = await h.call('github_revise', forgedRevision);
  assert.equal(revisionDenied.error.code, -32602);
  await assert.rejects(execution.hooks.onTool!('github_revise', forgedRevision), error => error instanceof Error && 'statusCode' in error && error.statusCode === 403);
  for (const [name, args] of [['github_publish', forgedPublish], ['github_pull_request', forgedPr]] as const) {
    const rejected = await h.call(name, args);
    assert.equal(rejected.error.code, -32602); assert.equal(h.requests.length, priorDispatches);
    // Test-only bypass of the MCP catalog independently proves the controller
    // authorization boundary. This is never an instruction to a real agent.
    await assert.rejects(execution.hooks.onTool!(name, args), error => error instanceof Error && 'statusCode' in error && error.statusCode === 403);
  }
  assert.equal(writes, 0); assert.equal(journalCalls, 0);
  assert.equal(h.channel.signal.aborted, false);
  const after = await h.call('github_files', { connectionId: connection.id, ref: head }); assert.equal(after.result.isError, undefined);
});
