import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { campaign } from './lifecycle-campaign.ts';
import { command } from '../server/process.ts';
import { workspaceVolume } from '../server/runtime.ts';
import { atomicJson } from '../server/storage.ts';

// Narrow verification diagnostic: extract only saved final JSON, never reasoning,
// authentication, or other agents' sessions. No model or writable volume mount.
const { directory, manifest, config } = await campaign();
const runId = 'ad98ca39-5fea-4019-8022-4cba4ecc27e4', workspaceKey = manifest.workspaces.growth;
const checkpoint = JSON.parse(await readFile(join(directory, 'growth', 'checkpoints', `${runId}.json`), 'utf8'));
const volume = workspaceVolume({ ...config, workspaceKey }, runId);
const docker = (args: string[]) => config.wslDistro
  ? command('wsl.exe', ['--distribution', config.wslDistro, '--exec', 'docker', ...args], { timeoutMs: 30_000 })
  : command('docker', args, { timeoutMs: 30_000 });
const inspected = await docker(['volume', 'inspect', volume, '--format', '{{json .Labels}}']);
assert.equal(inspected.code, 0, inspected.stderr);
const labels = JSON.parse(inspected.stdout);
assert.equal(labels.app, 'agent-company'); assert.equal(labels['agent-company.workspace'], workspaceKey); assert.equal(labels['agent-company.run'], runId);
const active = await docker(['ps', '-q', '--filter', `volume=${volume}`]); assert.equal(active.code, 0); assert.equal(active.stdout.trim(), '');
const program = `const fs=require('node:fs'),path=require('node:path'); const root='/workspace/.agent-runtime/sessions'; const finals=[];
for(const rel of fs.readdirSync(root,{recursive:true})){if(!rel.endsWith('.jsonl'))continue;const file=path.join(root,rel),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>16777216)throw Error('Invalid verification session');
for(const line of fs.readFileSync(file,'utf8').split('\\n')){let e;try{e=JSON.parse(line)}catch{continue}const p=e.payload;if(e.type!=='response_item'||p?.type!=='message'||p.role!=='assistant')continue;for(const c of p.content??[]){if(c.type!=='output_text')continue;let result;try{result=JSON.parse(c.text)}catch{continue}if(typeof result.result==='string'&&Array.isArray(result.skillConcerns))finals.push({sessionFile:rel,result:result.result,skillConcerns:result.skillConcerns});}}}process.stdout.write(JSON.stringify(finals));`;
const name = `ac-concern-inspect-${randomUUID()}`;
let response: Awaited<ReturnType<typeof docker>>;
try { response = await docker(['run', '--rm', '--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${workspaceKey}`,
  '--label', `agent-company.run=${runId}`, '--read-only', '--network=none', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
  '--memory=64m', '--cpus=0.25', '--pids-limit=64', '--mount', `type=volume,source=${volume},target=/workspace,readonly`, '--entrypoint=node', config.image, '-e', program]);
} finally {
  const remaining = await docker(['inspect', '--type=container', name, '--format', '{{json .Config.Labels}}']);
  if (remaining.code === 0) {
    const owned = JSON.parse(remaining.stdout);
    assert.equal(owned.app, 'agent-company'); assert.equal(owned['agent-company.workspace'], workspaceKey); assert.equal(owned['agent-company.run'], runId);
    const removed = await docker(['rm', '-f', name]); assert.equal(removed.code, 0, removed.stderr);
  } else assert.match(remaining.stderr, /No such (?:object|container)/i);
}
assert.equal(response.code, 0, response.stderr);
const finals = JSON.parse(response.stdout);
const report = { runId, finals, persistedConcerns: checkpoint.previousResult?.skillConcerns, modelCalls: 0 };
await atomicJson(join(directory, 'growth', 'concern-diagnostic.json'), report); console.log(JSON.stringify(report));
