import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceScheduler, readResourceConfig, type ResourceAmount } from '../server/resources.ts';

const resource = (memoryMiB: number, cpus = memoryMiB / 1024): ResourceAmount => ({ memoryMiB, cpus });
const scheduler = (memoryMiB = 4096, cpus = memoryMiB / 1024) => new ResourceScheduler({
  capacity: resource(memoryMiB, cpus),
  defaultRequest: { minimum: resource(1024), preferred: resource(2048) },
});

test('resource config validates finite total, minimum and per-worker limits without silent fallback', () => {
  assert.deepEqual(readResourceConfig({}), {
    capacity: resource(4096), defaultRequest: { minimum: resource(1024), preferred: resource(2048) }, workerLimit: resource(2048),
  });
  assert.equal(readResourceConfig({ AGENT_CPU_BUDGET: '2.5', AGENT_WORKER_MIN_CPUS: '0.5' }).capacity.cpus, 2.5);
  for (const env of [
    { AGENT_MEMORY_BUDGET_MIB: '0' }, { AGENT_MEMORY_BUDGET_MIB: '4096.5' },
    { AGENT_CPU_BUDGET: 'NaN' }, { AGENT_CPU_BUDGET: 'Infinity' }, { AGENT_CPU_BUDGET: '' },
    { AGENT_WORKER_MIN_CPUS: '0.0001' }, { AGENT_WORKER_MAX_MEMORY_MIB: '-1' },
    { AGENT_WORKER_MIN_MEMORY_MIB: '4096' }, { AGENT_WORKER_MAX_CPUS: '5' },
    { AGENT_CPU_BUDGET: '1' }, { AGENT_WORKER_MIN_MEMORY_MIB: '9007199254740992' },
  ]) assert.throws(() => readResourceConfig(env), RangeError);
});

test('allocation uses preferred capacity when free and a smaller grant when only the minimum fits', async () => {
  const queue = scheduler(3072);
  const first = await queue.acquire('first');
  const second = await queue.acquire('second');
  assert.deepEqual(first.resources, resource(2048));
  assert.deepEqual(second.resources, resource(1024));
  assert.deepEqual(queue.snapshot().reserved, resource(3072));
  assert.deepEqual(queue.snapshot().available, resource(0));
  first.release();
  second.release();
  assert.deepEqual(queue.snapshot().reserved, resource(0));
});

test('FIFO does not let a smaller new request bypass a blocked older request', async () => {
  const queue = scheduler(3072);
  const active = await queue.acquire('active');
  const controller = new AbortController();
  const larger = queue.acquire('larger', { minimum: resource(2048), signal: controller.signal });
  const cancelled = assert.rejects(larger, { name: 'AbortError' });
  const smaller = queue.acquire('smaller');
  assert.deepEqual(queue.snapshot().waiting.map(item => item.ownerId), ['larger', 'smaller']);
  assert.equal(queue.snapshot().running.length, 1);
  controller.abort();
  await cancelled;
  const next = await smaller;
  assert.deepEqual(next.resources, resource(1024));
  assert.deepEqual(queue.snapshot().waiting, []);
  active.release();
  next.release();
});

test('release wakes queued work in order and repeated release never overcommits the budget', async () => {
  const queue = scheduler(2048);
  const first = await queue.acquire('first');
  const secondWaiting = queue.acquire('second');
  const thirdWaiting = queue.acquire('third');
  first.release();
  first.release();
  const second = await secondWaiting;
  assert.deepEqual(queue.snapshot().running.map(item => item.ownerId), ['second']);
  assert.deepEqual(queue.snapshot().waiting.map(item => item.ownerId), ['third']);
  second.release();
  const third = await thirdWaiting;
  assert.deepEqual(queue.snapshot().reserved, resource(2048));
  third.release();
  assert.deepEqual(queue.snapshot().available, resource(2048));
});

test('an already cancelled request cannot allocate or create a queue entry', async () => {
  const queue = scheduler();
  const controller = new AbortController();
  controller.abort(new Error('already stopped'));
  await assert.rejects(queue.acquire('cancelled', { signal: controller.signal }), /already stopped/);
  assert.deepEqual(queue.snapshot().running, []);
  assert.deepEqual(queue.snapshot().waiting, []);
});

