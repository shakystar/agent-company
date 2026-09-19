import { PGlite } from '@electric-sql/pglite';
import { ServiceStartupCleanupError } from './startup-cleanup.ts';
import type { ExecutionCheckpoint, ExecutionInput, Workspace } from '../shared/types.ts';
import type { CollaborationState } from '../shared/collaboration.ts';
import type { FileRecord } from '../shared/storage.ts';
import type { GrowthState } from '../shared/growth.ts';
import type { ModelAttempt } from '../shared/telemetry.ts';

export interface PersistedExecution {
  input: Pick<ExecutionInput, 'agent' | 'memories' | 'skills' | 'connections' | 'growth' | 'environment' | 'environmentBuild' | 'growthReplay' | 'growthReplayUnavailable' | 'objectiveEvaluation'>;
  checkpoint?: ExecutionCheckpoint;
  previousResult?: ExecutionInput['previousResult'];
  inputTokens: number;
  outputTokens: number;
  resumeRequired?: boolean;
  failedAttempts?: number;
  lastSessionId?: string;
  /** Latest quarantined proposal survives task/checkpoint replacement while waiting. */
  learningHeldProposals?: { inputHash: string; proposals: unknown };
}

export type WorkspaceState = Omit<Workspace, 'runtime' | 'resources' | 'modelBudget' | 'deployment'> & CollaborationState & GrowthState & import('../shared/conversations.ts').ConversationState & {
  deploymentHold?: import('../shared/deployment.ts').DeploymentHold;
  executionStates: Record<string, PersistedExecution>;
  deliveryRuns: Record<string, string>;
  messageOrigins: Record<string, string>;
  taskDiscoveries?: import('../shared/collaboration.ts').TaskDiscovery[];
  files: FileRecord[];
  fileVersions: Array<{ id: string; agentId: string; sourceRunId: string | null; createdAt: string }>;
  operatorPaused: boolean;
  modelAttempts: ModelAttempt[];
  environmentRevisions: import('../shared/environment.ts').EnvironmentRevision[];
  objectives: import('../shared/objectives.ts').Objective[];
  objectiveEvaluations: import('../shared/objectives.ts').ObjectiveEvaluation[];
  operatorRequests: import('../shared/operator-requests.ts').OperatorRequest[];
};

function emptyState(): WorkspaceState {
  return {
    agents: [], runs: [], memories: [], skills: [], snapshots: [],
    activities: [], teams: [], approvals: [], connections: [], executionStates: {},
    projects: [], sharedArtifacts: [], teamTasks: [], messages: [], deliveryRuns: {}, messageOrigins: {},
    files: [], fileVersions: [], operatorPaused: false,
    skillRevisions: [], growthReviews: [], repairJobs: [], modelAttempts: [], environmentRevisions: [],
    conversations: [], conversationMessages: [], taskDiscoveries: [],
    browserCaptures: [], artifactPreviews: [], objectives: [], objectiveEvaluations: [], operatorRequests: [],
  };
}

/** One PostgreSQL transaction is the consistency boundary for this personal workspace.
 * The single aggregate deliberately keeps snapshots, run results and growth atomic.
 * It is not intended to serve multiple control-plane replicas.
 */
export class WorkspaceStore {
  private queue: Promise<unknown> = Promise.resolve();
  writeGuard?: () => void;
  private constructor(private readonly db: PGlite) {}

  static async open(dataDir?: string): Promise<WorkspaceStore> {
    const db = new PGlite(dataDir);
    try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        revision bigint NOT NULL DEFAULT 0,
        value jsonb NOT NULL
      )
    `);
    await db.query(
      'INSERT INTO workspace_state (singleton, value) VALUES (true, $1::jsonb) ON CONFLICT DO NOTHING',
      [JSON.stringify(emptyState())],
    );
    return new WorkspaceStore(db);
    } catch (error) {
      try { await db.close(); }
      catch (cleanupError) { throw new ServiceStartupCleanupError(error, cleanupError); }
      throw error;
    }
  }

  async read(): Promise<WorkspaceState> {
    const result = await this.db.query<{ value: WorkspaceState }>(
      'SELECT value FROM workspace_state WHERE singleton = true',
    );
    return normalize(result.rows[0].value);
  }

  async change<T>(mutate: (state: WorkspaceState) => T): Promise<T> {
    return this.exclusive(() => this.changeLocked(mutate));
  }

  /** Serializes asynchronous maintenance with every state mutation. */
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  /** Only for code already holding exclusive(). */
  async changeLocked<T>(mutate: (state: WorkspaceState) => T): Promise<T> {
    this.writeGuard?.();
    return this.db.transaction(async (tx) => {
      const result = await tx.query<{ value: WorkspaceState }>(
        // The store queue and controller lock already serialize writers. A row
        // lock itself generates WAL, even when the mutation changes nothing.
        'SELECT value FROM workspace_state WHERE singleton = true',
      );
      const previous = JSON.stringify(result.rows[0].value);
      const state = normalize(result.rows[0].value);
      const value = mutate(state);
      const serialized = JSON.stringify(state);
      const returned = structuredClone(value);
      if (serialized !== previous) {
        // JSONB equality also covers key order and equivalent JSON encodings.
        // Do not manufacture a revision or a dead aggregate for either case.
        await tx.query(
          'UPDATE workspace_state SET value = $1::jsonb, revision = revision + 1 WHERE singleton = true AND value IS DISTINCT FROM $1::jsonb',
          [serialized],
        );
      }
      return returned;
    });
  }

  async replace(state: WorkspaceState): Promise<void> {
    await this.exclusive(async () => {
      await this.db.query('UPDATE workspace_state SET value = $1::jsonb, revision = revision + 1 WHERE singleton = true AND value IS DISTINCT FROM $1::jsonb', [JSON.stringify(normalize(structuredClone(state)))]);
    });
  }

  async close(): Promise<void> {
    await this.queue;
    await this.db.close();
  }
}

function normalize(state: WorkspaceState): WorkspaceState {
  state.executionStates ??= {};
  state.deliveryRuns ??= {};
  state.messageOrigins ??= {};
  state.projects ??= [];
  state.sharedArtifacts ??= [];
  state.teamTasks ??= [];
  state.taskDiscoveries ??= [];
  state.objectives ??= [];
  state.objectiveEvaluations ??= [];
  state.operatorRequests ??= [];
  state.messages ??= [];
  state.files ??= [];
  state.fileVersions ??= [];
  state.operatorPaused ??= false;
  state.skillRevisions ??= [];
  state.growthReviews ??= [];
  state.repairJobs ??= [];
  state.modelAttempts ??= [];
  state.environmentRevisions ??= [];
  state.conversations ??= [];
  state.conversationMessages ??= [];
  state.browserCaptures ??= [];
  if (state.artifactPreviews === undefined) state.artifactPreviews = [];
  return state;
}
