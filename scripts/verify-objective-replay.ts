import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { OperationVerificationCampaign } from '../server/verification-campaign.ts';
import { resolveGrowthReplay, validateGrowthReplayInput } from '../server/growth-replay.ts';
import { atomicJson } from '../server/storage.ts';
import { command } from '../server/process.ts';
import { BudgetPauseError, type ModelAttempt, type ModelStartRequest } from '../shared/telemetry.ts';
import type { BudgetAttribution } from '../shared/operational-budget.ts';
import type { ExecutionCheckpoint, ExecutionHooks, ExecutionInput, ExecutionResult, Skill, Workspace } from '../shared/types.ts';
import type { GrowthReplayProposal } from '../shared/growth.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => digest(JSON.stringify(value));
const stages = new Map([['baseline-trial', 'trial'], ['candidate-trial', 'trial'], ['comparison-judge', 'evaluate']]);
type Campaign = Pick<OperationVerificationCampaign, 'status' | 'reserve'>;
type OperatingGate = Pick<OperationalModelBudget, 'reserve'>;

/** Keep the normal operating reservation outermost, exactly as AgentService does.
 * The same campaign ledger bounds this stable diagnostic Run to three starts across retries.
 */
export function replayDiagnosticGate(operating: OperatingGate, campaign: Campaign, runId: string, attribution: BudgetAttribution) {
  return async (request: ModelStartRequest) => {
    assert.equal(request.runId, runId, 'Diagnostic cannot bill another Run');
    assert.equal(stages.get(request.kind), request.phase, 'Only the two trials and their judge are permitted');
    await operating.reserve(request, attribution, async () => {
      const ledger = await campaign.status();
      if (ledger.starts.filter(entry => entry.runId === runId).length >= 3) throw new BudgetPauseError('이 별도 재검사 진단의 추가 3회 시작 한도를 사용했습니다. 원장과 진행 상태를 보존했습니다.');
      await campaign.reserve(request);
    });
  };
}

export function replayDiagnosticInput(source: ExecutionInput, options: { runId: string; skillId: string; createdAt: string; sourceContentHash: string }): ExecutionInput {
  const captured = validateGrowthReplayInput(source.growthReplay);
  assert.equal(captured.sourceRunId, source.run.id); assert.equal(captured.taskPrompt, source.run.prompt);
  assert.equal(source.run.steering.length, 0, 'This fixed diagnostic refers to the unsteered completed source task');
  const sourceArtifact = captured.artifacts.find(item => item.name === 'fixture/growth.mjs');
  const cases = captured.artifacts.find(item => item.name === 'fixture/cases.json');
  assert.ok(sourceArtifact && cases); assert.equal(digest(sourceArtifact.content), options.sourceContentHash);
  const replay: GrowthReplayProposal = {
    applicability: 'local', artifactIds: [sourceArtifact.id, cases.id],
    prompt: `Using only these two captured artifacts in a fresh workspace, write their exact UTF-8 contents to local files and execute qualityTask with Node for all three fixed cases. Compute the raw source-file SHA-256, expected ${options.sourceContentHash}. Return replay-proof.json with sourceContentHash, cases [{id,actual,passed}], command, and limitations. Do not publish, claim tasks, send messages, fetch a repository or reconstruct external state.`,
    criteria: [
      `The source UTF-8 bytes retain the exact content hash ${options.sourceContentHash}; input and expected cases are unchanged.`,
      'The actual Node outputs for cost-metadata, artifact-metadata and missing-artifacts match the fixed expectations and failures are reported honestly.',
      'The captured-input aggregate sourceHash is not treated as the hash of a single source file. No unobserved cause of a mismatch is invented.',
      'The result includes local execution evidence and limits without claiming that an external publication or collaboration occurred.',
    ],
  };
  const candidate: Skill = {
    id: options.skillId, agentId: source.agent.id, name: 'Verifier fixture: raw source verification',
    description: 'Verifier-written diagnostic candidate; not agent-generated, approved, or active in the product.',
    content: 'When verifying fixed source inputs, distinguish a controller hash of the entire input object from the SHA-256 of one artifact’s exact UTF-8 bytes. Preserve the supplied source and expected cases without edits. Compute the file hash independently, execute the actual exported function for each fixed case, and compare the full output. If evidence is missing or mismatched, report that limit without inventing a byte-transformation cause. Do not replay external publishing, task-board, or messaging actions.',
    version: 1, status: 'candidate', evaluation: 'Verifier fixture awaiting a real independent comparison; no quality outcome is prescribed.',
    sourceRunId: source.run.id, createdAt: options.createdAt, updatedAt: options.createdAt,
  };
  return { ...structuredClone(source), connections: [], collaboration: undefined, repositoryTransport: undefined, environment: undefined,
    environmentBuild: undefined, objectiveEvaluation: undefined, previousResult: undefined, checkpoint: undefined,
    agent: { ...source.agent, allowWeb: false, repositoryIds: [] },
    run: { ...source.run, id: options.runId, kind: 'review', prompt: 'Verifier-owned fixed-input replay diagnostic', status: 'running',
      result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: options.createdAt,
      startedAt: options.createdAt, completedAt: null, workspaceSourceRunId: null, objectiveId: undefined, objectiveEvaluationId: undefined,
      objectiveBlockedReason: undefined, objectivePaused: undefined, taskDiscovery: undefined, teamTaskId: undefined,
      conversationId: undefined, conversationMessageId: undefined, messageIds: undefined, interactionMode: 'task' },
    growth: { mode: 'review', skillId: candidate.id, baseline: null, candidate, originalPrompt: captured.taskPrompt, sourceRunId: source.run.id, replay },
  };
}

