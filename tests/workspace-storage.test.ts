import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { command, type Command } from '../server/process.ts';
import { DockerWorkspaces } from '../server/workspaces.ts';

const { archiveWorkspace, restoreWorkspace, measureWorkspace, writeWorkspaceFiles, downloadWorkspace } = await import(new URL('../worker/storage.mjs', import.meta.url).href);
const { prepareWorkspace } = await import(new URL('../worker/workspace.mjs', import.meta.url).href);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-company-storage-'));
  const source = join(root, 'source'), target = join(root, 'target');
  await mkdir(source); await mkdir(target);
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  await prepareWorkspace(source, null, { runId: 'run-source', sourceRunId: null });
  return { root, source, target };
}
async function archive(source: string, maxBytes?: number) {
  const chunks: Buffer[] = [];
  for await (const chunk of archiveWorkspace(source, maxBytes, 'run-source')) {
    assert.ok(Buffer.byteLength(chunk) < 128 * 1024);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test('streamed backup roundtrip preserves binary, Korean paths, session continuation and source identity but excludes credentials', async t => {
  const { source, target } = await fixture(t);
  await mkdir(join(source, '자료'));
  const binary = randomBytes(256 * 1024 + 7);
  await writeFile(join(source, '자료', '결과.bin'), binary);
  await mkdir(join(source, '.agent-runtime', 'sessions'), { recursive: true });
  await writeFile(join(source, '.agent-runtime', 'sessions', 'session.jsonl'), 'continuation');
  await writeFile(join(source, '.agent-runtime', 'private'), 'not part of sessions');
  await mkdir(join(source, '.codex'));
  await writeFile(join(source, '.codex', 'auth.json'), 'secret');
  await writeFile(join(source, 'auth.json'), 'secret');
  await writeFile(join(source, '.env'), 'secret');
  const before = await measureWorkspace(source);
  const serialized = await archive(source);
  assert.equal(serialized.includes('secret'), false);
  // Split every UTF-8 character and frame boundary to verify incremental decoding.
  const result = await restoreWorkspace(target, Readable.from((function* () { for (let i = 0; i < serialized.length; i += 101) yield serialized.subarray(i, i + 101); })()), 'run-source');
  assert.equal(result.runId, 'run-source');
  assert.equal(result.sourceRunId, null);
  assert.deepEqual(await readFile(join(target, '자료', '결과.bin')), binary);
  assert.equal(await readFile(join(target, '.agent-runtime', 'sessions', 'session.jsonl'), 'utf8'), 'continuation');
  assert.equal((await measureWorkspace(target)).bytes < before.bytes + 200, true);
  await assert.rejects(readFile(join(target, '.codex', 'auth.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(source, '자료', '결과.bin')), binary);
});

test('invalid archive, content limits, modified chunks, truncated and trailing archives never publish ready marker', async t => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'binary'), Buffer.from([1, 2, 3]));
  const serialized = (await archive(source)).toString('utf8');
  const cases = [serialized.replace('AQID', 'AQIE'), serialized.slice(0, serialized.lastIndexOf('{"type":"end"')), `${serialized}{}\n`, serialized.replace('"path":"binary"', '"path":"../outside"')];
  for (const [index, body] of cases.entries()) {
    const target = join(root, `bad-${index}`); await mkdir(target);
    await assert.rejects(restoreWorkspace(target, Readable.from([body]), 'run-source'));
    await assert.rejects(readFile(join(target, '.agent-workspace.json')), { code: 'ENOENT' });
  }
  const limited = join(root, 'limited'); await mkdir(limited);
  await assert.rejects(restoreWorkspace(limited, Readable.from([serialized]), 'run-source', 2), /용량 한도/);
  await assert.rejects(archive(source, 2), /용량 한도/);
});

test('restore refuses nonempty targets and rejects credential and special archive entries', async t => {
  const { root, source, target } = await fixture(t);
  await writeFile(join(source, 'data'), 'abc');
  const serialized = (await archive(source)).toString('utf8');
  await writeFile(join(target, 'original'), 'keep');
  await assert.rejects(restoreWorkspace(target, Readable.from([serialized]), 'run-source'), /새 작업공간/);
  assert.equal(await readFile(join(target, 'original'), 'utf8'), 'keep');
  for (const [index, path] of ['.codex/auth.json', '.agent-runtime/private', 'auth.json', '/etc/passwd'].entries()) {
    const folder = join(root, `secret-${index}`); await mkdir(folder);
    await assert.rejects(restoreWorkspace(folder, Readable.from([serialized.replace('"path":"data"', `"path":${JSON.stringify(path)}`)]), 'run-source'));
  }
});

test('unfinished and malformed workspace markers are preserved without promotion to ready', async t => {
  const { root, source, target } = await fixture(t);
  await unlink(join(source, '.agent-workspace.json'));
  await writeFile(join(source, '.agent-workspace.pending'), '{"state":"copying","runId":"run-source"}');
  await writeFile(join(source, 'partial'), 'unfinished work');
  const result = await restoreWorkspace(target, Readable.from([await archive(source)]), 'run-source');
  assert.equal(result.ready, false); assert.equal(result.state, 'incomplete');
  assert.equal(await readFile(join(target, '.agent-workspace.pending'), 'utf8'), await readFile(join(source, '.agent-workspace.pending'), 'utf8'));
  assert.equal(await readFile(join(target, 'partial'), 'utf8'), 'unfinished work');
  await assert.rejects(prepareWorkspace(target, null, { runId: 'run-source', sourceRunId: null }), /초기화가 끝나지/);
  await writeFile(join(source, '.agent-workspace.json'), '{broken');
  const broken = join(root, 'broken-marker'); await mkdir(broken);
  assert.equal((await restoreWorkspace(broken, Readable.from([await archive(source)]), 'run-source')).ready, false);
  assert.equal(await readFile(join(broken, '.agent-workspace.json'), 'utf8'), '{broken');
});

test('personal binary import creates copies and directories, refuses overwrite and internal paths, supports empty files', async t => {
  const { source } = await fixture(t);
  const bytes = randomBytes(1000);
  assert.deepEqual(await writeWorkspaceFiles(source, [{ path: 'nested/자료.bin', contentBase64: bytes.toString('base64') }, { path: 'empty', contentBase64: '' }]), { files: 2, bytes: 1000 });
  assert.deepEqual(await downloadWorkspace(source, 'nested/자료.bin'), { path: 'nested/자료.bin', contentBase64: bytes.toString('base64'), bytes: 1000 });
  assert.equal((await downloadWorkspace(source, 'empty')).bytes, 0);
  await assert.rejects(writeWorkspaceFiles(source, [{ path: 'nested/자료.bin', contentBase64: 'Yg==' }]), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(source, 'nested', '자료.bin')), bytes);
  await assert.rejects(downloadWorkspace(source, 'nested/자료.bin', 999), /한도/);
  for (const path of ['../escape', '/etc/passwd', '.agent-runtime/sessions/private', '.codex/auth.json']) {
    await assert.rejects(writeWorkspaceFiles(source, [{ path, contentBase64: '' }]));
    await assert.rejects(downloadWorkspace(source, path));
  }
  await assert.rejects(writeWorkspaceFiles(source, [{ path: 'bad', contentBase64: 'Zg=' }]), /16MiB/);
});

test('portable file collisions are checked within each actual folder, not across independent folders', async t => {
  const { source } = await fixture(t);
  await writeWorkspaceFiles(source, [{ path: 'one/File', contentBase64: '' }, { path: 'two/file', contentBase64: '' }]);
  await assert.rejects(writeWorkspaceFiles(source, [{ path: 'one/file', contentBase64: '' }]), /충돌/);
  await assert.rejects(writeWorkspaceFiles(source, [{ path: 'New/a', contentBase64: '' }, { path: 'new/b', contentBase64: '' }]), /충돌/);
  await writeWorkspaceFiles(source, [{ path: 'unicode/é', contentBase64: '' }]);
  await assert.rejects(writeWorkspaceFiles(source, [{ path: 'unicode/e\u0301', contentBase64: '' }]), /충돌/);
  await writeWorkspaceFiles(source, [{ path: 'other/e\u0301', contentBase64: '' }]);
});

test('storage symlinks never expose external or credential paths', async t => {
  const { source, target } = await fixture(t);
  await writeFile(join(source, 'file'), 'data');
  try { await symlink('file', join(source, 'link')); }
  catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows symbolic-link privilege unavailable; separate Docker test covers this'); return; } throw error; }
  await restoreWorkspace(target, Readable.from([await archive(source)]), 'run-source');
  assert.equal(await readFile(join(target, 'link'), 'utf8'), 'data');
  await assert.rejects(downloadWorkspace(source, 'link'), /심볼릭 링크/);
  await symlink('/etc/passwd', join(source, 'external'));
  await assert.rejects(archive(source), /외부 심볼릭 링크/);
});

test('binary command streaming applies backpressure without text capture or volume-sized buffers', async () => {
  const bytes = 20 * 1024 * 1024, hash = createHash('sha256');
  let received = 0, consumers = 0;
  const result = await command(process.execPath, ['-e', 'for(let i=0;i<320;i++)process.stdout.write(Buffer.alloc(65536,7));'], {
    captureStdout: false, timeoutMs: 30_000,
    onStdout: async chunk => { assert.equal(consumers++, 0); await Promise.resolve(); received += chunk.length; hash.update(chunk); consumers--; },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(received, bytes);
  assert.equal(hash.digest('hex'), createHash('sha256').update(Buffer.alloc(bytes, 7)).digest('hex'));
  const input = await command(process.execPath, ['-e', "let bytes=0;process.stdin.on('data',chunk=>{bytes+=chunk.length;});process.stdin.on('end',()=>process.stdout.write(String(bytes)));"], {
    inputStream: (async function* () { for (let i = 0; i < bytes; i += 64 * 1024) yield Buffer.alloc(64 * 1024, 7); })(), timeoutMs: 30_000,
  });
  assert.equal(input.code, 0); assert.equal(input.stdout, String(bytes));
});

test('Docker archive API exports only owned idle volumes, hashes actual archive and rejects existing destinations', async t => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'data'), 'abc');
  const compressed = gzipSync(await archive(source));
  const config = { mode: 'docker' as const, image: 'test-worker', workspaceKey: 'storage-test', persistentWorkspaces: true };
  const volume = (id: string) => `ac-${'a'.repeat(16)}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
  const calls: string[][] = [];
  const run: Command = async (_file, args, options = {}) => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: JSON.stringify({ app: 'agent-company', 'agent-company.workspace': config.workspaceKey, 'agent-company.run': 'run-source' }), stderr: '' };
    if (args[0] === 'ps' || args[0] === 'rm') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'run') {
      assert.ok(args.includes('--network=none')); assert.ok(args.includes(`type=volume,source=${volume('run-source')},target=/workspace,readonly,volume-nocopy`));
      for (let i = 0; i < compressed.length; i += 10) await options.onStdout?.(compressed.subarray(i, i + 10));
      return { code: 0, stdout: '', stderr: JSON.stringify({ type: 'end', files: 1, contentBytes: 3 }) };
    }
    throw new Error(args.join(' '));
  };
  const manager = new DockerWorkspaces(config, run, volume);
  const path = join(root, 'archive.gz');
  const result = await manager.export('run-source', path);
  assert.equal(result.bytes, compressed.length);
  assert.equal(result.sha256, createHash('sha256').update(compressed).digest('hex'));
  assert.deepEqual(gunzipSync(await readFile(path)), await archive(source));
  await assert.rejects(manager.export('run-source', path), { code: 'EEXIST' });
  await assert.rejects(manager.import('run-source', path), /기존 볼륨/);
  assert.equal(calls.some(args => args.includes('create')), false);
});

test('binary transfers reject consumer failure and cancellation, including unfinished consumers', async () => {
  await assert.rejects(command(process.execPath, ['-e', "process.stdout.write('bytes');setInterval(()=>{},1000)"], {
    captureStdout: false, onStdout: () => { throw new Error('disk full'); }, timeoutMs: 10_000,
  }), /disk full/);
  await assert.rejects(command(process.execPath, ['-e', "process.stdout.write('bytes')"], {
    captureStdout: false, onStdout: () => new Promise<void>(() => {}), timeoutMs: 200,
  }), /제한 시간/);
  await assert.rejects(command(process.execPath, ['-e', 'process.stdin.resume()'], {
    inputStream: (async function* () { yield 'first'; throw new Error('source read failed'); })(), timeoutMs: 10_000,
  }), /source read failed/);
});

test('real Docker archives stream across WSL without host mounts, preserve sessions and exclude credentials', {
  skip: process.env.AGENT_STORAGE_DOCKER_TEST !== 'true', timeout: 240_000,
}, async t => {
  const { root } = await fixture(t);
  const workspaceKey = `storage-test-${randomUUID()}`;
  const image = process.env.AGENT_IMAGE ?? 'agent-company-worker:0.1.0';
  const distro = process.env.AGENT_DOCKER_WSL_DISTRO;
  assert.ok(!distro || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(distro));
  const docker: Command = (file, args, options) => distro ? command('wsl.exe', ['--distribution', distro, '--exec', file, ...args], options) : command(file, args, options);
  const generations = [workspaceKey, `${workspaceKey}-restored`, `${workspaceKey}-bad`, `${workspaceKey}-partial`];
  const volume = (key: string, id: string) => `ac-${createHash('sha256').update(key).digest('hex').slice(0, 16)}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
  const managers = generations.map(key => new DockerWorkspaces({ mode: 'docker', image, workspaceKey: key, persistentWorkspaces: true }, docker, id => volume(key, id)));
  const liveName = `ac-storage-test-${randomUUID()}`;
  t.after(async () => {
    for (const key of generations) {
      const listed = await docker('docker', ['ps', '-aq', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${key}`]);
      assert.equal(listed.code, 0);
      for (const id of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
        assert.match(id, /^[a-f0-9]{12,64}$/);
        const inspected = await docker('docker', ['inspect', id, '--format', '{{json .Config.Labels}}']);
        if (inspected.code === 0) {
          const labels = JSON.parse(inspected.stdout); assert.equal(labels.app, 'agent-company'); assert.equal(labels['agent-company.workspace'], key);
          assert.equal((await docker('docker', ['rm', '-f', id])).code, 0);
        } else assert.match(inspected.stderr, /No such (?:object|container)/i);
      }
    }
    for (const manager of managers) await manager.remove('seed');
  });
  const binary = randomBytes(1024 * 1024 + 17);
  await managers[0].importFiles('seed', null, [{ path: 'files/결과.bin', contentBase64: binary.toString('base64') }]);
  const seed = await docker('docker', ['run', '--rm', '-i', '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--memory=128m', '--cpus=0.5', '--pids-limit=32',
    '--label', 'app=agent-company', '--label', `agent-company.workspace=${workspaceKey}`, '--mount', `type=volume,source=${volume(workspaceKey, 'seed')},target=/workspace`, '--entrypoint=node', image, '--input-type=module', '-'], {
    input: "import {mkdir,writeFile,symlink} from 'node:fs/promises'; await mkdir('/workspace/.agent-runtime/sessions', {recursive:true}); await writeFile('/workspace/.agent-runtime/sessions/continuation.jsonl','session kept'); await mkdir('/workspace/.codex'); await writeFile('/workspace/.codex/auth.json','dummy auth excluded'); await symlink('결과.bin','/workspace/files/internal');", timeoutMs: 30_000,
  });
  assert.equal(seed.code, 0, seed.stderr);
  const archivePath = join(root, 'workspace.jsonl.gz');
  const exported = await managers[0].export('seed', archivePath);
  const actual = await readFile(archivePath);
  assert.equal(exported.sha256, createHash('sha256').update(actual).digest('hex'));
  assert.equal(exported.bytes, actual.length);
  assert.equal(gunzipSync(actual).includes('dummy auth excluded'), false);
  const imported = await managers[1].import('seed', archivePath);
  assert.equal(imported.runId, 'seed');
  assert.deepEqual(Buffer.from((await managers[1].download('seed', 'files/결과.bin')).contentBase64, 'base64'), binary);
  const secondArchive = join(root, 'restored.jsonl.gz');
  await managers[1].export('seed', secondArchive);
  assert.equal(gunzipSync(await readFile(secondArchive)).includes('c2Vzc2lvbiBrZXB0'), true);
  assert.deepEqual(Buffer.from((await managers[0].download('seed', 'files/결과.bin')).contentBase64, 'base64'), binary);
  await assert.rejects(managers[1].download('seed', 'files/internal'), /심볼릭 링크/);
  const live = await docker('docker', ['run', '-d', '--rm', '--name', liveName, '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--memory=64m', '--cpus=0.25', '--pids-limit=32',
    '--label', 'app=agent-company', '--label', `agent-company.workspace=${workspaceKey}`, '--mount', `type=volume,source=${volume(workspaceKey, 'seed')},target=/workspace,readonly,volume-nocopy`, '--entrypoint=node', image, '-e', 'setTimeout(()=>{},120000)']);
  assert.equal(live.code, 0, live.stderr);
  const measured = await managers[0].volumes();
  assert.equal(measured.length, 1); assert.equal(measured[0].runId, 'seed'); assert.ok(measured[0].bytes >= binary.length);
  await assert.rejects(managers[0].export('seed', join(root, 'active.gz')), /실행 중/);
  await assert.rejects(managers[0].remove('seed'), /실행 중/);
  await writeFile(join(root, 'broken.gz'), actual.subarray(0, actual.length - 20));
  await assert.rejects(managers[2].import('seed', join(root, 'broken.gz')));
  assert.equal((await docker('docker', ['rm', '-f', liveName])).code, 0);
  const partial = await docker('docker', ['run', '--rm', '-i', '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--memory=128m', '--cpus=0.5', '--pids-limit=32',
    '--label', 'app=agent-company', '--label', `agent-company.workspace=${workspaceKey}`, '--mount', `type=volume,source=${volume(workspaceKey, 'seed')},target=/workspace`, '--entrypoint=node', image, '--input-type=module', '-'], {
    input: "import {unlink,writeFile} from 'node:fs/promises'; await unlink('/workspace/.agent-workspace.json'); await writeFile('/workspace/.agent-workspace.pending','{\"state\":\"copying\"}');", timeoutMs: 30_000,
  });
  assert.equal(partial.code, 0, partial.stderr);
  await managers[0].export('seed', join(root, 'partial.gz'));
  const restoredPartial = await managers[3].import('seed', join(root, 'partial.gz'));
  assert.equal(restoredPartial.ready, false); assert.equal(restoredPartial.state, 'incomplete');
  await assert.rejects(managers[3].prepare('seed'), /초기화가 끝나지/);
  t.diagnostic('Actual WSL stdin/stdout gzip roundtrip, binary input/output, source immutability, session preservation, secret exclusion, active readonly measurement and corrupt import rejection verified; no model/auth/user DB involved.');
});
