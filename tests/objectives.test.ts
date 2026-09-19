import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyObjectiveAssessment, objectiveHash, objectiveHasPendingWork, objectiveInput, objectiveRunBlock, objectiveScopeValid, validateObjectiveState } from '../server/objectives.ts';
import type { WorkspaceState } from '../server/store.ts';
import type { Objective, ObjectiveAssessment, ObjectiveEvaluation } from '../shared/objectives.ts';
import { createObjectiveSchema, objectiveAssessmentSchema } from '../shared/objectives.ts';
import type { Run } from '../shared/types.ts';

const timestamp = '2026-09-11T00:00:00.000Z';
function fixture() {
  const teamId = randomUUID(), agentId = randomUUID();
  const objective: Objective = { id: randomUUID(), idempotencyKey: 'fixture', teamId, scope: { type: 'team', id: teamId },
    title: 'Deliver a verified result', purpose: 'Produce the approved result', constraints: 'No external publication',
    conditions: [{ id: 'verified', text: 'The result is verified', requiresUserConfirmation: false }], confirmations: [],
    status: 'active', version: 1, blockedReason: null, lastInputHash: null, lastEvaluationId: null, createdAt: timestamp, updatedAt: timestamp };
  const state: WorkspaceState = { agents: [{ id: agentId, name: 'Fixture', description: '', persona: 'Model-free fixture', color: '#123456',
    model: 'fixture', status: 'idle', generation: 1, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false,
    repositoryIds: [], createdAt: timestamp, updatedAt: timestamp }],
    teams: [{ id: teamId, name: 'Fixture', description: '', workflow: '', memberIds: [agentId], version: 1, createdAt: timestamp, updatedAt: timestamp }],
    runs: [], memories: [], skills: [], snapshots: [], activities: [], approvals: [], connections: [], executionStates: {},
    projects: [], sharedArtifacts: [], teamTasks: [], messages: [], deliveryRuns: {}, messageOrigins: {}, files: [], fileVersions: [],
    operatorPaused: false, skillRevisions: [], growthReviews: [], repairJobs: [], modelAttempts: [], environmentRevisions: [],
    conversations: [], conversationMessages: [], objectives: [objective], objectiveEvaluations: [], operatorRequests: [] };
  function evaluate() {
    const input = objectiveInput(state, objective);
    const evaluation: ObjectiveEvaluation = { id: randomUUID(), objectiveId: objective.id, objectiveVersion: objective.version,
      inputHash: input.inputHash, artifactHash: input.artifactHash, runId: randomUUID(), status: 'queued', assessment: null,
      taskIds: [], reason: '', createdAt: timestamp, completedAt: null, evidence: input.evidence.map(({ content: _content, ...rest }) => rest) };
    state.objectiveEvaluations.unshift(evaluation);
    const assessment: ObjectiveAssessment = { inputHash: input.inputHash, reason: 'Verification is missing',
      conditions: objective.conditions.map(condition => ({ conditionId: condition.id, status: 'unmet', reason: 'No verification', evidenceIds: [] })),
      followUps: [{ conditionIds: ['verified'], title: 'Verify the result', description: 'Check the result and publish the reproducible evidence.' }] };
    return { input, evaluation, assessment, apply: (raw: unknown = assessment) => applyObjectiveAssessment(state, objective, evaluation, input, raw, timestamp),
      persist: () => {
        state.runs.push({ id: evaluation.runId, agentId, agentVersion: 1, snapshotId: randomUUID(), prompt: 'Frozen objective evaluation',
          objectiveId: objective.id, objectiveEvaluationId: evaluation.id, status: 'running', result: '', error: null,
          inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: timestamp, startedAt: timestamp, completedAt: null });
        state.executionStates[evaluation.runId] = { input: { agent: structuredClone(state.agents[0]), memories: [], skills: [], connections: [],
          objectiveEvaluation: structuredClone(input) }, inputTokens: 0, outputTokens: 0 };
      } };
  }
  function artifact(content = 'Evidence version one') {
    const artifact = { id: randomUUID(), scope: objective.scope, name: 'verification.md', mediaType: 'text/markdown', content,
      version: 1, authorAgentId: agentId, history: [], createdAt: timestamp, updatedAt: timestamp };
    state.sharedArtifacts.push(artifact); return artifact;
  }
  return { state, objective, agentId, evaluate, artifact };
}

