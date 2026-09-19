import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.ts';
import { ContainerRuntime, runtimeConfig, type RuntimeConfig } from '../server/runtime.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { OperationVerificationCampaign } from '../server/verification-campaign.ts';
import { atomicJson } from '../server/storage.ts';
import { command } from '../server/process.ts';
import type { Agent, ExecutionHooks, ExecutionInput, ExecutionResult, Run, Team, Workspace } from '../shared/types.ts';
import type { SharedArtifact } from '../shared/collaboration.ts';
import type { Objective } from '../shared/objectives.ts';

// Controlled local-source audit. This does not test Formnest product quality or
// call GitHub, send messages, publish a site, replace production state or select a release.
// --prepare writes reviewable inputs only. --run requires an independently built
// immutable worker image and preserves the same campaign budget on every retry.
const argumentsList = process.argv.slice(2);
assert.ok(argumentsList.every(value => value === '--prepare' || value === '--run' || value.startsWith('--image=')), 'Usage: --prepare | --run --image=sha256:...');
assert.ok(!(argumentsList.includes('--prepare') && argumentsList.includes('--run')));
const live = argumentsList.includes('--run');
const image = argumentsList.find(value => value.startsWith('--image='))?.slice('--image='.length);
if (live) assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'An explicitly built immutable worker image is required');
const directory = resolve('.verification/objective-growth-20260911');
const preparedPath = join(directory, 'prepared.json');
const progressPath = join(directory, 'progress.json');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourcePath = 'worker/growth.mjs';
const source = await readFile(resolve(sourcePath), 'utf8');
const workerFiles = ['Dockerfile', 'entry.mjs', 'principles.mjs', 'team-mcp.mjs', 'browser-source.mjs', 'workspace.mjs', 'storage.mjs', 'growth.mjs', 'environment.mjs', 'npm-empty.npmrc'];
const workerHashes = Object.fromEntries(await Promise.all(workerFiles.map(async name => [name, digest(await readFile(resolve('worker', name)))])));
const fixtureCases = [
  { id: 'cost-metadata', input: { result: 'Kept result', artifacts: [], inputTokens: 81, durationMs: 1200 }, expected: { result: 'Kept result', memories: [], skills: [], artifacts: [] } },
  { id: 'artifact-metadata', input: { result: 'With artifact', artifacts: [{ name: 'proof.json', content: '{"inputTokens":7}', mediaType: 'application/json', outputTokens: 91 }], skills: [{ name: 'useful', description: 'procedure', content: 'retained', inputTokens: 3 }] },
    expected: { result: 'With artifact', memories: [], skills: [{ name: 'useful', description: 'procedure', content: 'retained' }], artifacts: [{ name: 'proof.json', content: '{"inputTokens":7}', mediaType: 'application/json' }] } },
  { id: 'missing-artifacts', input: { result: 'No artifact array', memories: [{ kind: 'fact', title: 'Known', content: 'retained' }], telemetry: { usage: 10 } }, expected: { result: 'No artifact array', memories: [{ kind: 'fact', title: 'Known', content: 'retained' }], skills: [], artifacts: [] } },
];
const { qualityTask } = await import(new URL('../worker/growth.mjs', import.meta.url).href);
for (const fixture of fixtureCases) assert.deepEqual(qualityTask(fixture.input), fixture.expected, `Prepared fixture differs from current trusted source: ${fixture.id}`);
interface Prepared { version: 1; ownerKey: string; createdAt: string; kind: 'controlled-local-source-audit'; sourcePath: string; sourceHash: string;
  casesHash: string; workerHashes: Record<string, string>; modelStartLimit: 10 }
