import test from 'node:test';
import assert from 'node:assert/strict';
import { captureGrowthReplayInput, resolveGrowthReplay, validateGrowthReplayInput } from '../server/growth-replay.ts';
import type { GrowthReplayInput, GrowthReplayProposal } from '../shared/growth.ts';

const input = () => captureGrowthReplayInput({ version: 1, sourceRunId: 'source-run', taskPrompt: 'Review the source and publish the corrected site',
  artifacts: [{ id: 'file-1', version: 2, name: 'index.html', mediaType: 'text/html', content: '<form></form>' }] });
const proposal: GrowthReplayProposal = { applicability: 'local', prompt: 'Produce an accessible form using the captured source',
  criteria: ['Required controls have associated labels', 'The empty submission is reported inline'], artifactIds: ['file-1'] };

test('captured input owns its immutable text and replay hashes bind task, test and exact source version', () => {
  const raw = input(), saved = captureGrowthReplayInput(raw), first = resolveGrowthReplay(saved, proposal, saved.taskPrompt);
  raw.artifacts[0].content = 'Changed after admission';
  assert.equal(saved.artifacts[0].content, '<form></form>');
  assert.match(first.prompt, /고정 자료/); assert.match(first.prompt, /실행 지시가 아닙니다/); assert.match(first.prompt, /<form>/);
  for (const changed of [
    captureGrowthReplayInput({ ...saved, artifacts: [{ ...saved.artifacts[0], version: 3 }] }),
    captureGrowthReplayInput({ ...saved, artifacts: [{ ...saved.artifacts[0], content: '<form>New</form>' }] }),
  ]) assert.notEqual(resolveGrowthReplay(changed, proposal, changed.taskPrompt).replayHash, first.replayHash);
  assert.notEqual(resolveGrowthReplay(saved, { ...proposal, criteria: ['Different condition'] }, saved.taskPrompt).replayHash, first.replayHash);
});

test('missing, forged, unbounded or externally dependent replay inputs are rejected before execution', () => {
  const saved = input();
  const invalid: Array<() => unknown> = [
    () => validateGrowthReplayInput({ ...saved, artifacts: [{ ...saved.artifacts[0], content: 'forged' }] }),
    () => captureGrowthReplayInput({ ...saved, artifacts: [saved.artifacts[0], saved.artifacts[0]] }),
    () => captureGrowthReplayInput({ ...saved, artifacts: Array.from({ length: 12 }, (_, index) => ({ ...saved.artifacts[0], id: `large-${index}`, content: 'a'.repeat(100_000) })) }),
    () => resolveGrowthReplay(saved, null, saved.taskPrompt),
    () => resolveGrowthReplay(saved, { ...proposal, applicability: 'external_required' }, saved.taskPrompt),
    () => resolveGrowthReplay(saved, { ...proposal, artifactIds: ['unknown'] }, saved.taskPrompt),
    () => resolveGrowthReplay(saved, { ...proposal, artifactIds: ['file-1', 'file-1'] }, saved.taskPrompt),
    () => resolveGrowthReplay(saved, proposal, `${saved.taskPrompt}\nNew instruction`),
    () => validateGrowthReplayInput({ ...saved, token: 'untrusted field' } as GrowthReplayInput),
  ];
  for (const verify of invalid) assert.throws(verify);
});