export function replayDiagnosticOutcome(input: ExecutionInput, result: ExecutionResult | undefined, attempts: ModelAttempt[], cleanupConfirmed: boolean) {
  const comparison = result?.growthReview;
  const resolved = resolveGrowthReplay(input.growthReplay!, input.growth!.replay, input.growth!.originalPrompt);
  const expectedInputHash = hash({ prompt: resolved.prompt, persona: input.agent.persona,
    memories: input.memories.map(({ kind, title, content }) => ({ kind, title, content })),
    commonSkills: input.skills.filter(skill => skill.status === 'active' && skill.name !== input.growth!.candidate.name)
      .map(({ name, description, content }) => ({ name, description, content })), sourceRunId: null, replayHash: resolved.replayHash });
  const selected = comparison ? [comparison.baseline.attemptId, comparison.candidate.attemptId, comparison.judgeAttemptId]
    .map(id => attempts.find(attempt => attempt.id === id && attempt.runId === input.run.id)) : [];
  const allStagesCompleted = selected.length === 3 && selected.every((attempt, index) => attempt?.status === 'succeeded'
    && attempt.kind === [...stages.keys()][index] && attempt.phase === [...stages.values()][index]);
  const fingerprintMatched = Boolean(comparison && comparison.fingerprint.replayHash === resolved.replayHash
    && comparison.fingerprint.promptHash === hash(resolved.prompt) && comparison.fingerprint.inputHash === expectedInputHash
    && comparison.fingerprint.baselineSkillHash === null && comparison.fingerprint.candidateSkillHash === hash({
      name: input.growth!.candidate.name, description: input.growth!.candidate.description, content: input.growth!.candidate.content }));
  return { pathStatus: allStagesCompleted && fingerprintMatched && cleanupConfirmed ? 'completed' : 'incomplete',
    allStagesCompleted, fingerprintMatched, cleanupConfirmed, verdict: comparison?.verdict ?? null,
    independentlyApplicable: comparison?.replayApplicable === true, verifiedComparison: comparison?.verified === true,
    qualityImprovement: comparison?.verified && comparison.verdict === 'improved' ? 'observed-only-for-this-verifier-candidate-and-input' : 'not-demonstrated',
    autonomousGrowthProven: false, candidateOrigin: 'verifier-written-test-fixture', activatedProductSkills: 0,
    reason: comparison?.reason ?? 'No completed comparison result' };
}