const casesText = JSON.stringify(fixtureCases, null, 2);
await mkdir(directory, { recursive: true });
let prepared: Prepared;
try { prepared = JSON.parse(await readFile(preparedPath, 'utf8')); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  prepared = { version: 1, ownerKey: randomUUID(), createdAt: new Date().toISOString(), kind: 'controlled-local-source-audit', sourcePath,
    sourceHash: digest(source), casesHash: digest(casesText), workerHashes, modelStartLimit: 10 };
  await writeFile(join(directory, 'source.mjs'), source, { flag: 'wx' });
  await writeFile(join(directory, 'cases.json'), casesText, { flag: 'wx' });
  await writeFile(preparedPath, JSON.stringify(prepared, null, 2), { flag: 'wx' });
}
assert.equal(prepared.version, 1); assert.equal(prepared.kind, 'controlled-local-source-audit');
assert.match(prepared.ownerKey, /^[a-f0-9-]{36}$/);
assert.equal(prepared.modelStartLimit, 10); assert.equal(prepared.sourceHash, digest(source));
assert.equal(prepared.casesHash, digest(casesText)); assert.deepEqual(prepared.workerHashes, workerHashes, 'Prepared worker source changed; review the change before rerunning');
assert.equal(digest(await readFile(join(directory, 'source.mjs'))), prepared.sourceHash);
assert.equal(digest(await readFile(join(directory, 'cases.json'))), prepared.casesHash);
if (!live) {
  console.log(JSON.stringify({ status: 'prepared', directory, kind: prepared.kind, sourceHash: prepared.sourceHash,
    actualModelStarts: 0, modelStartLimit: 10, stages: ['objective evaluation', 'automatic follow-up task', 'optional fixed-input skill comparison', 'objective reevaluation', 'memory reuse observation'],
    prerequisites: ['Standard worker build with a separate tag; verify worker file hashes in the image', 'Existing production operational budget remains enforced', 'Explicit --run --image=sha256:...'] }, null, 2));
  process.exit(0);
}
if (existsSync('.env')) loadEnvFile('.env');
const config = runtimeConfig();
assert.equal(config.mode, 'docker'); assert.equal(config.auth, 'codex'); assert.equal(config.persistentWorkspaces, true);
const imageFiles = workerFiles.filter(name => name !== 'Dockerfile');
const inspectCode = `const fs=require('node:fs'),crypto=require('node:crypto');const names=${JSON.stringify(imageFiles)};process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex')]))));`;
const imageArgs = ['run', '--rm', '--pull=never', '--name', `ac-objective-source-${prepared.ownerKey.slice(0, 12)}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image!, '-e', inspectCode];
const inspectedImage = await command(config.wslDistro ? 'wsl.exe' : 'docker', config.wslDistro ? ['--distribution', config.wslDistro, '--exec', 'docker', ...imageArgs] : imageArgs, { timeoutMs: 30_000 });
assert.equal(inspectedImage.code, 0, inspectedImage.stderr);
const copiedHashes = JSON.parse(inspectedImage.stdout);
assert.deepEqual(copiedHashes, Object.fromEntries(imageFiles.map(name => [name, workerHashes[name]])), 'The image must contain these exact worker source files');
await atomicJson(join(directory, 'image-verification.json'), { image, hashes: copiedHashes, verifiedAt: new Date().toISOString() });
const installationRoot = resolve(process.env.AGENT_DATA_DIR ?? '.data');
const installationOwner = (await readFile(join(installationRoot, 'workspace-id'), 'utf8')).trim();
assert.match(installationOwner, /^[a-f0-9-]{36}$/);
for (const name of ['identity.json', 'ledger.json']) assert.ok((await lstat(join(installationRoot, 'operational-budget', name))).isFile(), 'Existing operational ledger required; do not initialize one for verification');
const operationalBudget = await OperationalModelBudget.open({ directory: join(installationRoot, 'operational-budget'), ownerKey: installationOwner });
const campaign = await OperationVerificationCampaign.open(prepared.ownerKey, image!, { directory,
  anchorPath: join(directory, 'campaign.identity.json') });
const checkpoints = join(directory, 'checkpoints');
await mkdir(checkpoints, { recursive: true });
class ObservedRuntime extends ContainerRuntime {
  constructor(value: RuntimeConfig) { super(value); }
  override forkWorkspace(workspaceKey: string): ObservedRuntime { return new ObservedRuntime({ ...this.config, workspaceKey }); }
  override async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    await atomicJson(join(checkpoints, `${input.run.id}.input.json`), input);
    return super.execute(input, { ...hooks,
      onCheckpoint: async checkpoint => {
        await hooks.onCheckpoint?.(checkpoint);
        await atomicJson(join(checkpoints, `${input.run.id}.json`), checkpoint);
        if (Object.values(checkpoint.growthProgress ?? {}).some(value => value && typeof value === 'object' && 'trials' in value && Array.isArray(value.trials) && value.trials.length)) {
          await atomicJson(join(checkpoints, `${input.run.id}.trials.json`), checkpoint);
        }
      },
      onAttempt: async attempt => {
        await hooks.onAttempt?.(attempt);
        console.log(JSON.stringify({ type: 'attempt', runId: attempt.runId, phase: attempt.phase, kind: attempt.kind, status: attempt.status, id: attempt.id }));
      },
    });
  }
}
const runtime = new ObservedRuntime({ ...config, image: image!, browserImage: undefined, workspaceKey: prepared.ownerKey });
const runtimeInfo = await runtime.inspect();
assert.ok(runtimeInfo.available && runtimeInfo.authenticated, runtimeInfo.message);
interface Progress { agentId?: string; teamId?: string; sourceArtifactId?: string; casesArtifactId?: string; objectiveId?: string; reuseRunId?: string; completed?: boolean }
let progress: Progress;
try { progress = JSON.parse(await readFile(progressPath, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; progress = {}; }
const save = () => atomicJson(progressPath, progress);
const app = await createApp({ dataDir: join(directory, 'data', 'db'), runtime, operationalBudget,
  beforeModelStart: request => campaign.reserve(request), recovery: { maxAttempts: 1 },
  storage: { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: prepared.ownerKey } });
async function api<T>(url: string, payload?: unknown, method: 'GET' | 'POST' | 'PATCH' = payload === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  assert.ok(response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`); return response.json() as T;
}
const state = () => api<Workspace>('/api/workspace');
const report: Record<string, unknown> = { kind: prepared.kind, source: { path: sourcePath, sha256: prepared.sourceHash }, image, runtime: runtimeInfo,
  limitations: ['Controlled local source audit; no real Formnest efficacy verdict', 'Memory and candidate creation are observed, never forced', 'A local replay comparison does not demonstrate external service success'] };
