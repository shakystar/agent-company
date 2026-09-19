import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Scenario } from './lifecycle-campaign.ts';

export class LifecycleClient {
  private child?: ChildProcess;
  origin = '';
  constructor(readonly scenario: Scenario) {}
  async start() {
    assert.ok(!this.child, 'Stop the owned controller before reopening its DB');
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/lifecycle-controller.ts'), this.scenario],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child = child;
    child.stdout!.on('data', bytes => process.stdout.write(bytes));
    child.stderr!.on('data', bytes => process.stderr.write(bytes));
    await new Promise<void>((accept, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Verification controller did not become ready')); }, 150_000);
      const cleanup = () => { clearTimeout(timeout); child.off('error', failed); child.off('exit', exited); child.off('message', received); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const exited = (code: number | null) => failed(new Error(`Verification controller exited before ready: ${code}`));
      const received = (message: unknown) => {
        const value = message as { type?: string; origin?: string; pid?: number };
        if (value.type !== 'ready') return;
        try {
          assert.equal(value.pid, child.pid); assert.match(value.origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
          this.origin = value.origin!; cleanup(); accept();
        } catch (error) { failed(error as Error); }
      };
      child.on('error', failed); child.on('exit', exited); child.on('message', received);
    });
  }
  async api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const result = await fetch(`${this.origin}${path}`, { method,
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
    if (!result.ok) throw new Error(`${method} ${path}: HTTP ${result.status} ${await result.text()}`);
    return result.json() as Promise<T>;
  }
  async stop(crash = false) {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      if (crash) { console.log(`Controlled crash of owned verification controller PID ${child.pid}`); child.kill('SIGKILL'); }
      else if (child.connected) child.send({ type: 'close' });
      else throw new Error('Owned controller IPC is unavailable; shutdown must be verified');
      await Promise.race([exited, delay(120_000, undefined, { ref: false }).then(() => { throw new Error('Owned controller did not stop'); })]);
    }
    if (!crash) assert.equal(child.exitCode, 0, 'Verification controller failed to close cleanly');
    this.child = undefined; this.origin = '';
  }
}
