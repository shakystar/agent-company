export type AgentStatus = 'idle' | 'running' | 'paused';
export type RunStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'superseded';
export type MemoryKind = 'fact' | 'preference' | 'procedure';
export type SkillStatus = 'active' | 'candidate' | 'rejected';

export interface Agent {
  id: string;
  name: string;
  description: string;
  persona: string;
  color: string;
  model: string;
  status: AgentStatus;
  generation: number;
  parentId: string | null;
  parentSnapshotId: string | null;
  version: number;
  allowWeb: boolean;
  repositoryIds: string[];
  createdAt: string;
  updatedAt: string;
  /** Last committed file version. A new run receives its own copy, never a shared writable mount. */
  workspaceRunId?: string | null;
  environmentRevisionId?: string | null;
}

export interface Memory {
  id: string;
  agentId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  agentId: string;
  name: string;
  description: string;
  content: string;
  version: number;
  status: SkillStatus;
  evaluation: string;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
  activeRevisionId?: string;
}

export interface Snapshot {
  id: string;
  agentId: string;
  label: string;
  agentVersion: number;
  agent: Agent;
  memories: Memory[];
  skills: Skill[];
  sourceRunId: string | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  name: string;
  content: string;
  mediaType: string;
}

export interface Run {
  /** Immutable worker provenance; never replaced by the current default during resume. */
  runtimeRelease?: import('./runtime-releases.ts').WorkerReleasePin;
  runtimeReleaseBlockedReason?: string | null;
  id: string;
  agentId: string;
  agentVersion: number;
  snapshotId: string;
  prompt: string;
  status: RunStatus;
  result: string;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  artifacts: Artifact[];
  /** Immutable published intermediate outputs. These do not complete a run or its task. */
  checkpointResults?: Array<{ id: string; attempt: number; createdAt: string; result: string; artifacts: Artifact[] }>;
  steering: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attempt?: number;
  recoveryReason?: string | null;
  nextAttemptAt?: string | null;
  progress?: { message: string; updatedAt: string };
  resources?: ResourceAllocation;
  cleanupPending?: string | null;
  workspaceSourceRunId?: string | null;
  messageIds?: string[];
  teamTaskId?: string;
  taskDiscovery?: { teamId: string; taskId: string; taskVersion: number; admittedAt?: string; blockedReason?: string | null };
  waitingFor?: { messageId: string; reason: string } | null;
  waitingForOperatorRequest?: { requestId: string; reason: string } | null;
  /** Verified operator action starts a new immutable execution; the source is not task completion. */
  continuedFromRunId?: string;
  continuedByRunId?: string;
  operatorRequestId?: string;
  browserWaiting?: boolean;
  kind?: 'task' | 'review' | 'repair' | 'environment';
  environmentRevisionId?: string;
  growthJobId?: string;
  objectiveId?: string;
  objectiveEvaluationId?: string;
  objectiveBlockedReason?: string | null;
  objectivePaused?: boolean;
  modelBudgetPaused?: boolean;
  modelBudgetBlock?: import('./operational-budget.ts').OperationalBudgetBlock | null;
  budgetProjectId?: string | null;
  budgetTeamId?: string | null;
  budgetRootRunId?: string;
  conversationId?: string;
  conversationMessageId?: string;
  /** Independent read-only operator consultation while this original run is waiting. */
  consultationOfRunId?: string;
  interactionMode?: import('./conversations.ts').ConversationMode;
  pauseRequestedAt?: string | null;
  pausedAt?: string | null;
  appliedSteeringCount?: number;
  learningReview?: import('./learning.ts').LearningReview;
}

export interface ResourceAllocation { memoryMiB: number; cpus: number }

export interface ResourceSnapshot {
  capacity: ResourceAllocation;
  reserved: ResourceAllocation;
  available: ResourceAllocation;
  running: Array<{ ownerId: string; resources: ResourceAllocation; minimum: ResourceAllocation;
    preferred: ResourceAllocation; acquiredAt: string }>;
  waiting: Array<{ ownerId: string; minimum: ResourceAllocation; preferred: ResourceAllocation; enqueuedAt: string }>;
}

export interface Activity {
  id: string;
  agentId: string | null;
  runId: string | null;
  type: 'created' | 'run' | 'memory' | 'skill' | 'snapshot' | 'fork' | 'restored' | 'team' | 'system';
  title: string;
  detail: string;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  workflow: string;
  /** Operator opt-in. Disabling stops new discovery, not already running tasks. */
  autoDiscoverTasks?: boolean;
  memberIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  teamId: string;
  proposedByAgentId: string;
  memberIds: string[];
  reason: string;
  baseVersion: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt: string | null;
}