test('objective schemas reject duplicate conditions, unknown authority fields and unbounded assessments', () => {
  const f = fixture();
  const { idempotencyKey, teamId, scope, title, purpose, constraints, conditions } = f.objective;
  const input = { idempotencyKey, teamId, scope, title, purpose, constraints, conditions };
  assert.equal(createObjectiveSchema.safeParse(input).success, true);
  assert.equal(createObjectiveSchema.safeParse({ ...input, conditions: [...conditions, ...conditions] }).success, false);
  assert.equal(createObjectiveSchema.safeParse({ ...input, allowExternalWrites: true }).success, false);
  const { assessment } = f.evaluate();
  assert.equal(objectiveAssessmentSchema.safeParse({ ...assessment, followUps: Array(11).fill(assessment.followUps[0]) }).success, false);
  assert.equal(objectiveAssessmentSchema.safeParse({ ...assessment, conditions: [{ ...assessment.conditions[0], evidenceIds: ['same', 'same'] }] }).success, false);
});

test('frozen input excludes other scopes, sorts deterministically and retains full original evidence', () => {
  const f = fixture(); const artifact = f.artifact('x'.repeat(64000));
  f.state.sharedArtifacts.push({ ...artifact, id: randomUUID(), scope: { type: 'team', id: randomUUID() }, content: 'Other team secret' });
  const input = objectiveInput(f.state, f.objective);
  assert.equal(input.evidence.length, 1); assert.equal(input.evidence[0].content.length, 64000);
  f.state.sharedArtifacts.reverse(); assert.equal(objectiveInput(f.state, f.objective).inputHash, input.inputHash);
  artifact.content = 'Changed'; artifact.version++;
  assert.equal(input.evidence[0].content.length, 64000);
  assert.notEqual(objectiveInput(f.state, f.objective).inputHash, input.inputHash);
});

test('valid followup is atomic and idempotent and preserves scope, condition and budget provenance', () => {
  const f = fixture(), e = f.evaluate(); e.apply(); e.apply();
  assert.equal(f.state.teamTasks.length, 1); assert.equal(e.evaluation.status, 'applied');
  const task = f.state.teamTasks[0];
  assert.equal(task.objectiveId, f.objective.id); assert.deepEqual(task.objectiveConditionIds, ['verified']);
  assert.equal(task.objectiveEvaluationId, e.evaluation.id); assert.deepEqual(task.scope, f.objective.scope);
  assert.equal(task.budgetTeamId, f.objective.teamId); assert.equal(task.budgetRootRunId, e.evaluation.runId);
  assert.equal(task.assigneeAgentId, null); assert.equal(task.status, 'open');
  assert.match(task.description, /No external publication/); assert.equal(objectiveHasPendingWork(f.state, f.objective), true);
});

for (const mutation of ['hash', 'missing-condition', 'unknown-condition', 'unknown-evidence', 'unsupported-met', 'blocked-followup', 'duplicate-coverage'] as const) {
  test(`assessment fails before task or objective mutation: ${mutation}`, () => {
    const f = fixture(), e = f.evaluate();
    if (mutation === 'hash') e.assessment.inputHash = '0'.repeat(64);
    if (mutation === 'missing-condition') e.assessment.conditions = [];
    if (mutation === 'unknown-condition') e.assessment.conditions[0].conditionId = 'invented';
    if (mutation === 'unknown-evidence') e.assessment.conditions[0].evidenceIds = ['artifact:invented:1'];
    if (mutation === 'unsupported-met') { e.assessment.conditions[0].status = 'met'; e.assessment.followUps = []; }
    if (mutation === 'blocked-followup') e.assessment.conditions[0].status = 'blocked';
    if (mutation === 'duplicate-coverage') e.assessment.followUps.push({ ...e.assessment.followUps[0], title: 'Same condition again' });
    const before = structuredClone(f.state); assert.throws(() => e.apply()); assert.deepEqual(f.state, before);
  });
}

