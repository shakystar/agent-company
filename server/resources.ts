/** Resource reservations are limits for workers, not measurements of physical usage. */
export interface ResourceAmount {
  memoryMiB: number;
  cpus: number;
}

export interface ResourceRequest {
  minimum: ResourceAmount;
  preferred: ResourceAmount;
}

export interface ResourceSchedulerConfig {
  capacity: ResourceAmount;
  defaultRequest: ResourceRequest;
  workerLimit?: ResourceAmount;
}

export interface ResourceAcquireOptions {
  minimum?: ResourceAmount;
  preferred?: ResourceAmount;
  signal?: AbortSignal;
}

export interface ResourceLease {
  readonly ownerId: string;
  readonly resources: ResourceAmount;
  readonly released: boolean;
  /** Reserves additional capacity only; the caller must apply the worker's actual limits. */
  tryGrow(target: ResourceAmount): boolean;
  /** Call only after the worker has stopped. Aborting a running owner does not release it. */
  release(): void;
}

export interface ResourceSchedulerSnapshot {
  capacity: ResourceAmount;
  reserved: ResourceAmount;
  available: ResourceAmount;
  running: Array<ResourceRequest & { ownerId: string; resources: ResourceAmount; acquiredAt: string }>;
  waiting: Array<ResourceRequest & { ownerId: string; enqueuedAt: string }>;
}

// Integer milli-CPUs keep fractional reservations exact, including repeated releases.
interface Units { memoryMiB: number; cpuMillis: number }
interface Bounds { minimum: Units; preferred: Units }
interface Active extends Bounds { ownerId: string; resources: Units; acquiredAt: string }
interface Pending extends Bounds {
  ownerId: string;
  enqueuedAt: string;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (lease: ResourceLease) => void;
  reject: (error: unknown) => void;
}

function units(value: ResourceAmount, name: string): Units {
  const memoryMiB = value?.memoryMiB;
  const cpus = value?.cpus;
  const cpuMillis = Math.round(cpus * 1000);
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB <= 0) {
    throw new RangeError(`${name}.memoryMiB must be a positive safe integer.`);
  }
  if (!Number.isFinite(cpus) || cpus <= 0 || !Number.isSafeInteger(cpuMillis) || cpuMillis < 1 || cpuMillis / 1000 !== cpus) {
    throw new RangeError(`${name}.cpus must be positive with at most three decimal places.`);
  }
  return { memoryMiB, cpuMillis };
}

function amount(value: Units): ResourceAmount {
  return { memoryMiB: value.memoryMiB, cpus: value.cpuMillis / 1000 };
}

function fits(value: Units, maximum: Units): boolean {
  return value.memoryMiB <= maximum.memoryMiB && value.cpuMillis <= maximum.cpuMillis;
}

function validateBounds(request: ResourceRequest, limit: Units): Bounds {
  const minimum = units(request.minimum, 'minimum');
  const preferred = units(request.preferred, 'preferred');
  if (!fits(minimum, preferred)) throw new RangeError('minimum resources must not exceed preferred resources.');
  if (!fits(minimum, limit)) throw new RangeError('minimum resources exceed the worker limit or total resource budget.');
  if (!fits(preferred, limit)) throw new RangeError('preferred resources exceed the worker limit or total resource budget.');
  return { minimum, preferred };
}

function aborted(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Resource acquisition was cancelled.', 'AbortError');
}

/** One scheduler per control plane; the existing workspace lock enforces single ownership. */
export class ResourceScheduler {
  #capacity: Units;
  #workerLimit: Units;
  #defaults: Bounds;
  #running = new Map<string, Active>();
  #waiting: Pending[] = [];