async function waitUntil(label: string, predicate: (workspace: Workspace) => boolean): Promise<Workspace> {
  const deadline = Date.now() + 30 * 60_000; let lastLog = 0;
  while (Date.now() < deadline) {
    const workspace = await state();
    if (predicate(workspace)) return workspace;
    const own = workspace.runs.filter(run => run.agentId === progress.agentId);
    const stopped = own.find(run => ['failed', 'cancelled'].includes(run.status) || run.modelBudgetPaused || run.objectiveBlockedReason);
    if (stopped) throw new Error(`${label}: ${stopped.id} ${stopped.status}: ${stopped.error ?? stopped.objectiveBlockedReason ?? 'budget paused; state retained'}`);
    const objective = workspace.objectives?.find(item => item.id === progress.objectiveId);
    if (objective?.blockedReason) throw new Error(`${label}: ${objective.blockedReason}`);
    if (Date.now() - lastLog > 30_000) {
      console.log(JSON.stringify({ stage: label, runs: own.map(run => ({ id: run.id, kind: run.kind, status: run.status })), starts: (await campaign.status()).starts.length, limit: 10 }));
      lastLog = Date.now();
    }
    await delay(1000);
  }
  throw new Error(`${label}: observation timed out; state retained`);
}
try {
  let workspace = await state();
  const agent = workspace.agents.find(item => item.id === progress.agentId || item.name === 'Objective growth local audit') ?? await api<Agent>('/api/agents', {
    name: 'Objective growth local audit', model: config.model, allowWeb: false,
    persona: 'Verify local source behavior with actual Node commands. Preserve source provenance and observed evidence. Do not use external services, request peers, change environment, or expand objectives. Useful learned facts may be retained; skill candidates are optional. Propose at most one candidate per task within this bounded verification. Never claim improvement before independent comparison.',
  });
  progress.agentId = agent.id; await save();
  const team = workspace.teams.find(item => item.id === progress.teamId || item.name === 'Objective local audit team') ?? await api<Team>('/api/teams', {
    name: 'Objective local audit team', memberIds: [agent.id], autoDiscoverTasks: true,
    workflow: 'Claim relevant open tasks, read fixed shared artifacts, execute local verification, publish proof artifacts, and complete the claimed task with those artifact IDs. No new tasks or messages beyond the objective follow-up. Retain useful source facts only if actually learned.',
  });
  progress.teamId = team.id; await save();
  const scope = { type: 'team' as const, id: team.id };
  workspace = await state();
  for (const file of [{ key: 'sourceArtifactId' as const, name: 'fixture/growth.mjs', mediaType: 'text/javascript', content: source },
    { key: 'casesArtifactId' as const, name: 'fixture/cases.json', mediaType: 'application/json', content: casesText }]) {
    const artifact = workspace.sharedArtifacts?.find(item => item.id === progress[file.key] || item.scope.id === team.id && item.name === file.name)
      ?? await api<SharedArtifact>('/api/collaboration/artifact_publish', { scope, name: file.name, mediaType: file.mediaType, content: file.content });
    const stored = await api<SharedArtifact>('/api/collaboration/artifact_read', { artifactId: artifact.id, version: artifact.version });
    assert.equal(stored.content, file.content); progress[file.key] = artifact.id; await save();
  }
  workspace = await state();
  const objective = workspace.objectives?.find(item => item.id === progress.objectiveId || item.idempotencyKey === 'objective-growth-local-audit-v1') ?? await api<Objective>('/api/objectives', {
    idempotencyKey: 'objective-growth-local-audit-v1', teamId: team.id, scope, title: 'Verify fixed local quality-output behavior',
    purpose: `Verify qualityTask in fixture/growth.mjs (SHA-256 ${prepared.sourceHash}) against all three cases in fixture/cases.json. Copy the supplied source without edits into the local workspace, execute it with Node, and publish quality-proof.json to this team. Proof JSON must contain sourceHash, cases [{id,actual,passed}], command, and limitations. Print OBJECTIVE_GROWTH_PROOF:${prepared.sourceHash} and the proof JSON from the actual Node check. Keep a useful rule learned from this source in memory only if appropriate. A reusable skill and a fixed-input replay test may be proposed only if useful. Complete the generated task with the proof artifact ID.`,
    constraints: 'Local source audit only. No web, GitHub, PRs, messages, deployment or new environment. Do not alter fixture source, cases or expected results. Do not create more tasks. Scope is complete when the required proof exists; do not add requirements. Skill growth is optional and never a completion condition.',
    conditions: [{ id: 'proof', text: `A published quality-proof.json reports sourceHash=${prepared.sourceHash}, all three exact case IDs, actual outputs matching the fixed expected outputs and passed=true, with an actual local Node command and stated limits.`, requiresUserConfirmation: false }],
  });
  progress.objectiveId = objective.id; await save();
  workspace = await waitUntil('objective follow-up and completion', current => current.objectives?.some(item => item.id === objective.id && item.status === 'completed') === true
    && !current.runs.some(run => run.agentId === agent.id && ['queued', 'starting', 'running'].includes(run.status)));
  const tasks = (workspace.teamTasks ?? []).filter(task => task.objectiveId === objective.id);
  assert.ok(tasks.length > 0 && tasks.every(task => task.status === 'done'), 'The evaluator must generate actual linked tasks and they must finish');
  const proofArtifact = workspace.sharedArtifacts?.find(item => item.scope.id === team.id && basename(item.name) === 'quality-proof.json');
  assert.ok(proofArtifact, 'No shared proof artifact');
  const proof = JSON.parse(proofArtifact.content);
  assert.equal(proof.sourceHash, prepared.sourceHash);
  assert.equal(proof.cases.length, fixtureCases.length);
  for (const fixture of fixtureCases) {
    const actual = proof.cases.find((item: { id: string }) => item.id === fixture.id);
    assert.ok(actual, fixture.id); assert.equal(actual.passed, true); assert.deepEqual(actual.actual, fixture.expected);
  }
  const taskRunIds = new Set(tasks.flatMap(task => task.claimRunIds ?? (task.claimedRunId ? [task.claimedRunId] : [])));
  const observed = workspace.modelAttempts?.filter(attempt => taskRunIds.has(attempt.runId)).flatMap(attempt => attempt.observations)
    .find(observation => observation.exitCode === 0 && observation.command.includes('node') && observation.outputExcerpt.includes(`OBJECTIVE_GROWTH_PROOF:${prepared.sourceHash}`));
  assert.ok(observed, 'A successful observed Node check must include the fixed source marker');
  report.objective = workspace.objectives?.find(item => item.id === objective.id); report.tasks = tasks;
  report.evaluations = workspace.objectiveEvaluations?.filter(item => item.objectiveId === objective.id);
  report.proof = proof; report.observedCommand = observed;
  const learned = workspace.memories.filter(memory => memory.agentId === agent.id && memory.sourceRunId && taskRunIds.has(memory.sourceRunId));
  report.learnedMemories = learned;
  if (learned.length) {
    const prompt = 'Use a relevant memory learned in the prior local quality-output audit, if one applies. Apply it to a new case: qualityTask input has result="reuse", inputTokens=9, and one JSON artifact whose content is the literal string {"inputTokens":7}. Read retained source, execute qualityTask locally, and return memory-use.json as an artifact with memoryId, sourceRunId, rule, application, actual, and observed (boolean). Include the exact retained memory ID and original sourceRunId you actually used. If no memory applies, record null IDs and do not invent reuse. Do not publish to a team, propose skills or memory, use external services, or create tasks.';
    const reuse = workspace.runs.find(run => run.id === progress.reuseRunId || run.agentId === agent.id && run.prompt === prompt)
      ?? await api<Run>(`/api/agents/${agent.id}/runs`, { prompt, budgetTeamId: team.id, budgetProjectId: null });
    progress.reuseRunId = reuse.id; await save();
    workspace = await waitUntil('memory reuse observation', current => current.runs.some(run => run.id === reuse.id && run.status === 'succeeded')
      && !current.runs.some(run => run.agentId === agent.id && ['queued', 'starting', 'running'].includes(run.status)));
    const reuseResult = workspace.runs.find(run => run.id === reuse.id)!;
    const output = reuseResult.artifacts.find(artifact => artifact.name === 'memory-use.json');
    if (output) {
      const usage = JSON.parse(output.content), memory = learned.find(item => item.id === usage.memoryId && item.sourceRunId === usage.sourceRunId);
      const expected = { result: 'reuse', artifacts: [{ name: 'case.json', content: '{"inputTokens":7}', mediaType: 'application/json' }] };
      const actual = usage.actual;
      report.memoryReuse = { status: memory && usage.observed === true && actual?.result === expected.result
        && actual?.artifacts?.length === 1 && actual.artifacts[0]?.content === expected.artifacts[0].content && !('inputTokens' in actual) ? 'observed-with-model-report' : 'not-proven', output: usage };
    } else report.memoryReuse = { status: 'not-proven', reason: 'The worker did not return the requested memory reference artifact' };
  } else report.memoryReuse = { status: 'not-proven', reason: 'The completed task did not retain a relevant memory; no memory was injected by the verifier' };
  const finalObjective = workspace.objectives?.find(item => item.id === objective.id)!;
  assert.equal(finalObjective.status, 'completed');
  report.growth = { reviews: workspace.growthReviews?.filter(review => review.agentId === agent.id), revisions: workspace.skillRevisions?.filter(revision => revision.agentId === agent.id),
    activated: workspace.growthReviews?.some(review => review.agentId === agent.id && review.decision === 'activated') ?? false };
  report.status = 'completed'; progress.completed = true; await save();
} catch (error) {
  report.status = 'incomplete'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  report.progress = progress; report.modelBudget = await campaign.status();
  report.workspace = await state(); report.completedAt = new Date().toISOString();
  await atomicJson(join(directory, 'report.json'), report);
  await app.close();
  console.log(JSON.stringify({ directory, status: report.status, error: report.error, modelStarts: (report.modelBudget as { starts: unknown[] }).starts.length, limit: 10, memoryReuse: report.memoryReuse }));
}