test('a model cannot substitute an artifact for required user confirmation', () => {
  const f = fixture(); f.objective.conditions[0].requiresUserConfirmation = true; f.artifact('Looks approved');
  const e = f.evaluate(); e.assessment.conditions[0].status = 'met'; e.assessment.conditions[0].evidenceIds = [e.input.evidence[0].id]; e.assessment.followUps = [];
  assert.throws(() => e.apply()); assert.equal(f.objective.status, 'active');
  f.objective.confirmations.push({ conditionId: 'verified', note: 'User accepted', createdAt: timestamp }); f.objective.version++;
  const confirmed = f.evaluate(); confirmed.assessment.conditions[0].status = 'met';
  confirmed.assessment.conditions[0].evidenceIds = ['confirmation:verified']; confirmed.assessment.followUps = []; confirmed.apply();
  assert.equal(f.objective.status, 'completed'); assert.equal(f.state.teamTasks.length, 0);
});

for (const change of ['artifact', 'objective-version', 'membership', 'paused'] as const) {
  test(`assessment is retained but not applied after concurrent ${change} change`, () => {
    const f = fixture(); const artifact = f.artifact(); const e = f.evaluate();
    if (change === 'artifact') { artifact.content = 'New evidence'; artifact.version++; }
    if (change === 'objective-version') f.objective.version++;
    if (change === 'membership') f.state.teams[0].version++;
    if (change === 'paused') f.objective.status = 'paused';
    e.apply(); assert.equal(e.evaluation.status, 'stale'); assert.deepEqual(e.evaluation.assessment, e.assessment);
    assert.equal(f.state.teamTasks.length, 0);
  });
}

test('a completed task report without new evidence cannot generate an endless followup loop', () => {
  const f = fixture(); const e = f.evaluate(); e.apply();
  const task = f.state.teamTasks[0]; task.status = 'done'; task.outcome = 'Still not verified'; task.version++;
  const again = f.evaluate(); assert.notEqual(again.input.inputHash, e.input.inputHash); again.apply();
  assert.equal(again.evaluation.status, 'applied'); assert.equal(again.evaluation.taskIds.length, 0);
  assert.equal(f.state.teamTasks.length, 1); assert.ok(f.objective.blockedReason);
  f.artifact('New independent verification attempt'); const changed = f.evaluate(); changed.apply();
  assert.equal(changed.evaluation.taskIds.length, 1);
});

test('identical artifact republication does not count as progress', () => {
  const f = fixture(); const artifact = f.artifact(); const e = f.evaluate(); e.apply();
  f.state.teamTasks[0].status = 'done'; f.state.teamTasks[0].outcome = 'Republished'; f.state.teamTasks[0].version++;
  artifact.version++;
  const again = f.evaluate(); again.apply(); assert.equal(again.evaluation.taskIds.length, 0);
});

test('one assessment cannot create duplicate task titles for different conditions', () => {
  const f = fixture(); f.objective.conditions.push({ id: 'second', text: 'Another required check', requiresUserConfirmation: false });
  const e = f.evaluate(); e.assessment.followUps.push({ ...e.assessment.followUps[0], conditionIds: ['second'], title: '  VERIFY THE RESULT  ' });
  assert.throws(() => e.apply()); assert.equal(f.state.teamTasks.length, 0);
});

test('scope and run gates cover absent teams, project membership, terminal objectives and inherited children', () => {
  const f = fixture(); assert.equal(objectiveScopeValid(f.state, f.objective), true);
  const root = { id: randomUUID(), agentId: f.agentId, objectiveId: f.objective.id, status: 'succeeded' } as Run;
  const child = { id: randomUUID(), agentId: f.agentId, budgetRootRunId: root.id, status: 'queued' } as Run;
  f.state.runs.push(root, child); assert.equal(objectiveRunBlock(f.state, child), null);
  f.objective.status = 'paused'; assert.equal(objectiveRunBlock(f.state, child)?.terminal, false);
  f.objective.status = 'cancelled'; assert.equal(objectiveRunBlock(f.state, child)?.terminal, true);
  f.objective.status = 'active'; f.state.teams[0].memberIds = []; assert.equal(objectiveRunBlock(f.state, child)?.terminal, false);
  assert.equal(objectiveScopeValid(f.state, f.objective), false);
  f.state.teams[0].memberIds = [f.agentId]; f.objective.scope = { type: 'project', id: randomUUID() };
  assert.equal(objectiveScopeValid(f.state, f.objective), false);
});

test('oversized evidence fails closed instead of truncating source material', () => {
  const f = fixture(); f.artifact('x'.repeat(1024 * 1024)); assert.throws(() => objectiveInput(f.state, f.objective), /1MiB/);
});