  constructor(config: ResourceSchedulerConfig) {
    this.#capacity = units(config.capacity, 'capacity');
    this.#workerLimit = units(config.workerLimit ?? config.capacity, 'workerLimit');
    if (!fits(this.#workerLimit, this.#capacity)) throw new RangeError('workerLimit must not exceed the total resource budget.');
    this.#defaults = validateBounds(config.defaultRequest, this.#workerLimit);
  }

  async acquire(ownerId: string, options: ResourceAcquireOptions = {}): Promise<ResourceLease> {
    if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('A resource ownerId is required.');
    if (options.signal?.aborted) throw aborted(options.signal);
    if (this.#running.has(ownerId) || this.#waiting.some(item => item.ownerId === ownerId)) {
      throw new Error(`Resource owner ${ownerId} already has an allocation or a pending request.`);
    }
    // Reject impossible minima immediately, never leave an unsatisfiable head in the FIFO.
    const bounds = validateBounds({
      minimum: options.minimum ?? amount(this.#defaults.minimum),
      preferred: options.preferred ?? amount(this.#defaults.preferred),
    }, this.#workerLimit);
    return new Promise<ResourceLease>((resolve, reject) => {
      const pending: Pending = { ownerId, ...bounds, enqueuedAt: new Date().toISOString(), signal: options.signal, resolve, reject };
      if (pending.signal) {
        pending.onAbort = () => {
          const index = this.#waiting.indexOf(pending);
          if (index === -1) return;
          this.#waiting.splice(index, 1);
          this.#detach(pending);
          reject(aborted(pending.signal));
          this.#drain();
        };
        pending.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.#waiting.push(pending);
      this.#drain();
    });
  }

  snapshot(): ResourceSchedulerSnapshot {
    const available = this.#available();
    return {
      capacity: amount(this.#capacity),
      reserved: amount({ memoryMiB: this.#capacity.memoryMiB - available.memoryMiB, cpuMillis: this.#capacity.cpuMillis - available.cpuMillis }),
      available: amount(available),
      running: [...this.#running.values()].map(item => ({ ownerId: item.ownerId, resources: amount(item.resources), minimum: amount(item.minimum), preferred: amount(item.preferred), acquiredAt: item.acquiredAt })),
      waiting: this.#waiting.map(item => ({ ownerId: item.ownerId, minimum: amount(item.minimum), preferred: amount(item.preferred), enqueuedAt: item.enqueuedAt })),
    };
  }

  #available(): Units {
    let memoryMiB = this.#capacity.memoryMiB;
    let cpuMillis = this.#capacity.cpuMillis;
    for (const item of this.#running.values()) {
      memoryMiB -= item.resources.memoryMiB;
      cpuMillis -= item.resources.cpuMillis;
    }
    return { memoryMiB, cpuMillis };
  }

  #detach(pending: Pending): void {
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
  }

  #drain(): void {
    // No awaited work or user callbacks inside accounting mutations.
    while (this.#waiting.length > 0) {
      const next = this.#waiting[0];
      if (next.signal?.aborted) {
        this.#waiting.shift();
        this.#detach(next);
        next.reject(aborted(next.signal));
        continue;
      }
      const available = this.#available();
      if (!fits(next.minimum, available)) return;
      this.#waiting.shift();
      this.#detach(next);
      const active: Active = {
        ownerId: next.ownerId, minimum: next.minimum, preferred: next.preferred,
        resources: {
          memoryMiB: Math.min(next.preferred.memoryMiB, available.memoryMiB),
          cpuMillis: Math.min(next.preferred.cpuMillis, available.cpuMillis),
        },
        acquiredAt: new Date().toISOString(),
      };
      this.#running.set(active.ownerId, active);
      next.resolve(this.#lease(active));
    }
  }

  #lease(active: Active): ResourceLease {
    let released = false;
    return {
      ownerId: active.ownerId,
      get resources() { return amount(active.resources); },
      get released() { return released; },
      tryGrow: target => {
        if (released) return false;
        const desired = units(target, 'target');
        if (!fits(active.resources, desired)) throw new RangeError('A live resource allocation cannot be shrunk.');
        if (!fits(desired, this.#workerLimit)) throw new RangeError('Growth target exceeds the worker limit or total resource budget.');
        const delta = { memoryMiB: desired.memoryMiB - active.resources.memoryMiB, cpuMillis: desired.cpuMillis - active.resources.cpuMillis };
        if (delta.memoryMiB === 0 && delta.cpuMillis === 0) return true;
        // A running worker must not consume capacity needed by an older queued request.
        if (this.#waiting.length > 0 || !fits(delta, this.#available())) return false;
        active.resources = desired;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#running.delete(active.ownerId);
        this.#drain();
      },
    };
  }
}

/** The worker budget excludes Windows, Docker/WSL, and the control-plane process. */
export function readResourceConfig(env: NodeJS.ProcessEnv = process.env): ResourceSchedulerConfig {
  const value = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) throw new RangeError(`${name} must be a positive decimal number.`);
    return Number(raw);
  };
  const capacity = { memoryMiB: value('AGENT_MEMORY_BUDGET_MIB', 4096), cpus: value('AGENT_CPU_BUDGET', 4) };
  const minimum = { memoryMiB: value('AGENT_WORKER_MIN_MEMORY_MIB', 1024), cpus: value('AGENT_WORKER_MIN_CPUS', 1) };
  const workerLimit = { memoryMiB: value('AGENT_WORKER_MAX_MEMORY_MIB', 2048), cpus: value('AGENT_WORKER_MAX_CPUS', 2) };
  const config = { capacity, defaultRequest: { minimum, preferred: { ...workerLimit } }, workerLimit };
  // Reuse the same validation as programmatic callers; no partial or silent fallback.
  new ResourceScheduler(config);
  return config;
}
