import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationTools, emptyCollaborationState, type CollaborationOperation,
  type PeerMessage, type Project, type SharedArtifact, type TeamTask } from '../shared/collaboration.ts';
import { CollaborationError, mutateCollaboration, readCollaborationContext,
  type CollaborationWorkspace } from '../server/collaboration.ts';

const teamScope = { type: 'team', id: 'team-a' } as const;
function fixture(): CollaborationWorkspace {
  const timestamp = new Date().toISOString();
  return { ...emptyCollaborationState(), agents: [
    { id: 'alice', name: 'Alice', status: 'idle' }, { id: 'bob', name: 'Bob', status: 'idle' },
    { id: 'carol', name: 'Carol', status: 'idle' }, { id: 'outsider', name: 'Outside', status: 'idle' },
  ], teams: [
    { id: 'team-a', name: 'A', description: '', workflow: 'Collaborate freely', memberIds: ['alice', 'bob'],
      version: 1, createdAt: timestamp, updatedAt: timestamp },
    { id: 'team-b', name: 'B', description: '', workflow: '', memberIds: ['carol'],
      version: 1, createdAt: timestamp, updatedAt: timestamp },
  ] };
}
function call<T>(state: CollaborationWorkspace, actor: string | null, operation: CollaborationOperation,
  args: unknown): T { return mutateCollaboration(state, actor, operation, args) as T; }
function rejects(code: number, fn: () => unknown): void {
  assert.throws(fn, (error) => error instanceof CollaborationError && error.statusCode === code);
}
function publish(state: CollaborationWorkspace, actor = 'alice', name = 'notes/result.md'): SharedArtifact {
  return call(state, actor, 'artifact_publish', { scope: teamScope, name, content: 'initial' });
}
function send(state: CollaborationWorkspace, extra: Record<string, unknown> = {}, actor: string | null = 'alice'): PeerMessage {
  return call(state, actor, 'message_send', { scope: teamScope, recipientAgentId: 'bob',
    content: 'Please review the result', idempotencyKey: 'review-1', ...extra });
}

test('projects authorize current cross-team membership; only the operator changes access', () => {
  const state = fixture();
  rejects(403, () => call(state, 'alice', 'project_create', { name: 'P', teamIds: ['team-a', 'team-b'] }));
  rejects(404, () => call(state, null, 'project_create', { name: 'P', teamIds: ['missing'] }));
  const project = call<Project>(state, null, 'project_create', { name: 'P', teamIds: ['team-a', 'team-b'] });
  const scope = { type: 'project', id: project.id };
  const message = send(state, { scope, recipientAgentId: 'carol' });
  assert.equal(message.recipientAgentId, 'carol');
  rejects(403, () => send(state, { recipientAgentId: 'carol', idempotencyKey: 'wrong-scope' }));
  rejects(409, () => call(state, null, 'project_update', { projectId: project.id, expectedVersion: 2,
    name: 'P', description: '', teamIds: ['team-a'] }));
  call(state, null, 'project_update', { projectId: project.id, expectedVersion: 1,
    name: 'P', description: '', teamIds: ['team-a'] });
  rejects(403, () => call(state, 'carol', 'message_acknowledge', { messageId: message.id }));
  rejects(403, () => call(state, 'carol', 'artifact_list', { scope }));
});

test('artifact revisions use CAS and preserve earlier content without private context', () => {
  const state = fixture(); const artifact = publish(state);
  assert.equal('content' in artifact, false);
  const updated = call<SharedArtifact>(state, 'bob', 'artifact_publish', { scope: teamScope,
    artifactId: artifact.id, expectedVersion: 1, name: artifact.name, content: 'reviewed' });
  assert.equal(updated.version, 2);
  assert.equal(call<SharedArtifact>(state, 'alice', 'artifact_read', { artifactId: artifact.id }).content, 'reviewed');
  assert.equal(call<SharedArtifact>(state, 'bob', 'artifact_read', { artifactId: artifact.id, version: 1 }).content, 'initial');
  rejects(409, () => call(state, 'alice', 'artifact_publish', { scope: teamScope,
    artifactId: artifact.id, expectedVersion: 1, name: artifact.name, content: 'lost update' }));
  rejects(403, () => call(state, 'outsider', 'artifact_read', { artifactId: artifact.id }));
  rejects(409, () => publish(state));
  rejects(400, () => publish(state, 'alice', '../private/key'));
  rejects(400, () => publish(state, 'alice', 'C:/private/key'));
  rejects(400, () => publish(state, 'alice', '/private/key'));
  rejects(400, () => publish(state, 'alice', 'private\\key'));
});

