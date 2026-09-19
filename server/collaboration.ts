import { randomUUID } from 'node:crypto';
import { projectForScope, teamForScope, peerAttribution } from './budget-attribution.ts';
import type { Agent, Team } from '../shared/types.ts';
import {
  collaborationSchemas, type CollaborationOperation, type CollaborationScope, type CollaborationState,
  type PeerMessage, type Project, type SharedArtifact, type TeamTask,
} from '../shared/collaboration.ts';

export class CollaborationError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message); this.name = 'CollaborationError';
  }
}

export type CollaborationWorkspace = CollaborationState & {
  agents: Array<Pick<Agent, 'id' | 'name' | 'status'>>; teams: Team[];
};
const now = () => new Date().toISOString();
const sameScope = (a: CollaborationScope, b: CollaborationScope) => a.type === b.type && a.id === b.id;
function fail(status: number, message: string): never { throw new CollaborationError(status, message); }
function required<T extends { id: string }>(items: T[], id: string, label: string): T {
  return items.find((item) => item.id === id) ?? fail(404, `${label} not found`);
}
function requireActor(state: CollaborationWorkspace, actor: string | null): void {
  if (actor !== null) required(state.agents, actor, 'Agent');
}
function operator(actor: string | null): void {
  if (actor !== null) fail(403, 'Only the user can change project membership');
}
export function collaborationMemberIds(state: CollaborationWorkspace, scope: CollaborationScope): string[] {
  const teams = scope.type === 'team' ? [required(state.teams, scope.id, 'Team')]
    : required(state.projects, scope.id, 'Project').teamIds
      .map((id) => state.teams.find((team) => team.id === id)).filter((team): team is Team => Boolean(team));
  const existing = new Set(state.agents.map((agent) => agent.id));
  return [...new Set(teams.flatMap((team) => team.memberIds))].filter((id) => existing.has(id));
}
export function canAccessCollaborationScope(state: CollaborationWorkspace, actor: string | null,
  scope: CollaborationScope): boolean {
  try { return collaborationMemberIds(state, scope).includes(actor as string) || actor === null; }
  catch (error) { if (error instanceof CollaborationError && error.statusCode === 404) return false; throw error; }
}
function authorize(state: CollaborationWorkspace, actor: string | null, scope: CollaborationScope): void {
  const members = collaborationMemberIds(state, scope);
  if (actor !== null && !members.includes(actor)) fail(403, 'Current scope membership is required');
}
function currentVersion(value: { version: number }, expected: number): void {
  if (value.version !== expected) fail(409, 'Version changed; read current state before updating');
}
function page<T>(items: T[], offset: number, limit: number) {
  return { items: items.slice(offset, offset + limit), total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null };
}
function artifactMetadata(value: SharedArtifact) {
  const { content, history, ...metadata } = value;
  return { ...metadata, contentLength: content.length, versions: history.length + 1 };
}
function messageVisible(state: CollaborationWorkspace, actor: string | null, value: PeerMessage): boolean {
  return canAccessCollaborationScope(state, actor, value.scope)
    && (actor === null || value.senderAgentId === actor || value.recipientAgentId === actor);
}
function validateReferences(state: CollaborationWorkspace, actor: string | null, scope: CollaborationScope,
  taskId: string | undefined, artifactIds: string[]): void {
  if (taskId) {
    const task = required(state.teamTasks, taskId, 'Task');
    authorize(state, actor, task.scope);
    if (!sameScope(task.scope, scope)) fail(400, 'Task must belong to the message scope');
  }
  for (const id of artifactIds) {
    const artifact = required(state.sharedArtifacts, id, 'Artifact');
    authorize(state, actor, artifact.scope);
    if (!sameScope(artifact.scope, scope)) fail(400, 'Artifact must belong to the same scope');
  }
}

/** A deliberately public projection, never a spread of agent or workspace objects. */
export function readCollaborationContext(state: CollaborationWorkspace, actor: string | null,
  options: { offset?: number; limit?: number } = {}) {
  requireActor(state, actor);
  const { offset, limit } = collaborationSchemas.collaboration_context.parse(options);
  const teams = state.teams.filter((team) => actor === null || team.memberIds.includes(actor))
    .map((team) => ({ id: team.id, name: team.name, description: team.description.slice(0, 1_000),
      workflow: team.workflow.slice(0, 4_000), workflowTruncated: team.workflow.length > 4_000,
      memberIds: team.memberIds, version: team.version }));
  const projects = state.projects.filter((project) =>
    canAccessCollaborationScope(state, actor, { type: 'project', id: project.id }))
    .map((project) => ({ ...project, description: project.description.slice(0, 1_000) }));
  const inbox = state.messages.filter((message) => message.recipientAgentId === actor
    && message.status !== 'completed' && messageVisible(state, actor, message))
    .map((message) => ({ id: message.id, scope: message.scope, senderAgentId: message.senderAgentId,
      threadId: message.threadId, status: message.status, preview: message.content.slice(0, 500),
      createdAt: message.createdAt }));
  return structuredClone({ teams: page(teams, offset, limit), projects: page(projects, offset, limit),
    inbox: page(inbox, offset, limit) });
}

