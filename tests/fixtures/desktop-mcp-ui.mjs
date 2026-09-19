import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { randomUUID } from 'node:crypto';

// Only public fixture values, no production proxy, model, account or database.
const date = new Date().toISOString(), firstTeam = randomUUID(), secondTeam = randomUUID(), outsideTeam = randomUUID(), project = randomUUID();
const status = { available: true, revision: 0, generationKey: randomUUID(), grants: [], error: null }, requests = [];
let conflict = false, delay = 0;
const team = (id, name) => ({ id, name, description: '', workflow: '', memberIds: [], version: 1, createdAt: date, updatedAt: date });
const deployment = { phase: 'ready', requestedAt: date, readyAt: date, activeRunIds: [], pendingRunCount: 0, reason: null };
const workspace = { desktop: { localMcp: true }, agents: [], teams: [team(firstTeam, '제작팀'), team(secondTeam, '영업팀'), team(outsideTeam, '별도팀')],
  projects: [{ id: project, name: '브랜드 웹 제작', description: '', teamIds: [firstTeam, secondTeam], version: 1, createdAt: date, updatedAt: date }],
  runs: [], memories: [], skills: [], snapshots: [], approvals: [], activities: [], connections: [], deployment,
  runtime: { mode: 'docker', simulation: true, available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: 'UI fixture only' } };
const reply = (res, value, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [{ name: 'desktop-mcp-ui-fixture', configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    if (req.url === '/__fixture') return reply(res, { requests, revision: status.revision, grants: status.grants, firstTeam, secondTeam, outsideTeam, project });
    if (req.url === '/__fixture/conflict') { conflict = true; return reply(res, {}); }
    if (req.url === '/__fixture/delay') { delay = 1500; return reply(res, {}); }
    if (req.url === '/__fixture/restore') { status.generationKey = randomUUID(); return reply(res, {}); }
    if (req.url === '/__fixture/unavailable') { status.available = false; status.error = 'PRIVATE_RAW_DIAGNOSTIC'; return reply(res, {}); }
    if (!req.url.startsWith('/api/')) return next();
    if (req.method === 'GET') {
      if (req.url === '/api/workspace') return reply(res, workspace);
      if (req.url === '/api/desktop/mcp') { requests.push({ method: 'GET' }); return reply(res, status); }
      if (req.url === '/api/deployment') return reply(res, deployment);
      return reply(res, { error: 'Fixture has no auxiliary service' }, 409);
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); requests.push({ method: req.method, url: req.url, body });
    if (delay) { const wait = delay; delay = 0; await new Promise(resolve => setTimeout(resolve, wait)); }
    if (conflict) { conflict = false; status.revision++; return reply(res, { error: 'Fixture revision conflict' }, 409); }
    if (body.revision !== status.revision) return reply(res, { error: 'Fixture stale revision' }, 409);
    if (req.url === '/api/desktop/mcp/grants') {
      const grant = { id: randomUUID(), label: body.label, scope: body.scope, submitTasks: body.submitTasks, budgetTeamId: body.budgetTeamId,
        createdAt: date, revokedAt: null, generationKey: status.generationKey };
      status.grants.push(grant); status.revision++;
      return reply(res, { status, configuration: { mcpServers: { agent_company: { command: 'node.exe', args: ['fixture-bridge.js'], env: { AGENT_COMPANY_MCP_TOKEN: 'A'.repeat(43) } } } } });
    }
    const id = req.url.match(/^\/api\/desktop\/mcp\/grants\/([^/]+)\/revoke$/)?.[1];
    if (id) { const grant = status.grants.find(item => item.id === id); if (grant) grant.revokedAt = date; status.revision++; return reply(res, status); }
    return reply(res, { error: 'Unsupported fixture route' }, 404);
  });
} }, react()], server: { host: '127.0.0.1', port: 0, strictPort: true } });
await server.listen(); console.log(`DESKTOP_MCP_UI ${server.resolvedUrls.local[0]}#settings`);
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
