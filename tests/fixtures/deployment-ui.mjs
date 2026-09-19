import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';

// Independent memory-only fixture. No production proxy, model, worker or database.
const directory = new URL('../../.verification/deployment-ui-20260911/', import.meta.url);
await mkdir(directory, { recursive: true });
const requests = [];
const status = { phase: 'running', requestedAt: null, readyAt: null, activeRunIds: [], pendingRunCount: 3, reason: null };
let prepares = 0, resumes = 0, readyTimer;
const workspace = { agents: [], teams: [], runs: [], memories: [], skills: [], snapshots: [], approvals: [], activities: [], connections: [], projects: [],
  runtime: { mode: 'docker', simulation: true, available: true, authenticated: true, image: 'fixture-old-image', model: 'fixture', version: 'fixture', message: 'No actual models or containers' } };
const reply = (res, body, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [{ name: 'deployment-ui-fixture', configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    if (!req.url.startsWith('/api/')) return next();
    if (req.method === 'GET') {
      if (req.url === '/api/workspace') return reply(res, { ...workspace, deployment: status });
      if (req.url === '/api/deployment') return reply(res, status);
      if (status.phase !== 'running') return reply(res, { error: 'Fixture auxiliary query held for deployment' }, 409);
      if (req.url === '/api/github') return reply(res, { configured: false, writable: false, missing: ['fixture'], repositories: [] });
      if (req.url === '/api/storage') return reply(res, { enabled: false, busy: false, paused: false, reason: null, backups: [], restores: [], lastBackupAt: null,
        usage: { dataBytes: 0, backupBytes: 0, tempBytes: 0, freeBytes: 1e12 }, limits: { dataBytes: 1e9, backupBytes: 1e9, tempBytes: 1e9, minFreeBytes: 0 } });
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    await writeFile(new URL('requests.json', directory), JSON.stringify(requests, null, 2));
    if (req.method === 'POST' && req.url === '/api/deployment/prepare') {
      if (++prepares === 1) return reply(res, { error: 'Fixture prepare response failed' }, 409);
      Object.assign(status, { phase: 'draining', requestedAt: new Date().toISOString(), readyAt: null, activeRunIds: ['worker-one', 'worker-two'] });
      clearTimeout(readyTimer); readyTimer = setTimeout(() => Object.assign(status, { phase: 'ready', readyAt: new Date().toISOString(), activeRunIds: [] }), 12000);
      return reply(res, status);
    }
    if (req.method === 'POST' && req.url === '/api/deployment/resume') {
      if (++resumes === 1) return reply(res, { error: 'Fixture resume response failed' }, 503);
      clearTimeout(readyTimer); Object.assign(status, { phase: 'running', requestedAt: null, readyAt: null, activeRunIds: [] });
      return reply(res, status);
    }
    return reply(res, { error: 'Fixture request unavailable' }, 404);
  });
} }, react()], server: { host: '127.0.0.1', port: 4327, strictPort: true } });
await server.listen(); console.log('DEPLOYMENT_UI_FIXTURE http://127.0.0.1:4327/#settings');