test('backup validation preserves historical inputs after current team, purpose and user confirmation edits', () => {
  const f = fixture(); f.artifact(); f.objective.conditions[0].requiresUserConfirmation = true;
  f.objective.confirmations.push({ conditionId: 'verified', note: 'Original acceptance', createdAt: timestamp });
  const e = f.evaluate(); e.persist(); e.assessment.conditions[0].status = 'met'; e.assessment.conditions[0].evidenceIds = ['confirmation:verified'];
  e.assessment.followUps = []; e.apply(); f.state.runs[0].status = 'succeeded';
  const frozen = structuredClone(f.state.executionStates[e.evaluation.runId].input.objectiveEvaluation);
  f.objective.version++; f.objective.status = 'paused'; f.objective.purpose = 'Revised purpose';
  f.objective.conditions = [{ id: 'new_condition', text: 'New completion condition', requiresUserConfirmation: false }]; f.objective.confirmations = [];
  f.state.teams[0].memberIds = []; f.state.teams[0].version++;
  assert.doesNotThrow(() => validateObjectiveState(f.state));
  assert.deepEqual(f.state.executionStates[e.evaluation.runId].input.objectiveEvaluation, frozen);
  assert.equal(frozen!.evidence.find(item => item.kind === 'user_confirmation')!.content, 'Original acceptance');
});

test('backup validation rejects missing evaluation run, generated task and last evaluation references', () => {
  const f = fixture(), e = f.evaluate(); e.persist(); e.apply(); assert.doesNotThrow(() => validateObjectiveState(f.state));
  for (const corrupt of [(state: WorkspaceState) => { state.runs = []; },
    (state: WorkspaceState) => { state.teamTasks = []; },
    (state: WorkspaceState) => { state.objectives[0].lastEvaluationId = randomUUID(); }]) {
    const broken = structuredClone(f.state); corrupt(broken); assert.throws(() => validateObjectiveState(broken));
  }
});

test('backup validation detects altered frozen content, input hash and recorded evidence metadata', () => {
  const f = fixture(); f.artifact(); const e = f.evaluate(); e.persist();
  for (const corrupt of [(state: WorkspaceState) => { state.executionStates[e.evaluation.runId].input.objectiveEvaluation!.evidence[0].content = 'Tampered'; },
    (state: WorkspaceState) => { state.executionStates[e.evaluation.runId].input.objectiveEvaluation!.inputHash = '0'.repeat(64); },
    (state: WorkspaceState) => { state.objectiveEvaluations[0].evidence[0].title = 'Tampered metadata'; }]) {
    const broken = structuredClone(f.state); corrupt(broken); assert.throws(() => validateObjectiveState(broken));
  }
});

test('backup validation rejects malformed objective collections, duplicate IDs and invalid evaluation states', () => {
  const f = fixture(), e = f.evaluate(); e.persist();
  for (const broken of [ { ...structuredClone(f.state), objectives: {} }, { ...structuredClone(f.state), objectiveEvaluations: {} },
    { ...structuredClone(f.state), objectiveEvaluations: [e.evaluation, e.evaluation] },
    { ...structuredClone(f.state), objectiveEvaluations: [{ ...e.evaluation, status: 'not-a-state' }] } ]) {
    assert.throws(() => validateObjectiveState(broken as WorkspaceState));
  }
});

test('backup validation rejects orphan task origins and corrupted no-progress hashes', () => {
  const f = fixture(), e = f.evaluate(); e.persist(); e.apply();
  const orphan = structuredClone(f.state); orphan.teamTasks[0].objectiveEvaluationId = randomUUID(); orphan.objectiveEvaluations[0].taskIds = [];
  assert.throws(() => validateObjectiveState(orphan));
  const altered = structuredClone(f.state); altered.objectiveEvaluations[0].artifactHash = '0'.repeat(64);
  altered.executionStates[e.evaluation.runId].input.objectiveEvaluation!.artifactHash = '0'.repeat(64);
  assert.throws(() => validateObjectiveState(altered));
});

