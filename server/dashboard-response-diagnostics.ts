import type { FastifyInstance } from 'fastify';

interface DashboardRequestRecord {
  timestamp: string;
  requestId: string;
  method: 'GET';
  path: '/' | '/index.html';
}

export type DashboardResponseDiagnosticRecord = DashboardRequestRecord & (
  | {
    event: 'request';
    hasIfNoneMatch: boolean;
    hasIfModifiedSince: boolean;
    hasBrowserAgent: boolean;
    secFetchSite: 'same-origin' | 'same-site' | 'cross-site' | 'none' | 'other' | null;
    secFetchMode: 'navigate' | 'other' | null;
    secFetchDest: 'document' | 'other' | null;
  }
  | {
    event: 'response';
    outcome: 'finished' | 'closed';
    statusCode: number;
    contentType: string | null;
  }
);

export interface DashboardResponseDiagnosticsOptions {
  write: (record: DashboardResponseDiagnosticRecord) => void | Promise<void>;
  maxRequests?: number;
  durationMs?: number;
  now?: () => number;
}

/** Temporary, opt-in observations only. No request or response values are changed. */
export function registerDashboardResponseDiagnostics(
  app: FastifyInstance,
  options: DashboardResponseDiagnosticsOptions,
): { dispose: () => void } {
  const maxRequests = options.maxRequests ?? 40;
  const durationMs = options.durationMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new RangeError('maxRequests must be a positive integer');
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 2_147_483_647) {
    throw new RangeError('durationMs must be a positive timer-safe integer');
  }
  const now = options.now ?? Date.now;
  const deadline = now() + durationMs;
  let active = true;
  let requests = 0;
  const cleanups = new Set<() => void>();
  const dispose = () => {
    active = false;
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  };
  const timer = setTimeout(dispose, durationMs);
  timer.unref();

  const timestamp = (): string | undefined => {
    if (!active) return;
    try {
      const time = now();
      if (time >= deadline) { dispose(); return; }
      return new Date(time).toISOString();
    } catch { dispose(); return; }
  };
  const write = (record: DashboardResponseDiagnosticRecord): boolean => {
    if (!active) return false;
    try {
      // A failed sink must neither reject a Fastify hook nor become an unhandled rejection.
      const result = options.write(record);
      if (result) void Promise.resolve(result).catch(dispose);
      return true;
    } catch { dispose(); return false; }
  };

  app.addHook('onRequest', async (request, reply) => {
    // Do not parse or retain URLs containing a query, fragment, or alternate spelling.
    if (request.method !== 'GET' || (request.url !== '/' && request.url !== '/index.html') || requests >= maxRequests) return;
    const receivedAt = timestamp();
    if (!receivedAt) return;
    // Never trust a client-supplied request ID, even when Fastify is configured to use it.
    const common = { requestId: `dashboard-${++requests}`, method: 'GET' as const, path: request.url as '/' | '/index.html' };
    const secFetchSite = request.headers['sec-fetch-site'];
    const secFetchMode = request.headers['sec-fetch-mode'];
    const secFetchDest = request.headers['sec-fetch-dest'];
    if (!write({
      ...common,
      event: 'request',
      timestamp: receivedAt,
      hasIfNoneMatch: request.headers['if-none-match'] !== undefined,
      hasIfModifiedSince: request.headers['if-modified-since'] !== undefined,
      hasBrowserAgent: request.headers['x-browser-agent'] !== undefined,
      secFetchSite: secFetchSite === undefined ? null
        : secFetchSite === 'same-origin' || secFetchSite === 'same-site' || secFetchSite === 'cross-site' || secFetchSite === 'none'
          ? secFetchSite : 'other',
      secFetchMode: secFetchMode === undefined ? null : secFetchMode === 'navigate' ? 'navigate' : 'other',
      secFetchDest: secFetchDest === undefined ? null : secFetchDest === 'document' ? 'document' : 'other',
    })) return;

    let completed = false;
    const cleanup = () => {
      reply.raw.off('finish', finished);
      reply.raw.off('close', closed);
      cleanups.delete(cleanup);
    };
    const complete = (outcome: 'finished' | 'closed') => {
      if (completed) return;
      completed = true;
      cleanup();
      const completedAt = timestamp();
      if (!completedAt) return;
      // Fastify can pass its headers directly to writeHead; raw.getHeader alone
      // misses those headers on real sockets even when inject() reports them.
      const contentType = reply.getHeader('content-type');
      write({
        ...common,
        event: 'response',
        timestamp: completedAt,
        outcome,
        statusCode: reply.raw.statusCode,
        contentType: typeof contentType === 'string' ? contentType : null,
      });
    };
    const finished = () => complete('finished');
    const closed = () => complete(reply.raw.writableFinished ? 'finished' : 'closed');
    cleanups.add(cleanup);
    reply.raw.once('finish', finished);
    reply.raw.once('close', closed);
  });
  app.addHook('onClose', async () => { dispose(); });
  return { dispose };
}
