import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

test('worker file tools use bound Run identity, bounded chunks and current team access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-file-tools-'));
  const runtime = new StorageFixtureRuntime(randomUUID());
  const service = await AgentService.create({ dataDir: join(directory, 'db'), runtime });
  try {
    const a = await service.createAgent({ name: 'A', persona: 'A' });
    const b = await service.createAgent({ name: 'B', persona: 'B' });
    const team = await service.createTeam({ name: 'T', memberIds: [a.id, b.id] });
    const file = await service.importFile({ scope: { type: 'team', id: team.id }, path: 'shared.bin', mediaType: 'application/octet-stream', base64: Buffer.from([0, 1, 2, 255]).toString('base64') });
    const run = await service.startRun(b.id, 'read shared data');
    for (let i = 0; !runtime.calls.length && i < 100; i++) await delay(10);
    assert.equal(runtime.calls.length, 1);
    const tools = runtime.calls[0].hooks.onTool!;
    assert.ok(runtime.calls[0].input.collaboration!.tools.some(tool => tool.name === 'file_read'));
    const listed = await tools('file_list', { scope: { type: 'team', id: team.id } }) as { files: Array<{ id: string }> };
    assert.equal(listed.files[0].id, file.file.id);
    const chunk = await tools('file_read', { id: file.file.id, offset: 1, maxBytes: 2 }) as { contentBase64: string; nextOffset: number; done: boolean };
    assert.deepEqual(Buffer.from(chunk.contentBase64, 'base64'), Buffer.from([1, 2])); assert.equal(chunk.nextOffset, 3); assert.equal(chunk.done, false);
    await assert.rejects(tools('file_list', { scope: { type: 'agent', id: a.id } }), /개인 파일/);
    await assert.rejects(tools('file_read', { id: file.file.id, maxBytes: 1024 * 1024 }));
    await service.updateTeam(team.id, { memberIds: [a.id] });
    await assert.rejects(tools('file_read', { id: file.file.id }), /공유 범위/);
    await service.cancelRun(run.id);
    await assert.rejects(tools('file_read', { id: file.file.id }), /실행 중/);
  } finally { await service.close(); assert.ok(relative(resolve(tmpdir()), resolve(directory)).startsWith('ac-file-tools-')); await rm(directory, { recursive: true }); }
});
