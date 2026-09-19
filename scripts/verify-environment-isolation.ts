import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../server/process.ts';
import { workspaceVolume } from '../server/runtime.ts';
import { atomicJson } from '../server/storage.ts';
import { environmentCampaign, pinEnvironmentImage } from './environment-campaign.ts';
import type { EnvironmentRevision } from '../shared/environment.ts';

const campaign = await environmentCampaign(), { config } = await pinEnvironmentImage(campaign.config, campaign.manifest);
assert.equal(config.wslDistro, 'Ubuntu-22.04');
const saved = JSON.parse(await readFile(join(campaign.directory, 'report.json'), 'utf8'));
const revision = (saved.environmentRevisions as EnvironmentRevision[]).find(item => item.status === 'ready' && item.sourceRunId);
assert.ok(revision?.buildRunId && revision.report);
const name = `ac-env-isolation-${randomUUID().slice(0, 12)}`, volume = workspaceVolume(config, revision.buildRunId);
const docker = (args: string[], input?: string) => command('wsl.exe', ['--distribution', config.wslDistro!, '--exec', 'docker', ...args], { input, timeoutMs: 120_000 });
const inspected = await docker(['volume', 'inspect', volume, '--format', '{{json .Labels}}']); assert.equal(inspected.code, 0);
const labels = JSON.parse(inspected.stdout); assert.equal(labels.app, 'agent-company');
assert.equal(labels['agent-company.workspace'], config.workspaceKey); assert.equal(labels['agent-company.run'], revision.buildRunId);
const active = await docker(['ps', '-q', '--filter', `volume=${volume}`]); assert.equal(active.code, 0); assert.equal(active.stdout.trim(), '');
const args = ['run', '--rm', '-i', '--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${config.workspaceKey}`,
  '--label', 'agent-company.helper=isolation-verification', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
  '--user=1000:1000', '--pids-limit=64', '--memory=1024m', '--cpus=1', '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000',
  '--mount', `type=volume,source=${volume},target=/opt/agent-environment,readonly,volume-nocopy`,
  '--mount', 'type=bind,source=/mnt/c/dev/active/agent-company/scripts/check-environment-isolation.mjs,target=/app/check-isolation.mjs,readonly',
  '--entrypoint=node', config.image, '/app/check-isolation.mjs'];
try {
  const result = await docker(args, JSON.stringify({ spec: revision.spec, expected: revision.report }));
  assert.equal(result.code, 0, result.stderr);
  const report = { ...JSON.parse(result.stdout), imageId: config.image, buildRunId: revision.buildRunId, verifiedAt: new Date().toISOString() };
  await atomicJson(join(campaign.directory, 'isolation-verification.json'), report); console.log(JSON.stringify(report));
} finally {
  const removed = await docker(['rm', '-f', name]);
  assert.ok(removed.code === 0 || /No such container/i.test(removed.stderr), 'Owned isolation helper cleanup was not confirmed');
}
