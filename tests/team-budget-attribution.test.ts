import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Run, Team } from '../shared/types.ts';
import type { Project } from '../shared/collaboration.ts';
import { historicalBudgetAttribution, teamForScope } from '../server/budget-attribution.ts';

function fixture() {
  const alice = randomUUID(), bob = randomUUID(), timestamp = new Date().toISOString();
  const team = (name: string, memberIds: string[]): Team => ({ id: randomUUID(), name, memberIds,
    description: '', workflow: '', version: 1, createdAt: timestamp, updatedAt: timestamp });
  const alpha = team('Alpha', [alice]), beta = team('Beta', [alice, bob]), outside = team('Outside', [bob]);
  const project: Project = { id: randomUUID(), name: 'Shared project', teamIds: [alpha.id, beta.id],
    description: '', version: 1, createdAt: timestamp, updatedAt: timestamp };
  return { alice, bob, alpha, beta, outside, project,
    state: { teams: [alpha, beta, outside], projects: [project], messages: [], teamTasks: [], runs: [] as Run[], conversations: [] } };
}
const code = (status: number) => (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === status;

test('new original-team selection requires one eligible team and cannot erase project or team scope', () => {
  const f = fixture();
  assert.throws(() => teamForScope(f.state, { type: 'project', id: f.project.id }, f.project.id), code(400));
  assert.throws(() => teamForScope(f.state, { type: 'project', id: f.project.id }, f.project.id, null), code(403));
  assert.throws(() => teamForScope(f.state, { type: 'project', id: f.project.id }, f.project.id, f.outside.id), code(403));
  assert.equal(teamForScope(f.state, { type: 'project', id: f.project.id }, f.project.id, f.alpha.id), f.alpha.id);
  assert.equal(teamForScope(f.state, { type: 'agent', id: f.bob }, f.project.id), f.beta.id);
  assert.throws(() => teamForScope(f.state, { type: 'agent', id: f.alice }, null), code(400));
  assert.equal(teamForScope(f.state, { type: 'agent', id: f.alice }, null, null), null);
  assert.equal(teamForScope(f.state, { type: 'team', id: f.alpha.id }, null), f.alpha.id);
  assert.throws(() => teamForScope(f.state, { type: 'team', id: f.alpha.id }, null, null), code(403));
  assert.throws(() => teamForScope(f.state, { type: 'team', id: f.alpha.id }, null, f.beta.id), code(403));
});

test('historical backfill uses the actual executor and original pinned team without inferring current memberships', () => {
  const f = fixture();
  const root = { id: randomUUID(), agentId: f.alice, budgetProjectId: f.project.id } as Run;
  root.budgetRootRunId = root.id;
  const peer = { id: randomUUID(), agentId: f.bob, budgetProjectId: f.project.id, budgetRootRunId: root.id } as Run;
  f.state.runs.push(root, peer);
  const entry = { runId: peer.id, rootRunId: root.id, projectId: f.project.id };
  const before = structuredClone(f.state);
  assert.deepEqual(historicalBudgetAttribution(f.state, entry), { agentId: f.bob });
  assert.deepEqual(f.state, before, 'Backfill evidence resolution is read-only');
  root.budgetTeamId = f.alpha.id;
  assert.deepEqual(historicalBudgetAttribution(f.state, entry), { agentId: f.bob, teamId: f.alpha.id });
  root.budgetTeamId = null;
  assert.deepEqual(historicalBudgetAttribution(f.state, entry), { agentId: f.bob, teamId: null });
  assert.deepEqual(historicalBudgetAttribution(f.state, { ...entry, runId: randomUUID() }), { teamId: null });
});