test('evidence digests hash exact UTF-8 source bytes for artifacts, task reports and user confirmations', () => {
  const f = fixture(); f.artifact('abc');
  const first = f.evaluate(); first.persist(); first.apply();
  const task = f.state.teamTasks[0]; task.status = 'done'; task.outcome = '한글 "검증"\r\n다음 줄\\끝\n'; task.version++;
  f.objective.confirmations.push({ conditionId: 'verified', note: 'abc', createdAt: timestamp });
  const next = f.evaluate(); next.persist();
  const artifact = next.input.evidence.find(item => item.kind === 'artifact')!;
  const report = next.input.evidence.find(item => item.kind === 'task_report')!;
  const confirmation = next.input.evidence.find(item => item.kind === 'user_confirmation')!;
  const abcDigest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.ok(next.input.evidence.every(item => item.hashEncoding === 'utf8'));
  assert.equal(artifact.sha256, abcDigest); assert.equal(confirmation.sha256, abcDigest);
  assert.equal(report.sha256, createHash('sha256').update(Buffer.from(task.outcome, 'utf8')).digest('hex'));
  assert.notEqual(report.sha256, objectiveHash(task.outcome));
  assert.notEqual(report.sha256, createHash('sha256').update(task.outcome.replace(/\r\n/g, '\n'), 'utf8').digest('hex'));
  assert.doesNotThrow(() => validateObjectiveState(f.state));
});

