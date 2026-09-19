import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import type { ServiceOptions } from '../server/service.ts';
import type { Connection, RuntimeDriver, Workspace } from '../shared/types.ts';

test('GitHub operator API preserves scope, version conflicts, origin denial and explicit disconnect', async t => {
  let inspections = 0, configured = true, fail = false;
  const forbidden = async (): Promise<never> => { throw new Error('No model or external write belongs to this fixture'); };
  const runtime: RuntimeDriver = { inspect: async () => ({ mode: 'docker', available: false, authenticated: false,
    simulation: true, image: 'fixture', model: 'fixture', version: 'fixture', message: 'No execution' }), execute: forbidden };
  const github: NonNullable<ServiceOptions['github']> = {
    status: () => ({ configured, writable: configured, repositories: ['formnest-studio/studio-site'], missing: configured ? [] : ['AGENT_GITHUB_PRIVATE_KEY_FILE'] }),
    journal: { execute: forbidden },
    transport: { inspect: async () => {
      inspections++;
      if (fail) throw new Error('private-provider-error-do-not-display');
      return { id: 1362601656, fullName: 'formnest-studio/studio-site', defaultBranch: 'main', private: true };
    }, listFiles: forbidden, readFile: forbidden, publish: forbidden, pullRequest: forbidden, getPullRequest: forbidden },
  };
  const app = await createApp({ runtime, github }); t.after(() => app.close());
  const send = (method: 'POST' | 'PATCH', url: string, payload: object, headers?: Record<string, string | undefined>) => app.inject({ method, url, payload, headers });
  const agent = (await send('POST', '/api/agents', { name: 'API fixture', persona: 'No model work' })).json<{ id: string }>();
  const team = (await send('POST', '/api/teams', { name: 'API fixture', memberIds: [agent.id] })).json<{ id: string }>();
  const project = (await send('POST', '/api/collaboration/project_create', { name: 'API fixture', teamIds: [team.id] })).json<{ id: string }>();
  const created = await send('POST', '/api/connections', { repository: 'formnest-studio/studio-site', access: 'write' });
  assert.equal(created.statusCode, 201);
  const connection = created.json<Connection>(), url = `/api/connections/${connection.id}`;
  assert.equal(connection.github, undefined); assert.equal(inspections, 0);
  assert.equal((await app.inject('/api/github')).json().configured, true);
  for (const headers of [{ origin: 'https://untrusted.example' }, { host: 'untrusted.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await send('POST', `${url}/verify`, {}, headers)).statusCode, 403);
  }
  assert.equal((await send('POST', `${url}/verify`, { token: 'not-a-real-token' })).statusCode, 400);
  assert.equal(inspections, 0);
  configured = false;
  assert.equal((await send('POST', `${url}/verify`, {})).statusCode, 503);
  assert.equal(inspections, 0);
  configured = true;
  const verified = await send('POST', `${url}/verify`, {});
  assert.equal(verified.statusCode, 200);
  const current = verified.json<Connection>(); assert.equal(current.github?.repositoryId, 1362601656);
  const grants = [{ agentId: agent.id, teamId: team.id, projectId: project.id, access: 'write' }];
  assert.equal((await send('PATCH', url, { grants })).statusCode, 400);
  assert.equal((await send('PATCH', url, { expectedVersion: connection.version, grants })).statusCode, 409);
  const granted = await send('PATCH', url, { expectedVersion: current.version, grants });
  assert.equal(granted.statusCode, 200);
  const workspace = (await app.inject('/api/workspace')).json<Workspace>();
  assert.deepEqual(workspace.agents.find(a => a.id === agent.id)?.repositoryIds, [connection.id]);
  assert.deepEqual(workspace.connections[0].grants, grants); assert.equal(workspace.runs.length, 0);
  const disabled = await send('PATCH', url, { expectedVersion: granted.json<Connection>().version, enabled: false });
  assert.equal(disabled.statusCode, 200); assert.equal(disabled.json<Connection>().github?.status, 'disconnected');
  assert.notEqual(disabled.json<Connection>().github?.generation, current.github?.generation);
  assert.equal((await send('PATCH', url, { expectedVersion: disabled.json<Connection>().version, enabled: true })).statusCode, 400);
  fail = true;
  const failed = await send('POST', `${url}/verify`, {});
  assert.equal(failed.statusCode, 500); assert.doesNotMatch(failed.body, /private-provider-error/);
  assert.equal((await app.inject('/api/workspace')).json<Workspace>().connections[0].github?.status, 'disconnected');
});
