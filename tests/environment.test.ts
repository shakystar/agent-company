import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { environmentBuildReportSchema, environmentCallSchema, environmentProposalSchema, environmentSpecSchema,
  type EnvironmentBuildReport, type EnvironmentProposal } from '../shared/environment.ts';
import type { Agent } from '../shared/types.ts';
import { environmentSpecHash, forkEnvironment, proposeEnvironment, selectEnvironment } from '../server/environments.ts';
import type { WorkspaceState } from '../server/store.ts';

const proposal = (): EnvironmentProposal => ({ reason: 'Bounded test environment', requestedAccess: [], spec: {
  packages: [{ name: '@fixture/mcp', version: '1.2.3' }],
  servers: [{ name: 'fixture', package: '@fixture/mcp', bin: 'fixture-mcp', args: [], probe: { tool: 'echo', arguments: { text: 'probe' } } }],
} });
const agent = (): Agent => ({ id: randomUUID(), name: 'Fixture', description: '', persona: 'test', color: '#000000', model: 'fixture',
  status: 'idle', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const state = (): WorkspaceState => ({ environmentRevisions: [] } as unknown as WorkspaceState);
const report = (): EnvironmentBuildReport => ({ imageId: `sha256:${'a'.repeat(64)}`, contentHash: 'b'.repeat(64), lockfileHash: 'c'.repeat(64),
  packages: proposal().spec.packages, tools: [{ server: 'fixture', name: 'echo', description: 'Echo the input', inputSchema: { type: 'object' } }],
  checks: [{ name: 'probe', passed: true, detail: 'Explicit fixture only' }], createdAt: new Date().toISOString() });

test('environment specs accept fixed package versions and reject executable configuration injection', () => {
  assert.deepEqual(environmentProposalSchema.parse(proposal()), proposal());
  const invalid = [
    { ...proposal().spec, packages: [{ name: '@fixture/mcp', version: 'latest' }] },
    { ...proposal().spec, packages: [{ name: '@fixture/mcp', version: '^1.2.3' }] },
    { ...proposal().spec, packages: [{ name: 'https://example.test/pkg.tgz', version: '1.2.3' }] },
    { ...proposal().spec, packages: [{ name: '../pkg', version: '1.2.3' }] },
    { ...proposal().spec, packages: [...proposal().spec.packages, ...proposal().spec.packages] },
    { ...proposal().spec, servers: [...proposal().spec.servers, ...proposal().spec.servers] },
    { ...proposal().spec, servers: [{ ...proposal().spec.servers[0], package: 'unlisted-package' }] },
    { ...proposal().spec, servers: [{ ...proposal().spec.servers[0], bin: '/bin/sh' }] },
    { ...proposal().spec, servers: [{ ...proposal().spec.servers[0], args: ['first\nsecond'] }] },
    { ...proposal().spec, servers: [{ ...proposal().spec.servers[0], command: 'sh', env: { NODE_OPTIONS: '--require=evil' } }] },
    { ...proposal().spec, network: 'bridge' },
  ];
  for (const value of invalid) assert.equal(environmentSpecSchema.safeParse(value).success, false, JSON.stringify(value));
  assert.equal(environmentProposalSchema.safeParse({ ...proposal(), auth: 'unapproved-credential' }).success, false);
});

test('environment schema bounds package, server, tool argument and report payloads', () => {
  assert.equal(environmentSpecSchema.safeParse({ packages: Array.from({ length: 11 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0' })), servers: [] }).success, false);
  assert.equal(environmentCallSchema.safeParse({ server: 'fixture', tool: 'echo', arguments: { text: 'x'.repeat(32_769) } }).success, false);
  assert.equal(environmentCallSchema.safeParse({ server: 'fixture', tool: 'echo', arguments: {}, agentId: 'other-agent' }).success, false);
  assert.equal(environmentBuildReportSchema.safeParse({ ...report(), imageId: 'mutable:latest' }).success, false);
  assert.equal(environmentBuildReportSchema.safeParse({ ...report(), checks: [] }).success, false);
  assert.equal(environmentBuildReportSchema.safeParse({ ...report(), contentHash: 'unverified' }).success, false);
});

test('same source and base proposals are idempotent but changed scopes and configurations remain separate', () => {
  const data = state(), owner = agent();
  const first = proposeEnvironment(data, owner, proposal(), 'same-run');
  assert.equal(proposeEnvironment(data, owner, proposal(), 'same-run').id, first.id);
  assert.notEqual(proposeEnvironment(data, owner, { ...proposal(), requestedAccess: ['new account'] }, 'same-run').id, first.id);
  assert.notEqual(proposeEnvironment(data, owner, proposal(), 'other-run').id, first.id);
  owner.environmentRevisionId = randomUUID();
  assert.notEqual(proposeEnvironment(data, owner, proposal(), 'same-run').id, first.id);
});

test('environment proposal hashes are insensitive to persisted JSON object key ordering', () => {
  const spec = proposal().spec;
  const reordered = { servers: spec.servers.map(server => ({ probe: { arguments: { text: 'probe' }, tool: 'echo' },
    args: server.args, bin: server.bin, package: server.package, name: server.name })),
  packages: spec.packages.map(item => ({ version: item.version, name: item.name })) };
  assert.equal(environmentSpecHash(spec), environmentSpecHash(reordered));
});

test('requested access remains blocked and cannot be selected even with a fabricated ready status', () => {
  const data = state(), owner = agent();
  const revision = proposeEnvironment(data, owner, { ...proposal(), requestedAccess: ['read another agent workspace'] }, null);
  assert.equal(revision.status, 'blocked'); assert.equal(revision.buildRunId, null);
  assert.deepEqual(revision.requestedAccess, ['read another agent workspace']);
  Object.assign(revision, { status: 'ready', buildRunId: randomUUID(), report: report() });
  assert.throws(() => selectEnvironment(data, owner.id, revision.id));
});

test('only an owned verified environment can be selected and selections do not alias stored manifests', () => {
  const data = state(), owner = agent();
  const revision = proposeEnvironment(data, owner, proposal(), null);
  assert.equal(selectEnvironment(data, owner.id, null), undefined);
  assert.throws(() => selectEnvironment(data, owner.id, revision.id));
  Object.assign(revision, { status: 'ready', buildRunId: randomUUID(), report: report() });
  assert.throws(() => selectEnvironment(data, randomUUID(), revision.id));
  const selected = selectEnvironment(data, owner.id, revision.id)!;
  selected.spec.packages[0].version = '9.9.9'; selected.report.tools[0].description = 'Changed outside store';
  assert.equal(revision.spec.packages[0].version, '1.2.3'); assert.equal(revision.report!.tools[0].description, 'Echo the input');
});

test('forks own distinct mutable manifest objects and retain the immutable bundle reference', () => {
  const data = state(), owner = agent();
  const revision = proposeEnvironment(data, owner, proposal(), null);
  Object.assign(revision, { status: 'ready', buildRunId: randomUUID(), report: report() });
  owner.environmentRevisionId = revision.id;
  const clone = { ...agent(), environmentRevisionId: revision.id };
  forkEnvironment(data, owner.id, clone);
  assert.notEqual(clone.environmentRevisionId, revision.id);
  const forked = data.environmentRevisions.find(item => item.id === clone.environmentRevisionId)!;
  assert.equal(forked.agentId, clone.id); assert.equal(forked.sourceRevisionId, revision.id);
  assert.equal(forked.buildRunId, revision.buildRunId); assert.equal(forked.report!.contentHash, revision.report!.contentHash);
  assert.equal(forked.baseRevisionId, null); assert.equal(forked.sourceRunId, null);
  forked.spec.packages[0].version = '9.9.9'; forked.report!.checks[0].detail = 'Only clone changed';
  assert.equal(revision.spec.packages[0].version, '1.2.3'); assert.equal(revision.report!.checks[0].detail, 'Explicit fixture only');
});
