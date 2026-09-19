import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DockerWorkspaces, validateWorkspacePath } from '../server/workspaces.ts';
import { command as executeCommand, type Command, type CommandOptions } from '../server/process.ts';

const modulePath = new URL('../worker/workspace.mjs', import.meta.url).href;
const { prepareWorkspace, readWorkspace, listWorkspace, workspaceMarker } = await import(modulePath);
const config = { mode: 'docker' as const, image: 'test-worker', workspaceKey: 'test-workspace', persistentWorkspaces: true };
const volumeFor = (id: string) => `ac-${createHash('sha256').update(config.workspaceKey).digest('hex').slice(0, 16)}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const marker = (runId = 'run-b', sourceRunId: string | null = 'run-a', reused = false) => ({ version: 1, state: 'ready', runId, sourceRunId, files: 0, bytes: 0, reused });

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-company-workspaces-'));
  const source = join(root, 'source'), target = join(root, 'target');
  await mkdir(source);
  await mkdir(target);
  t.after(async () => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(`${resolve(tmpdir())}${sep}agent-company-workspaces-`));
    await rm(absolute, { recursive: true, force: true });
  });
  return { root, source, target };
}

function harness() {
  const calls: { args: string[]; options: CommandOptions }[] = [];
  const volumes = new Map<string, Record<string, string>>();
  const active = new Set<string>();
  let response: unknown = marker();
  let cleanupFails = false;
  const own = (id: string) => volumes.set(volumeFor(id), { app: 'agent-company', 'agent-company.workspace': config.workspaceKey, 'agent-company.run': id });
  const command: Command = async (_file, args, options = {}) => {
    calls.push({ args, options });
    const ok = (value = '') => ({ code: 0, stdout: value, stderr: '' });
    if (args[0] === 'volume' && args[1] === 'inspect') return volumes.has(args[2]) ? ok(JSON.stringify(volumes.get(args[2]))) : { code: 1, stdout: '', stderr: `Error: No such volume: ${args[2]}` };
    if (args[0] === 'volume' && args[1] === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((arg, index) => {
        if (arg === '--label') {
          const [key, ...value] = args[index + 1].split('=');
          labels[key] = value.join('=');
        }
      });
      volumes.set(args.at(-1)!, labels);
      return ok(args.at(-1));
    }
    if (args[0] === 'ps') return ok(active.has(args.at(-1)!.slice('volume='.length)) ? 'active-container' : '');
    if (args[0] === 'run') return ok(JSON.stringify(response));
    if (args[0] === 'rm') return cleanupFails ? { code: 1, stdout: '', stderr: 'engine unavailable' } : ok();
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { calls, volumes, active, command, own, response: (value: unknown) => { response = value; }, failCleanup: () => { cleanupFails = true; } };
}

test('personal files inherit independently, excluding injected memory, skills, sessions and known authentication paths', async t => {
  const { source, target } = await fixture(t);
  await mkdir(join(source, 'project'));
  await writeFile(join(source, 'project', 'result.txt'), 'original');
  await writeFile(join(source, 'project', 'AGENTS.md'), 'project-owned instructions');
  for (const path of ['.agent', '.agents', '.agent-runtime', '.codex']) {
    await mkdir(join(source, path));
    await writeFile(join(source, path, 'private.txt'), 'not inherited');
  }
  await writeFile(join(source, 'AGENTS.md'), 'injected persona');
  await writeFile(join(source, workspaceMarker), JSON.stringify(marker('run-a', null)));
  const prepared = await prepareWorkspace(target, source, { runId: 'run-b', sourceRunId: 'run-a' });
  assert.equal(prepared.reused, false);
  assert.deepEqual((await readdir(target)).sort(), [workspaceMarker, 'project'].sort());
  assert.equal(await readFile(join(target, 'project', 'AGENTS.md'), 'utf8'), 'project-owned instructions');
  await writeFile(join(target, 'project', 'result.txt'), 'forked');
  await mkdir(join(target, '.agent-runtime'));
  await writeFile(join(target, '.agent-runtime', 'checkpoint'), 'same-run session');
  assert.equal(await readFile(join(source, 'project', 'result.txt'), 'utf8'), 'original');
  assert.equal((await prepareWorkspace(target, source, { runId: 'run-b', sourceRunId: 'run-a' })).reused, true);
  assert.equal(await readFile(join(target, 'project', 'result.txt'), 'utf8'), 'forked');
  assert.equal(await readFile(join(target, '.agent-runtime', 'checkpoint'), 'utf8'), 'same-run session');
});

test('blank workspace initialization is repeatable and rejects mismatched identity', async t => {
  const { target } = await fixture(t);
  assert.equal((await prepareWorkspace(target, null, { runId: 'run-a', sourceRunId: null })).files, 0);
  assert.equal((await prepareWorkspace(target, null, { runId: 'run-a', sourceRunId: null })).reused, true);
  await assert.rejects(prepareWorkspace(target, null, { runId: 'run-b', sourceRunId: null }), /일치하지/);
});

test('interrupted initialization never becomes success and never overwrites existing files', async t => {
  const { source, target } = await fixture(t);
  await writeFile(join(target, '.agent-workspace.pending'), JSON.stringify({ state: 'copying' }));
  await writeFile(join(target, 'result.txt'), 'partially copied');
  await assert.rejects(prepareWorkspace(target, source, { runId: 'run-b', sourceRunId: 'run-a' }), /초기화가 끝나지/);
  assert.equal(await readFile(join(target, 'result.txt'), 'utf8'), 'partially copied');
  await assert.rejects(readFile(join(target, workspaceMarker)), { code: 'ENOENT' });
});

test('workspace list hides injected files and text reads enforce UTF-8 byte limits and reject binary', async t => {
  const { source } = await fixture(t);
  await writeFile(join(source, 'korean.txt'), '가나다');
  await writeFile(join(source, 'binary.dat'), Buffer.from([0, 1, 2]));
  await writeFile(join(source, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  await writeFile(join(source, 'AGENTS.md'), 'private');
  assert.deepEqual(await readWorkspace(source, 'korean.txt', 9), { path: 'korean.txt', text: '가나다', bytes: 9 });
  await assert.rejects(readWorkspace(source, 'korean.txt', 8), /조회 한도/);
  await assert.rejects(readWorkspace(source, 'binary.dat'), /바이너리/);
  await assert.rejects(readWorkspace(source, 'invalid.txt'));
  const list = await listWorkspace(source, '', 2);
  assert.equal(list.entries.length, 2);
  assert.equal(list.truncated, true);
  assert.equal(list.entries.some((entry: { name: string }) => entry.name === 'AGENTS.md'), false);
});

test('paths cannot escape the workspace or reveal private runtime data on either host', async t => {
  const { source } = await fixture(t);
  for (const path of ['/etc/passwd', '../private', 'project/../../private', 'C:/auth.json', 'project\\secret', 'a//b', 'a/./b', '\u0000', '.agent-runtime/sessions/a', '.codex/auth.json', '.agent/memory.json', 'AGENTS.md']) {
    assert.throws(() => validateWorkspacePath(path));
    await assert.rejects(readWorkspace(source, path));
  }
  assert.equal(validateWorkspacePath('project/AGENTS.md'), 'project/AGENTS.md');
});

test('relative internal symlinks are copied, reads do not follow them, and external links fail closed', async t => {
  const { root, source, target } = await fixture(t);
  await writeFile(join(source, 'data.txt'), 'safe');
  try { await symlink('data.txt', join(source, 'internal.txt')); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows symbolic-link creation requires a host privilege; Linux Docker verification is separate'); return; }
    throw error;
  }
  await prepareWorkspace(target, source, { runId: 'run-b', sourceRunId: 'run-a' });
  assert.equal(await readFile(join(target, 'internal.txt'), 'utf8'), 'safe');
  await assert.rejects(readWorkspace(target, 'internal.txt'), /심볼릭 링크/);
  const second = join(root, 'second');
  await mkdir(second);
  await symlink('../outside.txt', join(source, 'escape.txt'));
  await assert.rejects(prepareWorkspace(second, source, { runId: 'run-c', sourceRunId: 'run-a' }), /바깥/);
  assert.deepEqual(await readdir(second), []);
});

test('server checks source ownership and creates a correctly labelled target before copying through readonly source mount', async () => {
  const h = harness();
  h.own('run-a');
  const result = await new DockerWorkspaces(config, h.command, volumeFor).prepare('run-b', 'run-a');
  assert.equal(result.runId, 'run-b');
  const run = h.calls.find(call => call.args[0] === 'run')!;
  assert.ok(run.args.includes(`type=volume,source=${volumeFor('run-a')},target=/source,readonly,volume-nocopy`));
  assert.ok(run.args.includes(`type=volume,source=${volumeFor('run-b')},target=/workspace`));
  assert.ok(run.args.includes('--network=none'));
  assert.ok(run.args.includes('--user=1000:1000'));
  assert.ok(run.args.includes('--cap-drop=ALL'));
  assert.ok(!run.args.some(arg => /auth|docker.sock|privileged|unconfined/.test(arg)));
  assert.deepEqual(JSON.parse(run.options.input!), { operation: 'prepare', runId: 'run-b', sourceRunId: 'run-a' });
  assert.deepEqual(h.calls.at(-1)!.args, ['rm', '-f', run.args[run.args.indexOf('--name') + 1]]);
});

test('foreign workspace, run ownership and malformed names fail without creating or mounting volumes', async () => {
  for (const badLabels of [{ app: 'someone-else' }, { 'agent-company.workspace': 'other' }, { 'agent-company.run': 'run-z' }]) {
    const h = harness();
    h.own('run-a');
    Object.assign(h.volumes.get(volumeFor('run-a'))!, badLabels);
    await assert.rejects(new DockerWorkspaces(config, h.command, volumeFor).prepare('run-b', 'run-a'), /소유권/);
    assert.equal(h.calls.some(call => ['run', 'create'].some(arg => call.args.includes(arg))), false);
  }
  const h = harness();
  await assert.rejects(new DockerWorkspaces(config, h.command, () => '/host/path').prepare('run-b'), /named volume/);
  await assert.rejects(new DockerWorkspaces(config, h.command, volumeFor).prepare('../run-a'), /실행 ID/);
  assert.equal(h.calls.length, 0);
});

test('missing source and active source are not silently converted into a blank workspace', async () => {
  const h = harness();
  const manager = new DockerWorkspaces(config, h.command, volumeFor);
  await assert.rejects(manager.prepare('run-b', 'run-a'), /볼륨을 확인하지/);
  h.own('run-a');
  h.active.add(volumeFor('run-a'));
  await assert.rejects(manager.prepare('run-b', 'run-a'), /실행 중/);
  assert.equal(h.calls.some(call => call.args.includes('create') || call.args[0] === 'run'), false);
});

test('existing target ownership is checked and never overwritten by volume create', async () => {
  const h = harness();
  h.own('run-a');
  h.own('run-b');
  h.volumes.get(volumeFor('run-b'))!['agent-company.run'] = 'other-run';
  await assert.rejects(new DockerWorkspaces(config, h.command, volumeFor).prepare('run-b', 'run-a'), /소유권/);
  assert.equal(h.calls.some(call => call.args.includes('create') || call.args[0] === 'run'), false);
});

test('read-only list and read bind only the owned volume and never create a missing one', async () => {
  const h = harness();
  h.own('run-a');
  const manager = new DockerWorkspaces(config, h.command, volumeFor);
  h.response({ path: '', entries: [], truncated: false });
  assert.deepEqual(await manager.list('run-a'), { path: '', entries: [], truncated: false });
  h.response({ path: 'result.txt', text: 'ok', bytes: 2 });
  assert.deepEqual(await manager.read('run-a', 'result.txt'), { path: 'result.txt', text: 'ok', bytes: 2 });
  const runs = h.calls.filter(call => call.args[0] === 'run');
  assert.ok(runs.every(call => call.args.includes(`type=volume,source=${volumeFor('run-a')},target=/workspace,readonly,volume-nocopy`)));
  await assert.rejects(manager.list('run-z'), /볼륨을 확인하지/);
  assert.equal(h.calls.some(call => call.args.includes('create')), false);
});

test('invalid read paths and size limits cause no Docker operations', async () => {
  const h = harness();
  const manager = new DockerWorkspaces(config, h.command, volumeFor);
  await assert.rejects(manager.read('run-a', '/etc/passwd'), /상대 경로/);
  await assert.rejects(manager.read('run-a', 'result.txt', 1024 * 1024 + 1), /1MiB/);
  await assert.rejects(manager.list('run-a', '.agent-runtime'), /내부 파일/);
  assert.equal(h.calls.length, 0);
});

test('helper cleanup failure is surfaced and tracked instead of accepting copied files as ready', async () => {
  const h = harness();
  h.own('run-a');
  h.failCleanup();
  const pending: string[] = [];
  await assert.rejects(new DockerWorkspaces(config, h.command, volumeFor, name => pending.push(name)).prepare('run-b', 'run-a'), /종료를 확인하지/);
  assert.equal(pending.length, 1);
  assert.match(pending[0], /^ac-ws-[a-f0-9-]{36}$/);
});

test('aborted copy kills the exact helper without deleting either workspace volume', async () => {
  const h = harness();
  h.own('run-a');
  const controller = new AbortController();
  const command: Command = async (file, args, options) => {
    if (args[0] === 'run') { h.calls.push({ args, options: options ?? {} }); controller.abort(); throw new Error('cancelled'); }
    return h.command(file, args, options);
  };
  await assert.rejects(new DockerWorkspaces(config, command, volumeFor).prepare('run-b', 'run-a', controller.signal), /cancelled/);
  const worker = h.calls.find(call => call.args[0] === 'run')!;
  assert.deepEqual(h.calls.at(-1)!.args, ['rm', '-f', worker.args[worker.args.indexOf('--name') + 1]]);
  assert.equal(h.calls.some(call => call.args[0] === 'volume' && call.args[1] === 'rm'), false);
});

test('malformed helper result and byte mismatches are not accepted', async () => {
  const h = harness();
  h.own('run-a');
  const manager = new DockerWorkspaces(config, h.command, volumeFor);
  h.response({ ...marker(), runId: 'other-run' });
  await assert.rejects(manager.prepare('run-b', 'run-a'), /일치하지/);
  h.response({ path: 'result.txt', text: '가', bytes: 1 });
  await assert.rejects(manager.read('run-a', 'result.txt'), /응답이 올바르지/);
});

test('real Docker named volumes inherit, fork and reject escaping links without credentials or model access', {
  skip: process.env.AGENT_WORKSPACE_DOCKER_TEST !== 'true', timeout: 180_000,
}, async t => {
  const workspaceKey = `workspace-test-${randomUUID()}`;
  const testConfig = { ...config, image: process.env.AGENT_IMAGE ?? 'agent-company-worker:0.1.0', workspaceKey };
  const volume = (id: string) => `ac-${createHash('sha256').update(workspaceKey).digest('hex').slice(0, 16)}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
  const distro = process.env.AGENT_DOCKER_WSL_DISTRO;
  assert.ok(!distro || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(distro));
  const docker: Command = (file, args, options) => distro
    ? executeCommand('wsl.exe', ['--distribution', distro, '--exec', file, ...args], options)
    : executeCommand(file, args, options);
  const manager = new DockerWorkspaces(testConfig, docker, volume);
  const runIds = ['reference', 'branch', 'escape', 'special', 'marker'];
  t.after(async () => {
    const containers = await docker('docker', ['ps', '-aq', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${workspaceKey}`]);
    assert.equal(containers.code, 0);
    for (const id of containers.stdout.trim().split(/\s+/).filter(Boolean)) {
      assert.match(id, /^[a-f0-9]{12,64}$/);
      const owner = await docker('docker', ['inspect', id, '--format', '{{json .Config.Labels}}']);
      assert.equal(owner.code, 0);
      const labels = JSON.parse(owner.stdout);
      assert.equal(labels.app, 'agent-company');
      assert.equal(labels['agent-company.workspace'], workspaceKey);
      assert.equal((await docker('docker', ['rm', '-f', id])).code, 0);
    }
    for (const runId of runIds) {
      const inspected = await docker('docker', ['volume', 'inspect', volume(runId), '--format', '{{json .Labels}}']);
      if (inspected.code !== 0 && /no such volume|not found/i.test(inspected.stderr)) continue;
      assert.equal(inspected.code, 0);
      const labels = JSON.parse(inspected.stdout);
      assert.equal(labels.app, 'agent-company');
      assert.equal(labels['agent-company.workspace'], workspaceKey);
      assert.equal(labels['agent-company.run'], runId);
      assert.equal((await docker('docker', ['volume', 'rm', volume(runId)])).code, 0);
    }
  });
  const seed = async (id: string, script: string) => {
    const name = `ac-fixture-${randomUUID()}`;
    const result = await docker('docker', ['run', '--rm', '-i', '--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${workspaceKey}`,
      '--label', `agent-company.run=${id}`, '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000',
      '--memory=128m', '--cpus=0.5', '--pids-limit=32', '--mount', `type=volume,source=${volume(id)},target=/workspace`,
      '--entrypoint=node', testConfig.image, '--input-type=module', '-'], { input: script, timeoutMs: 30_000 });
    assert.equal(result.code, 0, result.stderr);
  };
  const initialized = await manager.prepare('reference');
  assert.equal(initialized.reused, false);
  await seed('reference', `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, symlink } from 'node:fs/promises';
    assert.equal(process.getuid(), 1000);
    await mkdir('/workspace/project');
    await writeFile('/workspace/project/result.txt', 'source unchanged');
    await writeFile('/workspace/project/tool.sh', '#!/bin/sh\\ntrue\\n', { mode: 0o755 });
    await symlink('result.txt', '/workspace/project/internal.txt');
    for (const name of ['.agent', '.agents', '.agent-runtime', '.codex']) {
      await mkdir('/workspace/' + name);
      await writeFile('/workspace/' + name + '/private', 'must not copy');
    }
    await writeFile('/workspace/AGENTS.md', 'injected instructions');
  `);
  assert.equal((await manager.prepare('branch', 'reference')).reused, false);
  assert.deepEqual((await manager.list('branch')).entries.map(entry => entry.name), ['project']);
  assert.equal((await manager.read('branch', 'project/result.txt')).text, 'source unchanged');
  await assert.rejects(manager.read('branch', 'project/internal.txt'), /심볼릭 링크/);
  await seed('branch', `
    import assert from 'node:assert/strict';
    import { writeFile, readFile, stat, readdir } from 'node:fs/promises';
    assert.equal((await stat('/workspace/project/tool.sh')).mode & 0o777, 0o755);
    assert.equal(await readFile('/workspace/project/internal.txt', 'utf8'), 'source unchanged');
    assert.deepEqual((await readdir('/workspace')).sort(), ['.agent-workspace.json', 'project']);
    await writeFile('/workspace/project/result.txt', 'independent fork');
  `);
  assert.equal((await manager.prepare('branch', 'reference')).reused, true);
  assert.equal((await manager.read('branch', 'project/result.txt')).text, 'independent fork');
  assert.equal((await manager.read('reference', 'project/result.txt')).text, 'source unchanged');
  await seed('reference', "import {symlink} from 'node:fs/promises'; await symlink('/etc/passwd', '/workspace/escape');");
  await assert.rejects(manager.prepare('escape', 'reference'), /외부 심볼릭 링크/);
  await seed('reference', "import {unlink} from 'node:fs/promises'; import {execFileSync} from 'node:child_process'; await unlink('/workspace/escape'); execFileSync('mkfifo', ['/workspace/pipe']);");
  await assert.rejects(manager.prepare('special', 'reference'), /특수 파일/);
  await seed('reference', "import {unlink, symlink} from 'node:fs/promises'; await unlink('/workspace/pipe'); await symlink('.agent-runtime/private', '/workspace/secret-link');");
  await assert.rejects(manager.prepare('marker', 'reference'), /내부 파일/);
  t.diagnostic('Actual UID1000 named-volume initialization, independent copy, mode preservation, symlinks, exclusion, source immutability and special-file rejection verified; no model/auth/database used.');
});