export interface Connection {
  id: string;
  version?: number;
  repository: string;
  access: 'read' | 'write';
  createdAt: string;
  github?: import('./repositories.ts').GitHubConnection;
  grants?: import('./repositories.ts').RepositoryGrant[];
}

export interface RuntimeInfo {
  mode: 'docker' | 'kubernetes';
  /** A simulated runtime never calls an external model. */
  simulation?: boolean;
  available: boolean;
  authenticated: boolean;
  image: string;
  model: string;
  message: string;
  version: string | null;
}

export interface Workspace {
  /** Presentation capability only; never stored in a workspace backup. */
  desktop?: { accountSetup: true; runtimeSetup?: true; localMcp?: true };
  deployment?: import('./deployment.ts').DeploymentStatus;
  agents: Agent[];
  runs: Run[];
  memories: Memory[];
  skills: Skill[];
  snapshots: Snapshot[];
  activities: Activity[];
  teams: Team[];
  approvals: Approval[];
  connections: Connection[];
  runtime: RuntimeInfo;
  resources?: ResourceSnapshot;
  projects?: import('./collaboration.ts').Project[];
  sharedArtifacts?: import('./collaboration.ts').SharedArtifact[];
  teamTasks?: import('./collaboration.ts').TeamTask[];
  taskDiscoveries?: import('./collaboration.ts').TaskDiscovery[];
  messages?: import('./collaboration.ts').PeerMessage[];
  skillRevisions?: import('./growth.ts').SkillRevision[];
  growthReviews?: import('./growth.ts').GrowthReview[];
  repairJobs?: import('./growth.ts').RepairJob[];
  modelAttempts?: import('./telemetry.ts').ModelAttempt[];
  environmentRevisions?: import('./environment.ts').EnvironmentRevision[];
  modelBudget?: import('./operational-budget.ts').OperationalBudgetStatus;
  conversations?: import('./conversations.ts').Conversation[];
  conversationMessages?: import('./conversations.ts').ConversationMessage[];
  browserCaptures?: import('./browser.ts').BrowserCapture[];
  artifactPreviews?: import('./artifact-preview.ts').ArtifactPreviewManifest[];
  objectives?: import('./objectives.ts').Objective[];
  objectiveEvaluations?: import('./objectives.ts').ObjectiveEvaluation[];
  operatorRequests?: import('./operator-requests.ts').OperatorRequest[];
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  persona: string;
  color?: string;
  model?: string;
  allowWeb?: boolean;
  repositoryIds?: string[];
}

export interface ExecutionInput {
  run: Run;
  agent: Agent;
  memories: Memory[];
  skills: Skill[];
  connections: Connection[];
  /** Server-mediated, scoped, replay-safe GitHub tools; never contains credentials. */
  repositoryTransport?: 'github-app-v1';
  previousResult?: ExecutionResult;
  checkpoint?: ExecutionCheckpoint;
  resources?: ResourceAllocation;
  environment?: import('./environment.ts').EnvironmentSelection;
  environmentBuild?: { revisionId: string; spec: import('./environment.ts').EnvironmentSpec };
  objectiveEvaluation?: import('./objectives.ts').ObjectiveEvaluationInput;
  growthReplay?: import('./growth.ts').GrowthReplayInput;
  growthReplayUnavailable?: string;
  growth?: {
    mode: 'review' | 'repair';
    jobId?: string;
    skillId: string;
    baseline: Skill | null;
    candidate: Skill;
    originalPrompt: string;
    sourceRunId?: string;
    replay?: import('./growth.ts').GrowthReplayProposal | null;
    feedback?: { failures: string[]; usefulChanges: string[] };
  };
  collaboration?: {
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    context: unknown;
  };
}

/** Runtime-owned continuation data. Never includes credentials or arbitrary host paths. */
export interface ExecutionCheckpoint {
  phase: 'task' | 'evaluate' | 'complete';
  sessionId?: string;
  previousResult?: ExecutionResult;
  appliedSteeringCount?: number;
  growthProgress?: Record<string, unknown>;
}