test('empty source hash and canonical object hashing retain their distinct contracts', () => {
  const f = fixture(); f.artifact('');
  assert.equal(objectiveInput(f.state, f.objective).evidence[0].sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(objectiveHash({ z: 2, a: { y: 1, b: 0 } }),
    createHash('sha256').update('{"a":{"b":0,"y":1},"z":2}', 'utf8').digest('hex'));
  assert.equal(objectiveHash('abc'), createHash('sha256').update('"abc"', 'utf8').digest('hex'));
});

test('backup rejects JSON-string hashes labeled as UTF-8 without rewriting records', () => {
  const f = fixture(); f.artifact('abc'); const e = f.evaluate(); e.persist();
  const input = f.state.executionStates[e.evaluation.runId].input.objectiveEvaluation!;
  input.evidence[0].sha256 = objectiveHash(input.evidence[0].content);
  e.evaluation.evidence[0].sha256 = input.evidence[0].sha256;
  input.artifactHash = objectiveHash(input.evidence.map(item => JSON.stringify({ kind: item.kind, sha256: item.sha256, title: item.title })));
  e.evaluation.artifactHash = input.artifactHash;
  const { inputHash: _inputHash, artifactHash: _artifactHash, ...fields } = input;
  input.inputHash = objectiveHash(fields); e.evaluation.inputHash = input.inputHash;
  const before = structuredClone(f.state);
  assert.throws(() => validateObjectiveState(f.state), /UTF-8 원문 SHA-256/);
  assert.deepEqual(f.state, before);
});

test('backup accepts explicitly identified historical JSON-string evidence without upgrading frozen input', () => {
  const f = fixture(); f.artifact('abc'); const e = f.evaluate(); e.persist();
  const input = f.state.executionStates[e.evaluation.runId].input.objectiveEvaluation!;
  delete input.evidence[0].hashEncoding; delete e.evaluation.evidence[0].hashEncoding;
  input.evidence[0].sha256 = objectiveHash(input.evidence[0].content); e.evaluation.evidence[0].sha256 = input.evidence[0].sha256;
  input.artifactHash = objectiveHash(input.evidence.map(item => JSON.stringify({ kind: item.kind, sha256: item.sha256, title: item.title })));
  e.evaluation.artifactHash = input.artifactHash;
  const { inputHash: _inputHash, artifactHash: _artifactHash, ...fields } = input;
  input.inputHash = objectiveHash(fields); e.evaluation.inputHash = input.inputHash;
  const before = structuredClone(f.state); assert.doesNotThrow(() => validateObjectiveState(f.state)); assert.deepEqual(f.state, before);
  const current = objectiveInput(f.state, f.objective);
  assert.equal(current.evidence[0].hashEncoding, 'utf8'); assert.notEqual(current.evidence[0].sha256, input.evidence[0].sha256);
  assert.equal(f.state.executionStates[e.evaluation.runId].input.objectiveEvaluation!.evidence[0].hashEncoding, undefined);
});

function delegatedFixture() {
  const f = fixture(), projectId = randomUUID(), helperTeamId = randomUUID();
  const helper = { ...f.state.agents[0], id: randomUUID(), name: 'Sales' }, nextHelper = { ...f.state.agents[0], id: randomUUID(), name: 'Research' };
  f.state.agents.push(helper, nextHelper);
  f.state.teams.push({ ...f.state.teams[0], id: helperTeamId, memberIds: [helper.id, nextHelper.id] });
  const project = { id: projectId, name: 'Shared project', description: '', teamIds: [f.objective.teamId, helperTeamId], version: 1, createdAt: timestamp, updatedAt: timestamp };
  f.state.projects.push(project); f.objective.scope = { type: 'project', id: projectId };
  const rootId = randomUUID();
  const root: Run = { id: rootId, agentId: f.agentId, agentVersion: 1, snapshotId: randomUUID(), prompt: 'Original objective', status: 'running', result: '', error: null,
    inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: timestamp, startedAt: timestamp, completedAt: null,
    objectiveId: f.objective.id, budgetRootRunId: rootId, budgetTeamId: f.objective.teamId, budgetProjectId: projectId };
  f.state.runs.push(root);
  const delegate = (source: Run, recipient: string) => {
    const id = randomUUID(), messageId = randomUUID();
    const run: Run = { ...root, id, agentId: recipient, messageIds: [messageId] };
    const message: WorkspaceState['messages'][number] = { id: messageId, scope: f.objective.scope, threadId: randomUUID(), senderAgentId: source.agentId,
      recipientAgentId: recipient, content: 'Peer request', taskId: null, replyToId: null, artifactIds: [], idempotencyKey: messageId,
      status: 'pending', createdAt: timestamp, deliveredAt: null, completedAt: null,
      budgetRootRunId: rootId, budgetTeamId: f.objective.teamId, budgetProjectId: projectId };
    f.state.runs.push(run); f.state.messages.push(message); f.state.deliveryRuns[messageId] = id; f.state.messageOrigins[messageId] = source.id;
    return { run, message };
  };
  const first = delegate(root, helper.id), second = delegate(first.run, nextHelper.id);
  return { ...f, project, root, first, second, helper, nextHelper, helperTeamId, delegate };
}

test('only stored shared-project delegation grants objective execution to another team, including a valid request chain', () => {
  const f = delegatedFixture();
  assert.equal(objectiveRunBlock(f.state, f.first.run), null); assert.equal(objectiveRunBlock(f.state, f.second.run), null);
  f.root.status = 'waiting'; assert.equal(objectiveRunBlock(f.state, f.second.run), null);
  const reply = f.delegate(f.second.run, f.helper.id); assert.equal(objectiveRunBlock(f.state, reply.run), null);
  assert.equal(f.state.teams[0].memberIds.includes(f.helper.id), false);
});

for (const defect of ['delivery-missing', 'delivery-other-run', 'origin-missing', 'sender', 'recipient', 'team-scope', 'message-root',
  'message-project', 'message-team', 'run-root', 'source-objective', 'source-root', 'source-paused', 'source-cancelled', 'task-claim', 'task-discovery', 'evaluation', 'cycle'] as const) {
  test(`objective delegation rejects forged or inapplicable provenance: ${defect}`, () => {
    const f = delegatedFixture(); const { run, message } = f.first;
    if (defect === 'delivery-missing') delete f.state.deliveryRuns[message.id];
    if (defect === 'delivery-other-run') f.state.deliveryRuns[message.id] = f.second.run.id;
    if (defect === 'origin-missing') delete f.state.messageOrigins[message.id];
    if (defect === 'sender') message.senderAgentId = f.nextHelper.id;
    if (defect === 'recipient') message.recipientAgentId = f.nextHelper.id;
    if (defect === 'team-scope') message.scope = { type: 'team', id: f.helperTeamId };
    if (defect === 'message-root') message.budgetRootRunId = f.second.run.id;
    if (defect === 'message-project') message.budgetProjectId = randomUUID();
    if (defect === 'message-team') message.budgetTeamId = f.helperTeamId;
    if (defect === 'run-root') run.budgetRootRunId = f.second.run.id;
    if (defect === 'source-objective') f.root.objectiveId = randomUUID();
    if (defect === 'source-root') f.root.budgetRootRunId = f.second.run.id;
    if (defect === 'source-paused') f.root.pauseRequestedAt = timestamp;
    if (defect === 'source-cancelled') f.root.status = 'cancelled';
    if (defect === 'task-claim') run.teamTaskId = randomUUID();
    if (defect === 'task-discovery') run.taskDiscovery = { teamId: f.objective.teamId, taskId: randomUUID(), taskVersion: 1 };
    if (defect === 'evaluation') run.objectiveEvaluationId = randomUUID();
    if (defect === 'cycle') { message.senderAgentId = f.second.run.agentId; f.state.messageOrigins[message.id] = f.second.run.id; }
    assert.ok(objectiveRunBlock(f.state, run)); assert.ok(objectiveRunBlock(f.state, f.second.run));
  });
}

test('delegation rechecks current project and team membership and every objective stop state', () => {
  for (const revoke of [(f: ReturnType<typeof delegatedFixture>) => { f.project.teamIds = [f.objective.teamId]; },
    (f: ReturnType<typeof delegatedFixture>) => { f.state.teams[1].memberIds = []; },
    (f: ReturnType<typeof delegatedFixture>) => { f.state.teams[0].memberIds = [f.nextHelper.id]; },
    (f: ReturnType<typeof delegatedFixture>) => { f.objective.status = 'paused'; },
    (f: ReturnType<typeof delegatedFixture>) => { f.objective.status = 'cancelled'; },
    (f: ReturnType<typeof delegatedFixture>) => { f.objective.status = 'completed'; },
    (f: ReturnType<typeof delegatedFixture>) => { f.objective.scope = { type: 'team', id: f.objective.teamId }; }]) {
    const f = delegatedFixture(); revoke(f); assert.ok(objectiveRunBlock(f.state, f.first.run));
  }
});

function delegatedGrowthFixture(mode: 'review' | 'repair') {
  const f = delegatedFixture(); f.first.run.status = 'succeeded';
  const run: Run = { ...f.first.run, id: randomUUID(), status: 'queued', kind: mode, messageIds: undefined };
  const candidate = { id: randomUUID(), agentId: f.helper.id, name: 'Review procedure', description: '', content: 'Check evidence', version: 1,
    status: 'active' as const, evaluation: '', sourceRunId: f.first.run.id, createdAt: timestamp, updatedAt: timestamp };
  const saved = { input: { agent: f.helper, memories: [], skills: [], connections: [], growth: { mode, skillId: candidate.id,
    baseline: null, candidate, originalPrompt: 'Review the project', sourceRunId: f.first.run.id } }, inputTokens: 0, outputTokens: 0 };
  f.state.runs.push(run); f.state.executionStates[run.id] = saved;
  return { ...f, growthRun: run, saved };
}

for (const mode of ['review', 'repair'] as const) {
  test(`delegated ${mode} inherits only a completed same-agent objective source with intact request provenance`, () => {
    const valid = delegatedGrowthFixture(mode); assert.equal(objectiveRunBlock(valid.state, valid.growthRun), null);
    const defects = ['missing-input', 'unknown-source', 'different-agent', 'unfinished-source', 'different-objective', 'different-root',
      'different-team', 'different-project', 'wrong-mode', 'ordinary-run', 'revoked-project', 'revoked-sender', 'forged-delivery', 'source-self', 'objective-pause'] as const;
    for (const defect of defects) {
      const f = delegatedGrowthFixture(mode);
      if (defect === 'missing-input') delete f.state.executionStates[f.growthRun.id];
      if (defect === 'unknown-source') f.saved.input.growth.sourceRunId = randomUUID();
      if (defect === 'different-agent') f.first.run.agentId = f.nextHelper.id;
      if (defect === 'unfinished-source') f.first.run.status = 'running';
      if (defect === 'different-objective') f.first.run.objectiveId = randomUUID();
      if (defect === 'different-root') f.first.run.budgetRootRunId = f.second.run.id;
      if (defect === 'different-team') f.first.run.budgetTeamId = f.helperTeamId;
      if (defect === 'different-project') f.first.run.budgetProjectId = randomUUID();
      if (defect === 'wrong-mode') f.saved.input.growth.mode = mode === 'review' ? 'repair' : 'review';
      if (defect === 'ordinary-run') f.growthRun.kind = 'task';
      if (defect === 'revoked-project') f.project.teamIds = [f.objective.teamId];
      if (defect === 'revoked-sender') f.state.teams[0].memberIds = [f.nextHelper.id];
      if (defect === 'forged-delivery') f.state.deliveryRuns[f.first.message.id] = f.second.run.id;
      if (defect === 'source-self') f.saved.input.growth.sourceRunId = f.growthRun.id;
      if (defect === 'objective-pause') f.objective.status = 'paused';
      assert.ok(objectiveRunBlock(f.state, f.growthRun), `${mode}: ${defect}`);
    }
  });
}
