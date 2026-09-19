import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from '../server/process.ts';

test('explicit child environment excludes inherited configuration without mutating the parent', async () => {
  const key = 'AGENT_COMPANY_PROCESS_ENV_CONTRACT';
  const previous = process.env[key];
  process.env[key] = 'parent-only';
  try {
    const program = `process.stdout.write(JSON.stringify({ inherited: process.env.${key} ?? null, explicit: process.env.AC_EXPLICIT ?? null }));`;
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, AC_EXPLICIT: 'selected' };
    const child = await command(process.execPath, ['-e', program], { env });
    assert.equal(child.code, 0);
    assert.deepEqual(JSON.parse(child.stdout), { inherited: null, explicit: 'selected' });
    const legacy = await command(process.execPath, ['-e', program]);
    assert.deepEqual(JSON.parse(legacy.stdout), { inherited: 'parent-only', explicit: null });
    assert.equal(process.env[key], 'parent-only');
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('process adapter delivers UTF-8 stdin and final unterminated line without shell expansion', async () => {
  const messages: string[] = [];
  const result = await command(process.execPath, ['-e', "process.stdin.setEncoding('utf8'); process.stdin.on('data', s => process.stdout.write(s));"], {
    input: '기억\n$(not-a-command)',
    onLine: async line => { await Promise.resolve(); messages.push(line); },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(messages, ['기억', '$(not-a-command)']);
});

test('process adapter reports exit code and bounded stderr', async () => {
  const result = await command(process.execPath, ['-e', "process.stderr.write('failure'); process.exitCode=7;"]);
  assert.equal(result.code, 7);
  assert.equal(result.stderr, 'failure');
});

test('final admission gate runs synchronously before even a missing executable can be spawned', async () => {
  let checked = 0;
  await assert.rejects(command('agent-company-test-executable-that-does-not-exist', [], {
    beforeSpawn() { checked++; throw Object.assign(new Error('DEPLOYMENT_PAUSED'), { code: 'DEPLOYMENT_PAUSED' }); },
  }), { code: 'DEPLOYMENT_PAUSED' });
  assert.equal(checked, 1);
});

test('process timeout and cancellation reject rather than treating a killed command as complete', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 }), /제한 시간/);
  const controller = new AbortController();
  const running = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, /취소/);
});

test('interactive process keeps stdin open and returns asynchronous UTF-8 JSONL replies in order', async () => {
  const messages: string[] = [];
  const program = `
    const readline = require('node:readline');
    let step = 0;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const value = JSON.parse(line);
      if (step++ === 0) { if (value.initial !== '시작') process.exit(2); process.stdout.write('request-one\\n'); }
      else if (step === 2) { if (value.answer !== '응답 1') process.exit(3); process.stdout.write('request-two\\n'); }
      else { if (value.answer !== '응답 2') process.exit(4); process.stdout.write('done'); process.exit(0); }
    });`;
  const result = await command(process.execPath, ['-e', program], {
    interactive: true, input: JSON.stringify({ initial: '시작' }),
    onLine: async line => {
      messages.push(line);
      await Promise.resolve();
      if (line === 'request-one') return JSON.stringify({ answer: '응답 1' });
      if (line === 'request-two') return JSON.stringify({ answer: '응답 2' });
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(messages, ['request-one', 'request-two', 'done']);
});

test('interactive replies cannot inject extra lines or exceed the response limit', async () => {
  for (const response of ['first\nsecond', 'x'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(command(process.execPath, ['-e', "process.stdout.write('request\\n');setInterval(()=>{},1000)"], {
      interactive: true, onLine: () => response,
    }), /JSONL/);
  }
});

test('command timeout also bounds an unfinished notification after the child has exited', async () => {
  await assert.rejects(command(process.execPath, ['-e', "process.stdout.write('request\\n')"], {
    timeoutMs: 200, onLine: () => new Promise<void>(() => {}),
  }), /제한 시간/);
});