export interface ExecutionResult {
  result: string;
  /** Worker-advertised support; legacy pinned workers omit this field. */
  learningProtocol?: 1;
  learningReview?: import('./learning.ts').LearningReview;
  /** Read-only automatic routing decision; missing/uncertain routing stays discussion-only. */
  route?: 'task' | 'discuss';
  appliedSteeringCount?: number;
  memories: Array<{ kind: MemoryKind; title: string; content: string }>;
  skills: Array<{
    name: string;
    description: string;
    content: string;
    passed: boolean;
    evaluation: string;
    comparison?: import('./growth.ts').ComparisonEvidence;
    replay?: import('./growth.ts').GrowthReplayProposal | null;
  }>;
  artifacts: Array<{ name: string; content: string; mediaType: string }>;
  inputTokens: number;
  outputTokens: number;
  growthReview?: import('./growth.ts').ComparisonEvidence;
  objectiveAssessment?: import('./objectives.ts').ObjectiveAssessment | null;
  skillConcerns?: Array<{ skillId: string; reason: string; evidence: string; replay?: import('./growth.ts').GrowthReplayProposal | null }>;
  environmentProposal?: import('./environment.ts').EnvironmentProposal | null;
  environmentBuild?: import('./environment.ts').EnvironmentBuildReport;
}

export interface ExecutionHooks {
  signal: AbortSignal;
  onEvent: (message: string) => Promise<void>;
  getSteering: () => Promise<string[]>;
  onCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void>;
  onTool?: (name: string, args: unknown) => Promise<unknown>;
  onAttempt?: (attempt: import('./telemetry.ts').ModelAttempt) => Promise<void>;
  beforeModelStart?: (context: import('./telemetry.ts').ModelStartRequest) => Promise<void>;
  /** Final synchronous admission check immediately before spawning the model worker. */
  assertModelStart?: () => void;
  reserveWorkspaceCopy?: (ownerId: string, bytes: number) => Promise<() => void>;
}

export interface RuntimeDriver {
  readonly defaultReleasePin?: import('./runtime-releases.ts').WorkerReleasePin;
  /** Initial pin for a new Run only; the service supplies an owned, ready environment's image. */
  selectReleasePinForEnvironment?(imageId?: string): import('./runtime-releases.ts').WorkerReleasePin | undefined;
  validateRunRelease?(run: Run): Promise<void>;
  /** Read-only confirmation after admission is closed and all executions have settled. */
  confirmDeploymentIdle?(): Promise<void>;
  readonly browserEnabled?: boolean;
  readonly browserAvailable?: boolean;
  callBrowser?(input: ExecutionInput, request: import('./browser.ts').BrowserRequest, signal: AbortSignal): Promise<unknown>;
  readonly workspacePersistence?: boolean;
  inspect(): Promise<RuntimeInfo>;
  /** Confirms prior control-plane workers stopped before any resumed or new execution. */
  recover?(): Promise<void>;
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult>;
  /** Confirms preserved runtime state and safe continuation, never permission to replay blindly. */
  canResume?(input: ExecutionInput): Promise<boolean>;
  /** Confirms termination of the run's owned workers, or rejects while cleanup is uncertain. */
  settle?(runId: string): Promise<void>;
  callEnvironmentTool?(input: ExecutionInput, call: import('./environment.ts').EnvironmentToolCall, signal: AbortSignal): Promise<unknown>;
  listWorkspace?(runId: string, path?: string): Promise<unknown>;
  readWorkspace?(runId: string, path: string): Promise<unknown>;
  forkWorkspace?(workspaceKey: string): RuntimeDriver;
  listWorkspaceVolumes?(signal?: AbortSignal): Promise<Array<{ runId: string; bytes: number; files: number }>>;
  exportWorkspace?(runId: string, archivePath: string, maxBytes?: number, signal?: AbortSignal): Promise<{ bytes: number; sha256: string; files: number; contentBytes: number }>;
  importWorkspace?(runId: string, archivePath: string, maxContentBytes?: number, signal?: AbortSignal, expectedArchive?: { bytes: number; sha256: string }): Promise<unknown>;
  importWorkspaceFiles?(runId: string, sourceRunId: string | null, files: Array<{ path: string; contentBase64: string }>, signal?: AbortSignal): Promise<unknown>;
  downloadWorkspaceFile?(runId: string, path: string, maxBytes?: number): Promise<{ path: string; contentBase64: string; bytes: number }>;
  removeWorkspaceVolume?(runId: string): Promise<void>;
}