/** Call inside the existing workspace transaction; actor comes from the authenticated Run, not args. */
export function mutateCollaboration(state: CollaborationWorkspace, actor: string | null,
  operation: CollaborationOperation, args: unknown): unknown {
  requireActor(state, actor);
  if (!Object.hasOwn(collaborationSchemas, operation)) fail(400, 'Unknown collaboration operation');
  const parsed = collaborationSchemas[operation].safeParse(args);
  if (!parsed.success) fail(400, parsed.error.issues.map((issue) => issue.message).join('; '));
  // Parse in each branch to retain its exact inferred schema type without unchecked payload casts.
  switch (operation) {
    case 'project_create': {
      operator(actor);
      const input = collaborationSchemas.project_create.parse(args);
      for (const id of input.teamIds) required(state.teams, id, 'Team');
      const timestamp = now();
      const project: Project = { ...input, id: randomUUID(), version: 1, createdAt: timestamp, updatedAt: timestamp };
      state.projects.unshift(project); return structuredClone(project);
    }
    case 'project_update': {
      operator(actor);
      const input = collaborationSchemas.project_update.parse(args);
      const project = required(state.projects, input.projectId, 'Project');
      currentVersion(project, input.expectedVersion);
      for (const id of input.teamIds) required(state.teams, id, 'Team');
      Object.assign(project, { name: input.name, description: input.description, teamIds: input.teamIds,
        version: project.version + 1, updatedAt: now() });
      return structuredClone(project);
    }
    case 'collaboration_context': return readCollaborationContext(state, actor,
      collaborationSchemas.collaboration_context.parse(args));
    case 'collaboration_members': {
      const input = collaborationSchemas.collaboration_members.parse(args);
      authorize(state, actor, input.scope);
      const ids = new Set(collaborationMemberIds(state, input.scope));
      return page(state.agents.filter((agent) => ids.has(agent.id))
        .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })), input.offset, input.limit);
    }
    case 'artifact_list': {
      const input = collaborationSchemas.artifact_list.parse(args);
      authorize(state, actor, input.scope);
      return page(state.sharedArtifacts.filter((item) => sameScope(item.scope, input.scope))
        .map(artifactMetadata), input.offset, input.limit);
    }
    case 'artifact_read': {
      const input = collaborationSchemas.artifact_read.parse(args);
      const artifact = required(state.sharedArtifacts, input.artifactId, 'Artifact');
      authorize(state, actor, artifact.scope);
      if (input.version === undefined || input.version === artifact.version) {
        return { ...artifactMetadata(artifact), content: artifact.content };
      }
      const revision = artifact.history.find((item) => item.version === input.version)
        ?? fail(404, 'Artifact version not found');
      return { ...artifactMetadata(artifact), ...revision };
    }
    case 'artifact_publish': {
      const input = collaborationSchemas.artifact_publish.parse(args);
      authorize(state, actor, input.scope);
      const timestamp = now();
      if (input.artifactId) {
        const artifact = required(state.sharedArtifacts, input.artifactId, 'Artifact');
        authorize(state, actor, artifact.scope);
        if (!sameScope(artifact.scope, input.scope)) fail(400, 'Artifact cannot be moved between scopes');
        currentVersion(artifact, input.expectedVersion!);
        if (artifact.name !== input.name || artifact.mediaType !== input.mediaType) {
          fail(400, 'Artifact name and mediaType remain stable across revisions');
        }
        artifact.history.push({ version: artifact.version, content: artifact.content,
          authorAgentId: artifact.authorAgentId, createdAt: artifact.updatedAt });
        Object.assign(artifact, { content: input.content, authorAgentId: actor,
          version: artifact.version + 1, updatedAt: timestamp });
        return structuredClone(artifactMetadata(artifact));
      }
      if (state.sharedArtifacts.some((item) => sameScope(item.scope, input.scope) && item.name === input.name)) {
        fail(409, 'An artifact with that name exists; read its version before updating');
      }
      const artifact: SharedArtifact = { id: randomUUID(), scope: input.scope, name: input.name,
        mediaType: input.mediaType, content: input.content, version: 1, authorAgentId: actor,
        history: [], createdAt: timestamp, updatedAt: timestamp };
      state.sharedArtifacts.unshift(artifact); return structuredClone(artifactMetadata(artifact));
    }
    case 'task_list': {
      const input = collaborationSchemas.task_list.parse(args);
      authorize(state, actor, input.scope);
      return structuredClone(page(state.teamTasks.filter((item) => sameScope(item.scope, input.scope)
        && (!input.status || item.status === input.status)), input.offset, input.limit));
    }
    case 'task_create': {
      const input = collaborationSchemas.task_create.parse(args);
      authorize(state, actor, input.scope);
      if (actor !== null && (input.budgetProjectId !== undefined || input.budgetTeamId !== undefined)) fail(403, '에이전트는 원래 과제의 예산 귀속을 변경할 수 없습니다.');
      const duplicate = input.idempotencyKey ? state.teamTasks.find(task => task.createdByAgentId === actor && task.idempotencyKey === input.idempotencyKey) : undefined;
      if (duplicate) {
        if (!sameScope(duplicate.scope, input.scope) || duplicate.title !== input.title || duplicate.description !== input.description
          || input.budgetProjectId !== undefined && duplicate.budgetProjectId !== input.budgetProjectId
          || input.budgetTeamId !== undefined && duplicate.budgetTeamId !== input.budgetTeamId) fail(409, 'Idempotency key was already used with different task content');
        return structuredClone(duplicate);
      }
      const budgetProjectId = actor === null ? projectForScope(state, input.scope, input.budgetProjectId) : undefined;
      const budgetTeamId = actor === null ? teamForScope(state, input.scope, budgetProjectId!, input.budgetTeamId) : undefined;
      const timestamp = now();
      const task: TeamTask = { ...input, id: randomUUID(), status: 'open', assigneeAgentId: null,
        ...(actor === null ? { budgetProjectId, budgetTeamId, budgetRootRunId: null } : {}),
        createdByAgentId: actor, version: 1, outcome: '', artifactIds: [],
        createdAt: timestamp, updatedAt: timestamp, completedAt: null };
      state.teamTasks.unshift(task); return structuredClone(task);
    }
    case 'task_claim':
    case 'task_release':
    case 'task_complete': {
      const input = collaborationSchemas[operation].parse(args);
      const task = required(state.teamTasks, input.taskId, 'Task');
      authorize(state, actor, task.scope);
      if (actor === null) fail(403, 'The user may propose tasks; agents volunteer and complete their own work');
      currentVersion(task, input.expectedVersion);
      if (operation === 'task_claim') {
        if (task.status !== 'open') fail(409, 'Task is not open');
        task.status = 'claimed'; task.assigneeAgentId = actor;
      } else {
        if (task.status !== 'claimed' || task.assigneeAgentId !== actor) fail(403, 'Only the current assignee can change this task');
        if (operation === 'task_release') { task.status = 'open'; task.assigneeAgentId = null; task.claimedRunId = null; }
        else {
          const complete = collaborationSchemas.task_complete.parse(args);
          validateReferences(state, actor, task.scope, undefined, complete.artifactIds);
          task.status = 'done'; task.outcome = complete.outcome; task.artifactIds = complete.artifactIds;
          task.completedAt = now();
        }
      }
      task.version += 1; task.updatedAt = now(); return structuredClone(task);
    }
    case 'message_list': {
      const input = collaborationSchemas.message_list.parse(args);
      if (input.scope) authorize(state, actor, input.scope);
      return structuredClone(page(state.messages.filter((message) => messageVisible(state, actor, message)
        && (!input.scope || sameScope(message.scope, input.scope))
        && (!input.threadId || message.threadId === input.threadId)
        && (!input.status || message.status === input.status)), input.offset, input.limit));
    }
    case 'message_send': {
      const input = collaborationSchemas.message_send.parse(args);
      authorize(state, actor, input.scope);
      if (actor !== null && (input.budgetProjectId !== undefined || input.budgetTeamId !== undefined)) fail(403, '에이전트는 원래 과제의 예산 귀속을 변경할 수 없습니다.');
      if (input.recipientAgentId === actor) fail(400, 'Send requests to another peer or the user');
      if (input.recipientAgentId !== null) {
        required(state.agents, input.recipientAgentId, 'Recipient');
        authorize(state, input.recipientAgentId, input.scope);
      }
      validateReferences(state, actor, input.scope, input.taskId, input.artifactIds);
      let threadId = input.threadId;
      if (input.replyToId) {
        const original = required(state.messages, input.replyToId, 'Original message');
        if (!messageVisible(state, actor, original) || !sameScope(original.scope, input.scope)
          || original.recipientAgentId !== actor || original.senderAgentId !== input.recipientAgentId
          || (threadId !== undefined && original.threadId !== threadId)) {
          fail(403, 'A reply must return to the original sender in the same scope and thread');
        }
        threadId = original.threadId;
      }
      const duplicate = state.messages.find((message) => message.senderAgentId === actor
        && message.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        if (!sameScope(duplicate.scope, input.scope) || duplicate.recipientAgentId !== input.recipientAgentId
          || duplicate.content !== input.content || duplicate.taskId !== (input.taskId ?? null)
          || duplicate.replyToId !== (input.replyToId ?? null)
          || input.budgetProjectId !== undefined && duplicate.budgetProjectId !== input.budgetProjectId
          || input.budgetTeamId !== undefined && duplicate.budgetTeamId !== input.budgetTeamId
          || JSON.stringify(duplicate.artifactIds) !== JSON.stringify(input.artifactIds)
          || (threadId !== undefined && duplicate.threadId !== threadId)) {
          fail(409, 'Idempotency key was already used with different message content');
        }
        return structuredClone(duplicate);
      }
      if (threadId) {
        const thread = state.messages.filter((message) => message.threadId === threadId);
        for (const message of thread) {
          if (!sameScope(message.scope, input.scope) || !messageVisible(state, actor, message)
            || ![message.senderAgentId, message.recipientAgentId].includes(input.recipientAgentId)
            || ![message.senderAgentId, message.recipientAgentId].includes(actor)) {
            fail(403, 'Thread belongs to another scope or conversation');
          }
        }
      }
      const message: PeerMessage = { id: randomUUID(), scope: input.scope,
        threadId: threadId ?? randomUUID(), senderAgentId: actor, recipientAgentId: input.recipientAgentId,
        content: input.content, taskId: input.taskId ?? null, replyToId: input.replyToId ?? null, artifactIds: input.artifactIds,
        idempotencyKey: input.idempotencyKey, status: 'pending', createdAt: now(),
        deliveredAt: null, completedAt: null };
      if (actor === null) {
        const original = input.replyToId ? state.messages.find(item => item.id === input.replyToId)
          : threadId ? state.messages.find(item => item.threadId === threadId) : undefined;
        const task = input.taskId ? state.teamTasks.find(item => item.id === input.taskId) : undefined;
        const inherited = original ? peerAttribution(state, original) : task?.budgetProjectId !== undefined
          ? { projectId: task.budgetProjectId, teamId: task.budgetTeamId, rootRunId: task.budgetRootRunId ?? null } : undefined;
        if (inherited && task?.budgetProjectId !== undefined && task.budgetProjectId !== inherited.projectId) fail(403, '다른 프로젝트의 과제를 기존 대화에 혼합할 수 없습니다.');
        if (inherited && task && task.budgetTeamId !== inherited.teamId) fail(403, '다른 원팀의 과제를 기존 대화에 혼합할 수 없습니다.');
        if (inherited && input.budgetProjectId !== undefined && input.budgetProjectId !== inherited.projectId) fail(403, '답장·후속 요청은 원래 과제의 프로젝트에 합산합니다.');
        if (inherited && input.budgetTeamId !== undefined && input.budgetTeamId !== inherited.teamId) fail(403, '답장·후속 요청은 원래 과제의 팀에 합산합니다.');
        message.budgetProjectId = inherited ? inherited.projectId : projectForScope(state, input.scope, input.budgetProjectId);
        message.budgetTeamId = inherited ? inherited.teamId : teamForScope(state, input.scope, message.budgetProjectId, input.budgetTeamId);
        message.budgetRootRunId = inherited?.rootRunId ?? null;
      }
      state.messages.unshift(message); return structuredClone(message);
    }
    case 'message_acknowledge':
    case 'message_complete': {
      const input = collaborationSchemas[operation].parse(args);
      const message = required(state.messages, input.messageId, 'Message');
      authorize(state, actor, message.scope);
      if (message.recipientAgentId !== actor) fail(403, 'Only the recipient may acknowledge or complete a message');
      message.deliveredAt ??= now();
      if (operation === 'message_complete') { message.completedAt ??= now(); message.status = 'completed'; }
      else if (message.status === 'pending') message.status = 'delivered';
      return structuredClone(message);
    }
  }
}
