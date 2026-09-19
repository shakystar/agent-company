import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperationVerificationCampaign } from '../server/verification-campaign.ts';

const image = `sha256:${'b'.repeat(64)}`;
async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-operation-campaign-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const protectedPath = join(directory, 'previous.json');
  await writeFile(protectedPath, '{"used":7}');
  const options = { directory: join(directory, 'campaign'), protectedPaths: [protectedPath], anchorPath: join(directory, 'campaign.identity.json') }, owner = randomUUID();
  const campaign = await OperationVerificationCampaign.open(owner, image, options);
  return { directory, protectedPath, options, owner, campaign };
}
test('campaign keeps 10 starts across reopening and rejects the eleventh', async t => {
  const { options, owner, campaign } = await setup(t);
  for (let index = 0; index < 10; index++) await campaign.reserve({ runId: randomUUID(), phase: 'task', kind: 'task', reason: 'test' });
  const reopened = await OperationVerificationCampaign.open(owner, image, options);
  await assert.rejects(reopened.reserve({ runId: randomUUID(), phase: 'repair', kind: 'repair', reason: 'test' }), /10회/);
  assert.equal((await reopened.status()).starts.length, 10);
});
test('campaign cannot silently replace owner, image, historical ledger or missing current ledger', async t => {
  const { options, owner, campaign, protectedPath } = await setup(t);
  await assert.rejects(OperationVerificationCampaign.open(randomUUID(), image, options), /소유권/);
  await assert.rejects(OperationVerificationCampaign.open(owner, `sha256:${'c'.repeat(64)}`, options), /이미지/);
  await writeFile(protectedPath, '{"used":8}');
  await assert.rejects(campaign.reserve({ runId: randomUUID(), phase: 'task', kind: 'task', reason: 'test' }), /이전 검증 장부/);
  assert.equal(JSON.parse(await readFile(join(options.directory, 'model-budget.json'), 'utf8')).starts.length, 0);
  await rm(join(options.directory, 'model-budget.json'));
  await assert.rejects(OperationVerificationCampaign.open(owner, image, options), /누락/);
  await rm(join(options.directory, 'manifest.json'));
  await assert.rejects(OperationVerificationCampaign.open(owner, image, options), /누락/);
});
