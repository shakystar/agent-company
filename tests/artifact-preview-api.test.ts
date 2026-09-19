import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.ts';
import type { RuntimeDriver, Workspace } from '../shared/types.ts';
import type { ArtifactPreviewManifest } from '../shared/artifact-preview.ts';
import type { ConversationMessage } from '../shared/conversations.ts';

test('preview API pins actual versions, preserves old content, deduplicates feedback, and never starts a model for record-only', async t => {
  let starts = 0, explicitTask = false;
  const runtime: RuntimeDriver = { inspect: async () => ({ mode: 'docker', available: true, authenticated: true,
    image: 'fixture', model: 'fixture', version: 'fixture', message: 'No model execution' }),
    execute: async () => { starts++; assert.ok(explicitTask, 'Record-only feedback must not start a model');
      return { result: 'fixture', memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0 }; } };
  const app = await createApp({ runtime }); t.after(() => app.close());
  const post = async (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const agent = (await post('/api/agents', { name: '미리보기 검증', persona: 'fixture' })).json<{ id: string }>();
  const team = (await post('/api/teams', { name: '검수 팀', memberIds: [agent.id] })).json<{ id: string }>();
  const scope = { type: 'team' as const, id: team.id };
  const html = '<!doctype html><title>v1</title><h1>검수 원본</h1>';
  const artifact = (await post('/api/collaboration/artifact_publish', { scope, name: 'site/index.html', content: html, mediaType: 'text/html' })).json<{ id: string; version: number }>();
  const body = { scope, prefix: 'site', versions: [{ artifactId: artifact.id, version: artifact.version }] };
  const pinned = await post('/api/artifact-previews', body);
  assert.equal(pinned.statusCode, 201, pinned.body);
  const manifest = pinned.json<ArtifactPreviewManifest>();
  assert.equal((await post('/api/artifact-previews', body)).json().id, manifest.id);
  assert.equal((await app.inject(`/api/artifact-previews?scopeType=team&scopeId=${team.id}`)).json().length, 1);
  assert.equal((await post('/api/artifact-previews', { ...body, secret: 'no-input' })).statusCode, 400);
  assert.equal((await post('/api/artifact-previews', { ...body, scope: { type: 'agent', id: agent.id } })).statusCode, 400);
  assert.equal((await post('/api/artifact-previews', { ...body, versions: [{ artifactId: randomUUID(), version: 1 }] })).statusCode, 409);
  await post('/api/collaboration/artifact_publish', { scope, artifactId: artifact.id, expectedVersion: 1,
    name: 'site/index.html', content: '<h1>새 버전</h1>', mediaType: 'text/html' });
  const archive = await app.inject(`/api/artifact-previews/${manifest.id}/download`);
  assert.equal(archive.statusCode, 200, archive.body);
  assert.match(archive.headers['content-type']!, /application\/zip/);
  assert.match(archive.headers['content-disposition']!, /attachment/);
  assert.ok(archive.rawPayload.includes(Buffer.from(html)));
  assert.ok(!archive.rawPayload.includes(Buffer.from('<h1>새 버전</h1>')));
  const newer = (await post('/api/artifact-previews', { scope, prefix: 'site' })).json<ArtifactPreviewManifest>();
  assert.notEqual(newer.sourceHash, manifest.sourceHash);
  const conversation = (await post('/api/conversations', { scope, title: '검수', idempotencyKey: randomUUID() })).json<{ id: string }>();
  const feedback = { conversationId: conversation.id, content: '제목을 검토했습니다.', mode: 'discuss', idempotencyKey: randomUUID() };
  const sent = await post(`/api/artifact-previews/${manifest.id}/feedback`, feedback);
  assert.equal(sent.statusCode, 202, sent.body);
  const message = sent.json<ConversationMessage>();
  assert.equal(message.recordOnly, true); assert.deepEqual(message.deliveries, []);
  assert.match(message.content, new RegExp(manifest.id)); assert.match(message.content, new RegExp(manifest.sourceHash));
  assert.doesNotMatch(message.content, new RegExp(newer.sourceHash));
  assert.equal((await post(`/api/artifact-previews/${manifest.id}/feedback`, feedback)).json().id, message.id);
  assert.equal((await post(`/api/artifact-previews/${newer.id}/feedback`, feedback)).statusCode, 409);
  assert.equal((await post(`/api/artifact-previews/${manifest.id}/feedback`, { ...feedback, mode: 'task', idempotencyKey: randomUUID() })).statusCode, 400);
  const other = (await post('/api/teams', { name: '다른 공간', memberIds: [agent.id] })).json<{ id: string }>();
  const otherConversation = (await post('/api/conversations', { scope: { type: 'team', id: other.id }, idempotencyKey: randomUUID() })).json<{ id: string }>();
  assert.equal((await post(`/api/artifact-previews/${manifest.id}/feedback`, { ...feedback, conversationId: otherConversation.id })).statusCode, 403);
  assert.equal((await post(`/api/artifact-previews/${manifest.id}/feedback`, { ...feedback, recipientAgentId: randomUUID(), idempotencyKey: randomUUID() })).statusCode, 403);
  for (const headers of [{ origin: 'http://127.0.0.2:12345' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { host: 'attacker.example' }]) {
    const response = await app.inject({ method: 'POST', url: `/api/artifact-previews/${manifest.id}/feedback`, payload: feedback, headers });
    assert.equal(response.statusCode, 403);
    assert.equal((await app.inject({ url: '/api/workspace', headers })).statusCode, 403);
  }
  await delay(50); // Give the normal inbox task a chance to run with an available runtime.
  const workspaceResponse = await app.inject('/api/workspace');
  assert.equal(workspaceResponse.headers['x-frame-options'], 'DENY');
  assert.match(workspaceResponse.headers['content-security-policy']!, /frame-ancestors 'none'/);
  const workspace = workspaceResponse.json<Workspace>();
  assert.equal(workspace.runs.length, 0); assert.equal(starts, 0);
  assert.equal(workspace.conversationMessages?.length, 1);
  assert.equal(workspace.artifactPreviews?.length, 2);
  explicitTask = true;
  const routed = await post(`/api/artifact-previews/${manifest.id}/feedback`, {
    ...feedback, recipientAgentId: agent.id, mode: 'task', idempotencyKey: randomUUID(),
  });
  assert.equal(routed.statusCode, 202, routed.body);
  assert.equal(routed.json<ConversationMessage>().deliveries[0].agentId, agent.id);
  assert.equal(routed.json<ConversationMessage>().recordOnly, undefined);
});