test('queued cancellation frees the owner and running cancellation retains limits until cleanup releases', async () => {
  const queue = scheduler(2048);
  const activeController = new AbortController();
  const active = await queue.acquire('active', { signal: activeController.signal });
  const pendingController = new AbortController();
  const pending = queue.acquire('pending', { signal: pendingController.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  pendingController.abort();
  await rejected;
  const retried = queue.acquire('pending');
  activeController.abort();
  assert.deepEqual(queue.snapshot().reserved, resource(2048));
  assert.equal(active.released, false);
  active.release();
  const next = await retried;
  assert.equal(next.ownerId, 'pending');
  next.release();
});

test('invalid and impossible requests are rejected before entering the queue', async () => {
  const queue = new ResourceScheduler(readResourceConfig({}));
  await assert.rejects(queue.acquire('impossible', { minimum: resource(8192), preferred: resource(8192) }), /minimum resources/);
  await assert.rejects(queue.acquire('oversized', { preferred: resource(3072) }), /preferred resources/);
  await assert.rejects(queue.acquire('reversed', { minimum: resource(2048), preferred: resource(1024) }), /minimum resources/);
  await assert.rejects(queue.acquire('invalid', { minimum: resource(1024, Number.NaN) }), /cpus/);
  await assert.rejects(queue.acquire(''), /ownerId/);
  assert.deepEqual(queue.snapshot().waiting, []);
  assert.deepEqual(queue.snapshot().running, []);
});

test('duplicate owners are rejected and an old released lease cannot release a replacement', async () => {
  const queue = scheduler(2048);
  const first = await queue.acquire('owner');
  await assert.rejects(queue.acquire('owner'), /already has/);
  const waiting = queue.acquire('waiting');
  await assert.rejects(queue.acquire('waiting'), /already has/);
  first.release();
  const second = await waiting;
  const replacementWaiting = queue.acquire('owner');
  second.release();
  const replacement = await replacementWaiting;
  first.release();
  assert.equal(first.tryGrow(resource(2048)), false);
  assert.deepEqual(queue.snapshot().running.map(item => item.ownerId), ['owner']);
  replacement.release();
});

test('growth stays within budget, never shrinks a live limit, and cannot bypass queued work', async () => {
  const queue = scheduler(3072);
  const first = await queue.acquire('first', { preferred: resource(1024) });
  assert.equal(first.tryGrow(resource(2048)), true);
  const second = await queue.acquire('second');
  assert.equal(first.tryGrow(resource(3072)), false);
  assert.throws(() => first.tryGrow(resource(1024)), /cannot be shrunk/);
  const waiting = queue.acquire('waiting', { minimum: resource(2048) });
  second.release();
  assert.equal(first.tryGrow(resource(3072)), false);
  assert.equal(first.tryGrow(resource(2048)), true);
  first.release();
  const next = await waiting;
  next.release();
});

test('growth cannot exceed configured per-worker limits even when total capacity is free', async () => {
  const queue = new ResourceScheduler(readResourceConfig({}));
  const first = await queue.acquire('first', { preferred: resource(1024) });
  assert.throws(() => first.tryGrow(resource(3072)), /worker limit/);
  assert.deepEqual(first.resources, resource(1024));
  first.release();
});

test('resource accounting handles fractional CPUs without drift across repeated allocation and release', async () => {
  const queue = new ResourceScheduler({ capacity: resource(1024, 0.3), defaultRequest: { minimum: resource(64, 0.1), preferred: resource(64, 0.1) } });
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = await queue.acquire('one');
    const second = await queue.acquire('two');
    const third = await queue.acquire('three');
    assert.equal(queue.snapshot().reserved.cpus, 0.3);
    assert.equal(queue.snapshot().available.cpus, 0);
    second.release();
    first.release();
    third.release();
    assert.equal(queue.snapshot().available.cpus, 0.3);
  }
});

test('simultaneous promise continuations never oversubscribe either dimension', async () => {
  const queue = scheduler(4096, 3);
  let maximum = 0;
  await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const lease = await queue.acquire(`run-${index}`);
    const state = queue.snapshot();
    assert.ok(state.reserved.memoryMiB <= 4096);
    assert.ok(state.reserved.cpus <= 3);
    maximum = Math.max(maximum, state.running.length);
    await Promise.resolve();
    lease.release();
  }));
  assert.ok(maximum > 1);
  assert.deepEqual(queue.snapshot().reserved, resource(0));
  assert.deepEqual(queue.snapshot().waiting, []);
});

test('callers cannot mutate live accounting via configuration, requests, leases or snapshots', async () => {
  const config = readResourceConfig({});
  const queue = new ResourceScheduler(config);
  config.capacity.memoryMiB = 1;
  config.defaultRequest.preferred.memoryMiB = 1;
  config.workerLimit!.cpus = 0;
  const requested = resource(1024);
  const active = await queue.acquire('active', { preferred: requested });
  requested.memoryMiB = 1;
  active.resources.cpus = 999;
  const state = queue.snapshot();
  state.capacity.cpus = 0;
  state.running[0].resources.memoryMiB = 9000;
  assert.deepEqual(queue.snapshot().capacity, resource(4096));
  assert.deepEqual(queue.snapshot().reserved, resource(1024));
  active.release();
});