test('shared artifact scope cannot move and revocation prevents historical reads or updates', () => {
  const state = fixture(); const artifact = publish(state);
  state.teams[1].memberIds.push('alice');
  rejects(400, () => call(state, 'alice', 'artifact_publish', { scope: { type: 'team', id: 'team-b' },
    artifactId: artifact.id, expectedVersion: 1, name: artifact.name, content: 'move' }));
  state.teams[0].memberIds = ['bob'];
  rejects(403, () => call(state, 'alice', 'artifact_read', { artifactId: artifact.id, version: 1 }));
  assert.equal(state.sharedArtifacts[0].version, 1);
});

test('peers volunteer, release, and complete only their own task with conflict protection', () => {
  const state = fixture();
  rejects(400, () => call(state, 'alice', 'task_create', { scope: teamScope, title: 'Task', assigneeAgentId: 'bob' }));
  const task = call<TeamTask>(state, null, 'task_create', { scope: teamScope, title: 'Task' });
  rejects(403, () => call(state, null, 'task_claim', { taskId: task.id, expectedVersion: 1 }));
  call(state, 'alice', 'task_claim', { taskId: task.id, expectedVersion: 1 });
  rejects(409, () => call(state, 'bob', 'task_claim', { taskId: task.id, expectedVersion: 1 }));
  rejects(403, () => call(state, 'bob', 'task_complete', { taskId: task.id, expectedVersion: 2, outcome: 'done' }));
  rejects(403, () => call(state, 'bob', 'task_release', { taskId: task.id, expectedVersion: 2 }));
  call(state, 'alice', 'task_release', { taskId: task.id, expectedVersion: 2 });
  call(state, 'bob', 'task_claim', { taskId: task.id, expectedVersion: 3 });
  const artifact = publish(state, 'bob');
  const done = call<TeamTask>(state, 'bob', 'task_complete', {
    taskId: task.id, expectedVersion: 4, outcome: 'Reviewed', artifactIds: [artifact.id] });
  assert.equal(done.status, 'done'); assert.equal(done.assigneeAgentId, 'bob');
  assert.equal(done.version, 5); assert.ok(done.completedAt);
  rejects(409, () => call(state, 'alice', 'task_claim', { taskId: task.id, expectedVersion: 5 }));
});

test('message retries are idempotent and changed payload or spoofed sender is rejected', () => {
  const state = fixture(); const original = send(state);
  assert.equal(send(state).id, original.id); assert.equal(state.messages.length, 1);
  rejects(409, () => send(state, { content: 'different' }));
  rejects(400, () => send(state, { senderAgentId: 'bob' }));
  rejects(403, () => send(state, {}, 'outsider'));
  rejects(400, () => send(state, { recipientAgentId: 'alice' }));
  state.teams[0].memberIds = ['alice'];
  rejects(403, () => send(state));
});

test('message receipt and completion are recipient-only and do not complete the linked task', () => {
  const state = fixture();
  const task = call<TeamTask>(state, 'alice', 'task_create', { scope: teamScope, title: 'Review' });
  const message = send(state, { taskId: task.id });
  rejects(403, () => call(state, 'alice', 'message_acknowledge', { messageId: message.id }));
  rejects(403, () => call(state, null, 'message_complete', { messageId: message.id }));
  const delivered = call<PeerMessage>(state, 'bob', 'message_acknowledge', { messageId: message.id });
  assert.equal(delivered.status, 'delivered'); assert.ok(delivered.deliveredAt); assert.equal(delivered.completedAt, null);
  const done = call<PeerMessage>(state, 'bob', 'message_complete', { messageId: message.id });
  assert.equal(done.status, 'completed'); assert.ok(done.completedAt);
  assert.equal(call<PeerMessage>(state, 'bob', 'message_acknowledge', { messageId: message.id }).status, 'completed');
  assert.equal(state.teamTasks[0].status, 'open');
});

