import Fastify from 'fastify';
import { z } from 'zod';
import { AgentService, DomainError, type ServiceOptions } from './service.ts';
import { fileScopeSchema, attachmentDisposition } from './files.ts';
import { StorageError } from './storage.ts';
import { MAX_IMPORTED_FILE_BYTES } from '../shared/storage.ts';
import { CollaborationError } from './collaboration.ts';
import { ArtifactPreviewError } from './artifact-preview.ts';
import { registerDashboardResponseDiagnostics } from './dashboard-response-diagnostics.ts';
import type { DesktopAccess } from './desktop-access.ts';
import { DesktopSetupError, type DesktopSetup } from './desktop-setup.ts';
import type { DesktopRuntimeSetup } from './desktop-runtime-setup.ts';
import { desktopRuntimeSelectionSchema } from './desktop-runtime-settings.ts';
import type { DesktopMcp } from './desktop-mcp.ts';

const name = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(100_000);
const ids = z.array(z.uuid()).max(100);
const isDashboardEntry = (url: string) => url === '/' || url === '/index.html';
const agentInput = z.object({
  name, description: z.string().trim().max(2000).optional(), persona: text,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._:/-]+$/).optional(),
  allowWeb: z.boolean().optional(), repositoryIds: ids.optional(),
}).strict();
const memoryInput = z.object({ kind: z.enum(['fact', 'preference', 'procedure']), title: name, content: text }).strict();
const teamInput = z.object({ name, description: z.string().max(2000).optional(), workflow: z.string().max(100_000).optional(), memberIds: ids, autoDiscoverTasks: z.boolean().optional() }).strict();
const nonempty = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.refine((value) => Object.keys(value).length > 0, '변경할 항목이 없습니다.');

export interface AppOptions extends ServiceOptions {
  /** Exact browser origins accepted in addition to the request's loopback origin. */
  allowedOrigins?: string[];
  /** Optional per-launch native WebView access guard; absent for the CLI. */
  desktopAccess?: DesktopAccess;
  desktopSetup?: (admit: () => () => void) => DesktopSetup;
  desktopRuntimeSetup?: (admit: () => () => void) => DesktopRuntimeSetup;
  desktopMcp?: (service: AgentService) => Promise<DesktopMcp>;
  /** Private native-parent control; no corresponding HTTP mutation endpoint. */
  desktopUpdate?: (service: AgentService) => void;
  /** Explicit, bounded diagnostics; never enabled for normal operation. */
  dashboardResponseDiagnostics?: Parameters<typeof registerDashboardResponseDiagnostics>[1];
}