async function existingJson<T>(path: string): Promise<T> {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 32 * 1024 * 1024, 'Expected a bounded independent existing JSON file');
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
async function preserve(path: string, value: string) {
  try { await writeFile(path, value, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), value, `Existing diagnostic evidence changed: ${path}`); }
}
async function databaseFingerprint(root: string): Promise<string> {
  const entries: Array<{ path: string; sha256: string }> = [];
  const visit = async (path: string, relative: string): Promise<void> => {
    const stat = await lstat(path); assert.ok(!stat.isSymbolicLink(), 'Original database cannot be a symbolic link');
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? `${relative}/${name}` : name);
    else { assert.ok(stat.isFile() && stat.size <= 128 * 1024 * 1024, 'Expected bounded ordinary database files'); entries.push({ path: relative, sha256: digest(await readFile(path)) }); }
  };
  await visit(root, ''); return hash(entries);
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 2 && args.every(arg => ['--prepare', '--run'].includes(arg) || arg.startsWith('--image=')), 'Usage: --prepare | --run [--image=sha256:...]');
  assert.ok(!(args.includes('--run') && args.includes('--prepare')));
  const live = args.includes('--run'), directory = resolve('.verification/objective-growth-20260911'), diagnosticDir = join(directory, 'replay-diagnostic');
  const sourceRunId = 'adbd8f0c-8f14-42b2-808a-824413f9fe5e';
  const prepared = await existingJson<{ ownerKey: string; sourceHash: string; workerHashes: Record<string, string>; modelStartLimit: number }>(join(directory, 'prepared.json'));
  const campaignManifest = await existingJson<{ ownerKey: string; imageId: string; limit: number }>(join(directory, 'manifest.json'));
  const originalReport = await existingJson<{ status: string; workspace: Workspace }>(join(directory, 'report.json'));
  assert.equal(originalReport.status, 'completed'); assert.equal(campaignManifest.ownerKey, prepared.ownerKey);
  assert.equal(campaignManifest.limit, 10); assert.equal(prepared.modelStartLimit, 10);
  assert.match(campaignManifest.imageId, /^sha256:[a-f0-9]{64}$/);
  const requestedImage = args.find(arg => arg.startsWith('--image='))?.slice('--image='.length);
  if (requestedImage) assert.equal(requestedImage, campaignManifest.imageId, 'This diagnostic cannot replace the existing campaign image');
  const sourceBytes = await readFile(join(directory, 'checkpoints', `${sourceRunId}.input.json`), 'utf8');
  const source: ExecutionInput = JSON.parse(sourceBytes);
  const completedSource = originalReport.workspace.runs.find(run => run.id === sourceRunId);
  assert.ok(completedSource?.status === 'succeeded'); assert.equal(completedSource.agentId, source.agent.id);
  assert.ok(!originalReport.workspace.runs.some(run => ['queued', 'starting', 'running'].includes(run.status)), 'Original campaign must be settled');
  const originalHashes = Object.fromEntries(await Promise.all(['prepared.json', 'manifest.json', 'campaign.identity.json', 'report.json', 'source.mjs', 'cases.json']
    .map(async name => [name, digest(await readFile(join(directory, name)))])));
  const controllerFiles = ['server/runtime.ts', 'server/growth-replay.ts', 'shared/growth.ts', 'scripts/verify-objective-replay.ts'];
  const controllerHashes = Object.fromEntries(await Promise.all(controllerFiles.map(async name => [name, digest(await readFile(resolve(name)))])));
  await mkdir(diagnosticDir, { recursive: true });
  const release = await lockfile.lock(diagnosticDir, { retries: 0 });
  try {
    const manifestPath = join(diagnosticDir, 'manifest.json');
    let manifest: { version: 1; runId: string; skillId: string; createdAt: string; ownerKey: string; image: string; sourceRunId: string;
      sourceInputHash: string; originalHashes: Record<string, string>; controllerHashes: Record<string, string>; additionalStartLimit: 3; candidateOrigin: string };
    try { manifest = await existingJson(manifestPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const ledger = await existingJson<{ starts: ModelStartRequest[]; limit: number }>(join(directory, 'model-budget.json'));
      assert.ok(ledger.limit === 10 && ledger.starts.length <= 7, 'The same existing campaign must have room for three diagnostic stages');
      manifest = { version: 1, runId: randomUUID(), skillId: randomUUID(), createdAt: new Date().toISOString(), ownerKey: prepared.ownerKey,
        image: campaignManifest.imageId, sourceRunId, sourceInputHash: digest(sourceBytes), originalHashes, controllerHashes,
        additionalStartLimit: 3, candidateOrigin: 'verifier-written-test-fixture' };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    }
    assert.equal(manifest.version, 1); assert.equal(manifest.additionalStartLimit, 3); assert.equal(manifest.candidateOrigin, 'verifier-written-test-fixture');
    assert.equal(manifest.ownerKey, prepared.ownerKey); assert.equal(manifest.image, campaignManifest.imageId); assert.equal(manifest.sourceRunId, sourceRunId);
    assert.equal(manifest.sourceInputHash, digest(sourceBytes)); assert.deepEqual(manifest.originalHashes, originalHashes); assert.deepEqual(manifest.controllerHashes, controllerHashes);
    const input = replayDiagnosticInput(source, { ...manifest, sourceContentHash: prepared.sourceHash });
    await preserve(join(diagnosticDir, 'source-input.json'), sourceBytes);
    await preserve(join(diagnosticDir, 'input.json'), JSON.stringify(input, null, 2));
    await preserve(join(diagnosticDir, 'candidate.json'), JSON.stringify({ origin: manifest.candidateOrigin, baseline: null, candidate: input.growth!.candidate, replay: input.growth!.replay }, null, 2));
    if (!live) {
      console.log(JSON.stringify({ status: 'prepared', diagnosticDir, runId: manifest.runId, image: manifest.image, sourceRunId, additionalStartLimit: 3,
        actualModelStarts: 0, candidateOrigin: manifest.candidateOrigin, productDatabaseOpened: false, productSkillsChanged: 0 }, null, 2)); return;
    }
    if (existsSync(join(diagnosticDir, 'result.json')) && existsSync(join(diagnosticDir, 'report.json'))
      && (await existingJson<{ cleanupConfirmed: boolean }>(join(diagnosticDir, 'report.json'))).cleanupConfirmed) {
      console.log(JSON.stringify({ status: 'already-recorded', report: join(diagnosticDir, 'report.json'), actualNewModelStarts: 0 })); return;
    }
    if (existsSync('.env')) loadEnvFile('.env');
    const config = runtimeConfig(); assert.equal(config.mode, 'docker'); assert.equal(config.auth, 'codex'); assert.equal(config.persistentWorkspaces, true);
    const docker = (dockerArgs: string[]) => command(config.wslDistro ? 'wsl.exe' : 'docker', config.wslDistro ? ['--distribution', config.wslDistro, '--exec', 'docker', ...dockerArgs] : dockerArgs, { timeoutMs: 30_000 });
    const active = await docker(['ps', '-aq', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${manifest.ownerKey}`]);
    assert.equal(active.code, 0); assert.equal(active.stdout.trim(), '', 'Do not recover or interrupt a live original campaign worker');
    const names = Object.keys(prepared.workerHashes).filter(name => name !== 'Dockerfile');
    assert.ok(names.length > 0 && names.every(name => /^[a-z0-9.-]+$/.test(name)));
    const inspectCode = `const f=require('node:fs'),c=require('node:crypto');process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(n=>[n,c.createHash('sha256').update(f.readFileSync('/app/'+n)).digest('hex')]))));`;
    const imageProof = await docker(['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--entrypoint', 'node', manifest.image, '-e', inspectCode]);
    assert.equal(imageProof.code, 0, imageProof.stderr);
    assert.deepEqual(JSON.parse(imageProof.stdout), Object.fromEntries(names.map(name => [name, prepared.workerHashes[name]])));
    await atomicJson(join(diagnosticDir, 'image-proof.json'), { image: manifest.image, copiedWorkerHashes: JSON.parse(imageProof.stdout), verifiedAt: new Date().toISOString() });
    const installation = resolve(process.env.AGENT_DATA_DIR ?? '.data'), installationOwner = (await readFile(join(installation, 'workspace-id'), 'utf8')).trim();
    for (const name of ['identity.json', 'ledger.json']) await existingJson(join(installation, 'operational-budget', name));
    const operating = await OperationalModelBudget.open({ directory: join(installation, 'operational-budget'), ownerKey: installationOwner });
    const campaign = await OperationVerificationCampaign.open(manifest.ownerKey, manifest.image, { directory, anchorPath: join(directory, 'campaign.identity.json') });
    const attribution: BudgetAttribution = { rootRunId: completedSource.budgetRootRunId ?? completedSource.id,
      projectId: completedSource.budgetProjectId ?? null, teamId: completedSource.budgetTeamId ?? null, agentId: completedSource.agentId };
    const before = await campaign.status();
    const databaseBefore = await databaseFingerprint(join(directory, 'data', 'db'));
    const runtime = new ContainerRuntime({ ...config, image: manifest.image, browserImage: undefined, workspaceKey: manifest.ownerKey });
    let checkpoint: ExecutionCheckpoint | undefined;
    if (existsSync(join(diagnosticDir, 'checkpoint.json'))) checkpoint = await existingJson(join(diagnosticDir, 'checkpoint.json'));
    const attempts = new Map<string, ModelAttempt>();
    if (existsSync(join(diagnosticDir, 'attempts.json'))) for (const attempt of await existingJson<ModelAttempt[]>(join(diagnosticDir, 'attempts.json'))) attempts.set(attempt.id, attempt);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Diagnostic observer stopped; preserve progress'));
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    const hooks: ExecutionHooks = { signal: controller.signal, getSteering: async () => [],
      onEvent: async message => { console.log(JSON.stringify({ type: 'event', message })); },
      beforeModelStart: replayDiagnosticGate(operating, campaign, manifest.runId, attribution),
      onAttempt: async attempt => {
        attempts.set(attempt.id, structuredClone(attempt));
        await appendFile(join(diagnosticDir, 'attempt-events.jsonl'), `${JSON.stringify(attempt)}\n`);
        await atomicJson(join(diagnosticDir, 'attempts.json'), [...attempts.values()]);
        console.log(JSON.stringify({ type: 'attempt', id: attempt.id, phase: attempt.phase, kind: attempt.kind, status: attempt.status }));
      },
      onCheckpoint: async value => {
        checkpoint = structuredClone(value);
        await appendFile(join(diagnosticDir, 'checkpoint-events.jsonl'), `${JSON.stringify(value)}\n`);
        await atomicJson(join(diagnosticDir, 'checkpoint.json'), value);
        if (Object.values(value.growthProgress ?? {}).some(item => item && typeof item === 'object' && 'trials' in item && Array.isArray(item.trials) && item.trials.length)) {
          await atomicJson(join(diagnosticDir, 'trials.json'), value);
        }
      },
    };
    let result: ExecutionResult | undefined, error: string | undefined, cleanupConfirmed = false;
    try {
      if (existsSync(join(diagnosticDir, 'result.json'))) result = await existingJson(join(diagnosticDir, 'result.json'));
      else if (checkpoint?.phase === 'complete') result = checkpoint.previousResult;
      else result = await runtime.execute({ ...input, checkpoint }, hooks);
      if (result) await atomicJson(join(diagnosticDir, 'result.json'), result);
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally {
      try {
        await runtime.settle(manifest.runId);
        const remaining = await docker(['volume', 'ls', '-q', '--filter', `label=agent-company.workspace=${manifest.ownerKey}`, '--filter', `label=agent-company.temporary-for=${manifest.runId}`]);
        const workers = await docker(['ps', '-aq', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${manifest.ownerKey}`]);
        cleanupConfirmed = remaining.code === 0 && remaining.stdout.trim() === '' && workers.code === 0 && workers.stdout.trim() === '';
      } catch (failure) { error ??= failure instanceof Error ? failure.message : String(failure); }
      process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
      const after = await campaign.status(), databaseAfter = await databaseFingerprint(join(directory, 'data', 'db'));
      const outcome = replayDiagnosticOutcome(input, result, [...attempts.values()], cleanupConfirmed);
      const report = { ...outcome, error, image: manifest.image, sourceRunId, diagnosticRunId: manifest.runId, sourceInputHash: manifest.sourceInputHash,
        originalRunUnchanged: databaseBefore === databaseAfter, originalCampaignDatabaseUnchanged: databaseBefore === databaseAfter,
        databaseBefore, databaseAfter, productDatabaseOpened: false, attribution, startsBefore: before.starts.length, startsAfter: after.starts.length,
        diagnosticStarts: after.starts.filter(start => start.runId === manifest.runId), campaignLimit: 10, additionalStartLimit: 3,
        comparison: result?.growthReview, attempts: [...attempts.values()], controllerHashes, completedAt: new Date().toISOString() };
      for (const [name, expected] of Object.entries(originalHashes)) assert.equal(digest(await readFile(join(directory, name))), expected, `Original evidence changed: ${name}`);
      await atomicJson(join(diagnosticDir, 'report.json'), report);
      console.log(JSON.stringify({ diagnosticDir, ...outcome, error, starts: report.diagnosticStarts.length, campaignStarts: after.starts.length }));
      if (outcome.pathStatus !== 'completed' || databaseBefore !== databaseAfter) process.exitCode = 1;
    }
  } finally { await release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