test('replies preserve the original thread and may not forge conversation membership', () => {
  const state = fixture(); const original = send(state);
  const reply = send(state, { recipientAgentId: 'alice', replyToId: original.id,
    idempotencyKey: 'reply-1', content: 'I can review it' }, 'bob');
  assert.equal(reply.threadId, original.threadId); assert.equal(reply.replyToId, original.id);
  assert.equal(send(state, { recipientAgentId: 'alice', replyToId: original.id,
    idempotencyKey: 'reply-1', content: 'I can review it' }, 'bob').id, reply.id);
  rejects(403, () => send(state, { replyToId: original.id, idempotencyKey: 'fake-reply' }));
  rejects(403, () => send(state, { recipientAgentId: 'alice', replyToId: original.id,
    threadId: 'other', idempotencyKey: 'wrong-thread' }, 'bob'));
  state.teams[0].memberIds.push('carol');
  rejects(403, () => send(state, { threadId: original.threadId, idempotencyKey: 'join-thread' }, 'carol'));
  rejects(403, () => send(state, { threadId: original.threadId, idempotencyKey: 'join-thread' }, null));
});

test('messages to the user are supported without impersonating or assigning a peer', () => {
  const state = fixture(); const message = send(state, { recipientAgentId: null });
  assert.equal(message.recipientAgentId, null);
  call(state, null, 'message_acknowledge', { messageId: message.id });
  const reply = send(state, { recipientAgentId: 'alice', replyToId: message.id, idempotencyKey: 'user-reply' }, null);
  assert.equal(reply.senderAgentId, null); assert.equal(reply.threadId, message.threadId);
});

test('shared references must belong to the same scope and failed completion changes nothing', () => {
  const state = fixture(); const artifact = publish(state);
  state.teams[1].memberIds.push('alice');
  const otherScope = { type: 'team', id: 'team-b' };
  rejects(400, () => send(state, { scope: otherScope, recipientAgentId: 'carol', artifactIds: [artifact.id] }));
  const task = call<TeamTask>(state, 'alice', 'task_create', { scope: otherScope, title: 'Other task' });
  call(state, 'alice', 'task_claim', { taskId: task.id, expectedVersion: 1 });
  rejects(400, () => call(state, 'alice', 'task_complete', { taskId: task.id, expectedVersion: 2,
    outcome: 'wrong reference', artifactIds: [artifact.id] }));
  assert.equal(state.teamTasks[0].status, 'claimed'); assert.equal(state.teamTasks[0].version, 2);
});

test('context projects only permitted public fields and messages stay participant-private', () => {
  const state = fixture();
  Object.assign(state.agents[0], { persona: 'private persona', memories: ['secret'], credential: 'secret' });
  Object.assign(state, { memories: ['private memory'] });
  state.teams[0].memberIds.push('carol');
  for (let index = 0; index < 25; index++) send(state, { idempotencyKey: `message-${index}` });
  const context = readCollaborationContext(state, 'bob');
  assert.equal(context.inbox.items.length, 20); assert.equal(context.inbox.nextOffset, 20);
  const members = call<{ items: unknown[] }>(state, 'bob', 'collaboration_members', { scope: teamScope });
  assert.equal(JSON.stringify({ context, members }).includes('secret'), false);
  assert.equal(call<{ items: unknown[] }>(state, 'carol', 'message_list', {}).items.length, 0);
  assert.equal(readCollaborationContext(state, 'outsider').teams.items.length, 0);
  rejects(400, () => call(state, 'alice', 'message_list', { limit: 21 }));
  rejects(400, () => send(state, { content: 'x'.repeat(8_001) }));
  rejects(400, () => call(state, 'alice', 'artifact_publish', { scope: teamScope, name: 'large', content: 'x'.repeat(64_001) }));
});

test('worker tool discovery has strict JSON schemas and excludes project access mutations', () => {
  assert.ok(collaborationTools.length > 10);
  assert.equal(collaborationTools.some((tool) => (['project_create', 'project_update'] as string[]).includes(tool.name)), false);
  for (const tool of collaborationTools) {
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description);
  }
});