export async function createApp(options: AppOptions) {
  const { desktopAccess, desktopSetup: setupFactory, desktopRuntimeSetup: runtimeSetupFactory, desktopMcp: mcpFactory, desktopUpdate: updateFactory, ...serviceOptions } = options;
  const service = await AgentService.create({ ...serviceOptions, preview: options.preview ?? {
    controllerOrigins: ['http://127.0.0.1:4310', 'http://localhost:4310', ...(options.allowedOrigins ?? ['http://127.0.0.1:5173', 'http://localhost:5173'])],
  } });
  let desktopSetup: DesktopSetup | undefined;
  let desktopRuntimeSetup: DesktopRuntimeSetup | undefined;
  let desktopMcp: DesktopMcp | undefined;
  try {
    updateFactory?.(service);
    desktopSetup = setupFactory?.(() => service.admitExternalRequest());
    desktopRuntimeSetup = runtimeSetupFactory?.(() => service.admitExternalRequest());
    desktopMcp = await mcpFactory?.(service);
  } catch (error) {
    try { await desktopMcp?.close(); await desktopRuntimeSetup?.close(); await desktopSetup?.close(); } finally { await service.close(); }
    throw error;
  }
  const app = Fastify({ logger: false, bodyLimit: 3_000_000 });
  if (options.dashboardResponseDiagnostics) registerDashboardResponseDiagnostics(app, options.dashboardResponseDiagnostics);
  const allowedOrigins = new Set(options.allowedOrigins ?? ['http://127.0.0.1:5173', 'http://localhost:5173']);
  const uploads = new Set<string>();
  const deploymentRoutes = new Set(['/api/health', '/api/workspace', '/api/deployment', '/api/deployment/prepare', '/api/deployment/resume']);
  // An existing login remains counted during deployment preparation; its status/cancel must still work.
  if (desktopSetup) { deploymentRoutes.add('/api/desktop/setup'); deploymentRoutes.add('/api/desktop/setup/cancel'); }
  if (desktopRuntimeSetup) {
    deploymentRoutes.add('/api/desktop/runtime-setup');
    deploymentRoutes.add('/api/desktop/runtime-setup/cancel');
  }
  if (desktopMcp) {
    deploymentRoutes.add('/api/desktop/mcp');
    deploymentRoutes.add('/api/desktop/mcp/rpc');
    deploymentRoutes.add('/api/desktop/mcp/grants/:id/revoke');
  }
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/') || deploymentRoutes.has(route.url)) return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      const release = service.admitExternalRequest();
      try { return await handler.call(this, request, reply); }
      finally { release(); }
    };
  });
  app.addHook('preClose', async () => {
    service.beginClose();
    // Cancel setup before Fastify waits for active HTTP requests to finish.
    // Their final errors are reported again by onClose while retaining DB/installation ownership.
    await Promise.allSettled([desktopRuntimeSetup?.close(), desktopSetup?.close(), desktopMcp?.close()]);
  });
  app.addHook('onClose', async () => {
    const errors: unknown[] = [];
    try { await desktopMcp?.close(); } catch (error) { errors.push(error); }
    try { await desktopRuntimeSetup?.close(); } catch (error) { errors.push(error); }
    try { await desktopSetup?.close(); } catch (error) { errors.push(error); }
    try { await service.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '앱 종료를 확인하지 못했습니다.');
  });
  app.addHook('onSend', async (request, reply) => {
    if (desktopAccess) reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const policy = reply.getHeader('Content-Security-Policy');
    reply.header('X-Frame-Options', 'DENY').header('Content-Security-Policy', `${policy ? `${policy}; ` : ''}frame-ancestors 'none'`);
    if (isDashboardEntry(request.url)) {
      const vary = String(reply.getHeader('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean);
      if (!vary.includes('*')) {
        for (const header of ['Origin', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest']) {
          if (!vary.some(value => value.toLowerCase() === header.toLowerCase())) vary.push(header);
        }
        reply.header('Vary', vary.join(', '));
      }
    }
  });
  app.addHook('onRequest', async (request) => {
    const mcpRpc = Boolean(desktopMcp && request.method === 'POST' && request.url === '/api/desktop/mcp/rpc');
    const mcpRevoke = Boolean(desktopMcp && request.method === 'POST' && /^\/api\/desktop\/mcp\/grants\/[a-f0-9-]{36}\/revoke$/i.test(request.url));
    if (mcpRpc) desktopMcp!.assertRequest(request);
    else desktopAccess?.assert(request);
    // Reject DNS rebinding and cross-site browser requests to this local operator API.
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
      throw new DomainError(403, '로컬 호스트에서만 접근할 수 있습니다.');
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}` && !allowedOrigins.has(origin)) {
      throw new DomainError(403, '허용되지 않은 요청 출처입니다.');
    }
    // A top-level navigation may load the static UI shell, never an API or an embedded document.
    // Use the raw URL so queries and alternate/encoded paths cannot extend this exception.
    const dashboardNavigation = request.method === 'GET' && isDashboardEntry(request.url)
      && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
    if (request.headers['sec-fetch-site'] === 'cross-site' && !dashboardNavigation) throw new DomainError(403, '교차 사이트 요청을 허용하지 않습니다.');
    // MCP reads and grant revocation remain available during a deployment hold.
    // The sole MCP mutation acquires its own admission before waiting on the grant ledger.
    if (!['GET', 'HEAD'].includes(request.method) && !mcpRpc && !mcpRevoke) service.assertWritableRequest();
    if (request.method === 'POST' && request.url.split('?')[0] === '/api/files/import') {
      if (uploads.size >= 2) throw new DomainError(429, '파일 반입 연결이 사용 중입니다. 현재 전송이 끝난 후 다시 처리할 수 있습니다.');
      uploads.add(request.id);
    }
  });
  app.addHook('onResponse', async request => { uploads.delete(request.id); });
  app.addHook('onError', async request => { uploads.delete(request.id); });
  app.addHook('onRequestAbort', async request => { uploads.delete(request.id); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join('.') || '입력'}: ${issue.message}`).join(' · ') });
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof DesktopSetupError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof CollaborationError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof ArtifactPreviewError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof StorageError) return reply.code(error.statusCode).send({ error: error.message });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ error: status >= 500 ? '서버 처리 중 오류가 발생했습니다.' : error instanceof Error ? error.message : '잘못된 요청입니다.' });
  });
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/workspace', async () => ({ ...await service.workspace(), ...(desktopSetup ? {
    desktop: { accountSetup: true, ...(desktopRuntimeSetup ? { runtimeSetup: true } : {}), ...(desktopMcp ? { localMcp: true } : {}) },
  } : {}) }));
  if (desktopMcp) {
    app.get('/api/desktop/mcp', async () => desktopMcp.status());
    app.post('/api/desktop/mcp/grants', { bodyLimit: 16_384 }, async request => desktopMcp.create(request.body));
    app.post('/api/desktop/mcp/grants/:id/revoke', { bodyLimit: 4096 }, async request => desktopMcp.revoke(id(request.params), request.body));
    app.post('/api/desktop/mcp/rpc', { bodyLimit: 256 * 1024 }, async request => desktopMcp.rpc(request));
  }
  if (desktopRuntimeSetup) {
    const runtimeInput = z.object({ revision: z.number().int().nonnegative(), selection: desktopRuntimeSelectionSchema }).strict();
    const recoveryInput = z.object({ revision: z.number().int().nonnegative() }).strict();
    app.get('/api/desktop/runtime-setup', async () => desktopRuntimeSetup.status());
    app.post('/api/desktop/runtime-setup/configure', { bodyLimit: 16_384 }, async request => desktopRuntimeSetup.configure(runtimeInput.parse(request.body)));
    app.post('/api/desktop/runtime-setup/install', { bodyLimit: 16_384 }, async request => desktopRuntimeSetup.install(runtimeInput.parse(request.body)));
    app.post('/api/desktop/runtime-setup/recovery/inspect', { bodyLimit: 4096 }, async request => desktopRuntimeSetup.inspectRecovery(recoveryInput.parse(request.body)));
    app.post('/api/desktop/runtime-setup/recovery/retry', { bodyLimit: 4096 }, async request => desktopRuntimeSetup.recover(recoveryInput.parse(request.body)));
    app.post('/api/desktop/runtime-setup/cancel', { bodyLimit: 4096 }, async request => desktopRuntimeSetup.cancel(z.object({
      revision: z.number().int().nonnegative(),
    }).strict().parse(request.body)));
  }
  if (desktopSetup) {
    const revisionInput = z.object({ revision: z.number().int().nonnegative() }).strict();
    app.get('/api/desktop/setup', async () => desktopSetup.readStatus());
    app.post('/api/desktop/setup/check', async request => desktopSetup.check(revisionInput.parse(request.body).revision));
    app.post('/api/desktop/setup/login', { bodyLimit: 16_384 }, async request => desktopSetup.login(z.discriminatedUnion('method', [
      z.object({ revision: z.number().int().nonnegative(), method: z.literal('chatgptDeviceCode') }).strict(),
      z.object({ revision: z.number().int().nonnegative(), method: z.literal('apiKey'), apiKey: z.string().min(1).max(8192).regex(/^\S+$/) }).strict(),
    ]).parse(request.body)));
    app.post('/api/desktop/setup/cancel', async request => {
      const input = z.object({ revision: z.number().int().nonnegative(), attemptId: z.uuid() }).strict().parse(request.body);
      return desktopSetup.cancel(input.revision, input.attemptId);
    });
    app.post('/api/desktop/setup/logout', async request => desktopSetup.logout(revisionInput.parse(request.body).revision));
  }
  app.get('/api/deployment', async () => service.deploymentStatus());
  app.post('/api/deployment/prepare', async request => {
    z.object({}).strict().parse(request.body);
    return service.prepareDeployment();
  });
  app.post('/api/deployment/resume', async request => {
    z.object({}).strict().parse(request.body);
    return service.resumeDeployment();
  });
  app.post('/api/operator-requests', async (request, reply) => reply.code(201).send(await service.createOperatorRequest(request.body)));
  app.post('/api/operator-requests/from-message', async request => service.promoteOperatorMessage(request.body));
  for (const action of ['revise', 'decide', 'progress', 'withdraw'] as const) {
    app.post(`/api/operator-requests/:id/${action}`, async request => service.updateOperatorRequest(id(request.params), action, request.body));
  }
  app.post('/api/operator-requests/:id/verify', async request => service.verifyOperatorRequest(id(request.params), request.body));
  app.post('/api/operator-requests/:id/consult', async request => service.consultOperatorRequest(id(request.params), request.body));
  app.post('/api/objectives', async (request, reply) => reply.code(201).send(await service.createObjective(request.body)));
  app.patch('/api/objectives/:id', async request => service.updateObjective(id(request.params), request.body));
  app.post('/api/objectives/:id/control', async request => service.controlObjective(id(request.params), request.body));
  app.post('/api/objectives/:id/confirm', async request => service.confirmObjective(id(request.params), request.body));
  app.get('/api/objectives/:id/evaluations/:evaluationId/evidence/:evidenceId', async request => {
    const params = z.object({ id: z.uuid(), evaluationId: z.uuid(), evidenceId: z.string().min(1).max(200) }).parse(request.params);
    return service.objectiveEvidence(params.id, params.evaluationId, params.evidenceId);
  });
  app.post('/api/artifact-previews', async (request, reply) => reply.code(201).send(await service.createArtifactPreview(request.body)));
  app.get('/api/artifact-previews', async request => {
    const query = z.object({ scopeType: z.enum(['team', 'project']), scopeId: z.uuid() }).strict().parse(request.query);
    return service.listArtifactPreviews({ type: query.scopeType, id: query.scopeId });
  });
  app.post('/api/artifact-previews/:id/open', async request => {
    const input = z.object({ entrypoint: z.string().min(1).max(1000).optional() }).strict().parse(request.body ?? {});
    return service.openArtifactPreview(id(request.params), input.entrypoint);
  });
  app.delete('/api/artifact-previews/:id/session', async request => service.closeArtifactPreview(id(request.params)));
  app.post('/api/artifact-previews/:id/feedback', async (request, reply) =>
    reply.code(202).send(await service.sendArtifactPreviewFeedback(id(request.params), request.body)));
  app.get('/api/artifact-previews/:id/download', async (request, reply) => {
    const archive = await service.downloadArtifactPreview(id(request.params));
    return reply.type('application/zip').header('Content-Disposition', attachmentDisposition(archive.path))
      .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').send(archive.bytes);
  });
  app.get('/api/github', async () => service.githubStatus());
  app.post('/api/connections/:id/verify', async request => { z.object({}).strict().parse(request.body ?? {}); return service.verifyConnection(id(request.params)); });
  app.patch('/api/connections/:id', async request => service.updateConnection(id(request.params), request.body));
  app.get('/api/model-budget', async () => service.modelBudgetStatus());
  app.patch('/api/model-budget', async request => service.updateModelBudget(request.body));
  app.post('/api/conversations', async (request, reply) => reply.code(201).send(await service.createConversation(request.body)));
  app.get('/api/conversations/:id', async request => service.getConversation(id(request.params)));
  app.post('/api/conversations/:id/messages', async (request, reply) => reply.code(202).send(await service.sendConversation(id(request.params), request.body)));
  app.post('/api/runs/:id/pause', async request => { z.object({}).strict().parse(request.body ?? {}); return service.pauseRun(id(request.params)); });
  app.post('/api/runs/:id/continue', async request => { z.object({}).strict().parse(request.body ?? {}); return service.resumeRun(id(request.params)); });
  app.get('/api/storage', async () => service.storageStatus());
  app.post('/api/storage/backups', async request => { z.object({}).strict().parse(request.body ?? {}); return service.createBackup(); });
  app.patch('/api/storage/backups/:id', async request => service.pinBackup(id(request.params), z.object({ pinned: z.boolean() }).strict().parse(request.body).pinned));
  app.post('/api/storage/restores', async request => service.prepareRestore(z.object({ backupId: z.uuid() }).strict().parse(request.body).backupId));
  app.post('/api/storage/restores/:id/activate', async request => { z.object({}).strict().parse(request.body ?? {}); return service.activateRestore(id(request.params)); });
  app.post('/api/storage/resume', async request => { z.object({}).strict().parse(request.body ?? {}); return service.resumeStorage(); });
  app.get('/api/files', async request => {
    const query = z.object({ scopeType: z.enum(['agent', 'team', 'project']), scopeId: z.uuid() }).strict().parse(request.query);
    return service.listFiles(fileScopeSchema.parse({ type: query.scopeType, id: query.scopeId }));
  });
  app.post('/api/files/import', { bodyLimit: Math.ceil(MAX_IMPORTED_FILE_BYTES / 3) * 4 + 8192 }, async (request, reply) => reply.code(201).send(await service.importFile(request.body)));
  const attachment = (reply: import('fastify').FastifyReply, file: { bytes: Buffer; path: string }) => reply
    .type('application/octet-stream').header('Content-Disposition', attachmentDisposition(file.path))
    .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').send(file.bytes);
  app.get('/api/files/:id/download', async (request, reply) => attachment(reply, await service.downloadFile(id(request.params))));
  app.get('/api/browser/captures/:id/download', async (request, reply) => attachment(reply, await service.downloadBrowserCapture(id(request.params))));
  app.get('/api/browser/captures/:id/image', async (request, reply) => {
    const file = await service.downloadBrowserCapture(id(request.params));
    return reply.type(file.mediaType).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'none'; sandbox").send(file.bytes);
  });
  app.get('/api/agents/:id/files/download', async (request, reply) => {
    const query = z.object({ path: z.string().min(1).max(1000) }).strict().parse(request.query);
    return attachment(reply, await service.downloadWorkspaceFile(id(request.params), query.path));
  });
  app.post('/api/agents', async (request, reply) => reply.code(201).send(await service.createAgent(agentInput.parse(request.body))));
  app.patch('/api/agents/:id', async (request) => service.updateAgent(id(request.params), nonempty(agentInput.partial().extend({ status: z.enum(['idle', 'paused']).optional() })).parse(request.body)));
  app.post('/api/agents/:id/fork', async (request, reply) => reply.code(201).send(await service.forkAgent(id(request.params), z.object({ name, persona: text.optional(), snapshotId: z.uuid().optional() }).strict().parse(request.body))));
  app.post('/api/agents/:id/snapshots', async (request, reply) => reply.code(201).send(await service.createSnapshot(id(request.params), z.object({ label: name.optional() }).strict().parse(request.body ?? {}).label)));
  app.post('/api/agents/:id/restore', async (request) => service.restoreAgent(id(request.params), z.object({ snapshotId: z.uuid(), restoreMemory: z.boolean().optional(), restoreSkills: z.boolean().optional(), restoreFiles: z.boolean().optional(), restoreEnvironment: z.boolean().optional() }).strict().parse(request.body)));
  app.post('/api/agents/:id/environments', async (request, reply) => reply.code(201).send(await service.proposeEnvironment(id(request.params), request.body)));
  app.post('/api/agents/:id/environments/select', async request => service.selectEnvironment(id(request.params), z.object({ revisionId: z.uuid().nullable() }).strict().parse(request.body).revisionId));
  app.post('/api/environments/:id/cancel', async request => { z.object({}).strict().parse(request.body ?? {}); return service.cancelEnvironment(id(request.params)); });
  app.get('/api/agents/:id/files', async (request) => {
    const query = z.object({ path: z.string().max(1000).default(''), read: z.enum(['true', 'false']).default('false') }).strict().parse(request.query);
    return service.workspaceFiles(id(request.params), query.path, query.read === 'true');
  });
  app.post('/api/collaboration/:operation', async request => {
    const operation = z.object({ operation: z.string().regex(/^[a-z_]+$/).max(50) }).parse(request.params).operation;
    return service.collaboration(operation, request.body ?? {});
  });
  app.post('/api/team-tasks/:id/run', async (request, reply) => {
    const input = z.object({ agentId: z.uuid(), expectedVersion: z.number().int().positive(), budgetProjectId: z.uuid().nullable().optional(), budgetTeamId: z.uuid().nullable().optional() }).strict().parse(request.body);
    return reply.code(202).send(await service.startTeamTask(id(request.params), input.agentId, input.expectedVersion, input.budgetProjectId, input.budgetTeamId));
  });
  app.post('/api/agents/:id/runs', async (request, reply) => {
    const input = z.object({ prompt: text, budgetProjectId: z.uuid().nullable().optional(), budgetTeamId: z.uuid().nullable().optional() }).strict().parse(request.body);
    return reply.code(202).send(await service.startRun(id(request.params), input.prompt, input.budgetProjectId, input.budgetTeamId));
  });
  app.post('/api/runs/:id/cancel', async (request) => service.cancelRun(id(request.params)));
  app.post('/api/runs/:id/resume', async request => { z.object({}).strict().parse(request.body ?? {}); return service.resumeBudgetRun(id(request.params)); });
  app.post('/api/runs/:id/steer', async (request) => service.steerRun(id(request.params), z.object({ message: text }).strict().parse(request.body).message));
  app.post('/api/agents/:id/memories', async (request, reply) => reply.code(201).send(await service.addMemory(id(request.params), memoryInput.parse(request.body))));
  app.patch('/api/memories/:id', async (request) => service.updateMemory(id(request.params), nonempty(memoryInput.partial()).parse(request.body)));
  app.post('/api/agents/:id/skills', async (request, reply) => reply.code(201).send(await service.addSkill(id(request.params), z.object({ name, description: z.string().max(2000), content: text }).strict().parse(request.body))));
  app.post('/api/skills/:id/review', async (request, reply) => reply.code(202).send(await service.reviewSkill(id(request.params),
    z.object({ sourceRunId: z.uuid() }).strict().parse(request.body).sourceRunId)));
  app.post('/api/teams', async (request, reply) => reply.code(201).send(await service.createTeam(teamInput.parse(request.body))));
  app.patch('/api/teams/:id', async (request) => service.updateTeam(id(request.params), nonempty(teamInput.partial()).parse(request.body)));
  app.post('/api/teams/:id/proposals', async (request, reply) => reply.code(201).send(await service.proposeTeam(id(request.params), z.object({ proposedByAgentId: z.uuid(), memberIds: ids, reason: text }).strict().parse(request.body))));
  app.post('/api/approvals/:id/resolve', async (request) => service.resolveApproval(id(request.params), z.object({ approved: z.boolean() }).strict().parse(request.body).approved));
  app.post('/api/connections', async (request, reply) => reply.code(201).send(await service.createConnection(z.object({ repository: z.string().trim().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).max(250), access: z.enum(['read', 'write']) }).strict().parse(request.body))));
  return app;
}
