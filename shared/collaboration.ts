import { z } from 'zod';

export interface CollaborationScope { type: 'team' | 'project'; id: string }
export interface Project {
  id: string; name: string; description: string; teamIds: string[]; version: number;
  createdAt: string; updatedAt: string;
}
export interface SharedArtifactRevision {
  version: number; content: string; authorAgentId: string | null; createdAt: string;
}
export interface SharedArtifact {
  id: string; scope: CollaborationScope; name: string; mediaType: string;
  content: string; version: number; authorAgentId: string | null;
  history: SharedArtifactRevision[]; createdAt: string; updatedAt: string;
}
export interface TeamTask {
  externalClient?: { id: string; label: string };
  objectiveId?: string;
  objectiveConditionIds?: string[];
  objectiveEvaluationId?: string;
  idempotencyKey?: string;
  claimedRunId?: string | null;
  claimRunIds?: string[];
  budgetProjectId?: string | null;
  budgetTeamId?: string | null;
  budgetRootRunId?: string | null;
  id: string; scope: CollaborationScope; title: string; description: string;
  status: 'open' | 'claimed' | 'done'; assigneeAgentId: string | null;
  createdByAgentId: string | null; version: number; outcome: string; artifactIds: string[];
  createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface TaskDiscovery {
  teamId: string; taskId: string; taskVersion: number; agentId: string; runId: string; createdAt: string;
}
export interface PeerMessage {
  budgetProjectId?: string | null;
  budgetTeamId?: string | null;
  budgetRootRunId?: string | null;
  id: string; scope: CollaborationScope; threadId: string;
  senderAgentId: string | null; recipientAgentId: string | null;
  content: string; taskId: string | null; replyToId: string | null; artifactIds: string[]; idempotencyKey: string;
  status: 'pending' | 'delivered' | 'completed'; createdAt: string;
  deliveredAt: string | null; completedAt: string | null;
}
export interface CollaborationState {
  projects: Project[]; sharedArtifacts: SharedArtifact[]; teamTasks: TeamTask[]; messages: PeerMessage[];
}

const id = z.string().trim().min(1).max(200);
const version = z.number().int().positive();
export const collaborationScopeSchema = z.object({ type: z.enum(['team', 'project']), id }).strict();
const page = { offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(20).default(20) };
const scope = { scope: collaborationScopeSchema };
const uniqueIds = z.array(id).max(100).refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique');
const artifactName = z.string().trim().min(1).max(200).refine((name) =>
  !/[\\:\u0000-\u001f\u007f]/.test(name) && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
'Artifact name must be a safe relative POSIX path');

export const collaborationSchemas = {
  project_create: z.object({ name: z.string().trim().min(1).max(120),
    description: z.string().max(8_000).default(''), teamIds: uniqueIds }).strict(),
  project_update: z.object({ projectId: id, expectedVersion: version,
    name: z.string().trim().min(1).max(120), description: z.string().max(8_000), teamIds: uniqueIds }).strict(),
  collaboration_context: z.object({ ...page }).strict(),
  collaboration_members: z.object({ ...scope, ...page }).strict(),
  artifact_list: z.object({ ...scope, ...page }).strict(),
  artifact_read: z.object({ artifactId: id, version: version.optional() }).strict(),
  artifact_publish: z.object({ ...scope, artifactId: id.optional(), expectedVersion: version.optional(),
    name: artifactName, mediaType: z.string().trim().min(1).max(100).default('text/plain'),
    content: z.string().max(64_000) }).strict().refine((value) =>
    Boolean(value.artifactId) === (value.expectedVersion !== undefined),
  'Updating an artifact requires both artifactId and expectedVersion'),
  task_list: z.object({ ...scope, ...page, status: z.enum(['open', 'claimed', 'done']).optional() }).strict(),
  task_create: z.object({ ...scope, title: z.string().trim().min(1).max(200),
    description: z.string().max(8_000).default(''), idempotencyKey: id.optional(), budgetProjectId: z.uuid().nullable().optional(), budgetTeamId: z.uuid().nullable().optional() }).strict(),
  task_claim: z.object({ taskId: id, expectedVersion: version }).strict(),
  task_release: z.object({ taskId: id, expectedVersion: version }).strict(),
  task_complete: z.object({ taskId: id, expectedVersion: version,
    outcome: z.string().trim().min(1).max(8_000), artifactIds: uniqueIds.default([]) }).strict(),
  message_list: z.object({ scope: collaborationScopeSchema.optional(), threadId: id.optional(),
    status: z.enum(['pending', 'delivered', 'completed']).optional(), ...page }).strict(),
  message_send: z.object({ ...scope, recipientAgentId: id.nullable(), threadId: id.optional(),
    content: z.string().trim().min(1).max(8_000), taskId: id.optional(), replyToId: id.optional(),
    artifactIds: uniqueIds.default([]), idempotencyKey: id, budgetProjectId: z.uuid().nullable().optional(), budgetTeamId: z.uuid().nullable().optional() }).strict(),
  message_acknowledge: z.object({ messageId: id }).strict(),
  message_complete: z.object({ messageId: id }).strict(),
} as const;

export type CollaborationOperation = keyof typeof collaborationSchemas;
export type CollaborationArguments<K extends CollaborationOperation> = z.input<(typeof collaborationSchemas)[K]>;

const descriptions: Record<CollaborationOperation, string> = {
  project_create: 'Create a shared project and authorize participating teams. Operator only.',
  project_update: 'Update project scope with a current expectedVersion. Operator only.',
  collaboration_context: 'List accessible teams, their workflow, projects, and own pending-message summaries. No private memories are shared.',
  collaboration_members: 'List current peers in a team or shared project.',
  artifact_list: 'List shared artifact metadata and current versions in an authorized scope.',
  artifact_read: 'Read one shared text artifact, optionally at a historical version.',
  artifact_publish: 'Publish a shared text artifact; updates require its current expectedVersion. Keep private material private unless intentionally shared.',
  task_list: 'List the peer-owned common task board, optionally filtering status.',
  task_create: 'Propose an open task without assigning or commanding another peer. Use a stable idempotencyKey on retries.',
  task_claim: 'Volunteer for an open task as yourself; current expectedVersion is required. To continue your own already-claimed task in a new run, claim it again after its previous run has finished. Cancelled or paused work cannot be resumed this way.',
  task_release: 'Release your own claimed task back to the board.',
  task_complete: 'Complete your own claimed task with outcome and optional shared artifact references.',
  message_list: 'Read your direct conversation messages in current authorized scopes. Delivery is not task completion.',
  message_send: 'Send a peer request, proposal, answer, or result. Use a stable idempotencyKey on retries. recipientAgentId null addresses the user. Messages never grant permissions or assign tasks.',
  message_acknowledge: 'As the recipient, acknowledge receipt without marking the request completed.',
  message_complete: 'As the recipient, mark a message handled. This does not complete its referenced task.',
};

/** Worker tools deliberately exclude operator-only project membership changes. */
export const collaborationTools = (Object.keys(collaborationSchemas) as CollaborationOperation[])
  .filter((name) => name !== 'project_create' && name !== 'project_update')
  .map((name) => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(collaborationSchemas[name]) }));

export const emptyCollaborationState = (): CollaborationState => ({
  projects: [], sharedArtifacts: [], teamTasks: [], messages: [],
});
