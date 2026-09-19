import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentService } from './service.ts';
import type { DesktopMcpCreated, DesktopMcpCreateInput, DesktopMcpStatus } from '../shared/desktop-mcp.ts';
import { openDesktopMcpGrants } from './desktop-mcp-grants.ts';
import { publishDesktopMcpEndpoint } from './desktop-mcp-endpoint.ts';
import { DesktopMcpServiceError, desktopMcpTools } from './desktop-mcp-service.ts';

const revision = z.number().int().nonnegative().safe();
const createSchema = z.object({ revision, label: z.string().trim().min(1).max(100),
  scope: z.object({ type: z.enum(['team', 'project']), id: z.uuid() }).strict(), submitTasks: z.boolean(), budgetTeamId: z.uuid().nullable() }).strict();
const unavailable = '로컬 MCP 구성을 확인하지 못했습니다. 앱 구성을 확인한 뒤 다시 시작할 수 있습니다.';
class McpAccessError extends Error { readonly statusCode = 403; constructor() { super('허용된 로컬 MCP 연결만 사용할 수 있습니다.'); } }
function header(request: FastifyRequest, name: string): string | undefined {
  const raw: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) if (request.raw.rawHeaders[index].toLowerCase() === name) raw.push(request.raw.rawHeaders[index + 1]);
  const value = request.headers[name];
  if (raw.length > 1 || Array.isArray(value) || (value !== undefined && typeof value !== 'string')
    || raw.length !== (value === undefined ? 0 : 1) || (value !== undefined && raw[0] !== value)) throw new McpAccessError();
  return value;
}
export interface DesktopMcpOptions {
  appDataRoot: string; resourceRoot: string; ownerKey: string; generationKey: string;
  generation: () => Promise<string>; origin: () => string | undefined; service: AgentService;
  /** Explicit verification entry only; installed controllers omit this injection. */
  client?: { command: string; args: string[] };
}
export class DesktopMcp {
  private store?: Awaited<ReturnType<typeof openDesktopMcpGrants>>;
  private failure = false;
  private stopping = false;
  private releaseEndpoint?: () => Promise<void>;
  private readonly epoch = randomUUID();
  private readonly endpointFile: string;
  private readonly client: { command: string; args: string[] };
  private constructor(private readonly options: DesktopMcpOptions) {
    this.endpointFile = join(options.appDataRoot, 'desktop-mcp-endpoint.json');
    this.client = options.client ?? { command: process.execPath, args: [join(options.resourceRoot, 'server', 'desktop-mcp-entry.js')] };
  }
  static async open(options: DesktopMcpOptions): Promise<DesktopMcp> {
    const manager = new DesktopMcp(options);
    try {
      const entry = await lstat(manager.client.args.at(-1)!);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1) throw new Error();
      manager.store = await openDesktopMcpGrants(options);
    } catch { manager.failure = true; }
    return manager;
  }
  async publish(): Promise<void> {
    if (!this.store || this.failure || this.stopping) return;
    try {
      const origin = this.options.origin(); if (!origin) throw new Error();
      this.releaseEndpoint = await publishDesktopMcpEndpoint(this.endpointFile,
        { version: 1, ownerKey: this.options.ownerKey, epoch: this.epoch, origin });
    } catch { this.failure = true; }
  }
  async status(): Promise<DesktopMcpStatus> {
    let generationKey = this.options.generationKey;
    try {
      generationKey = await this.options.generation();
      if (!this.store || this.failure || this.stopping) throw new Error();
      const status = await this.store.status();
      return { ...status, generationKey, available: generationKey === this.options.generationKey && Boolean(this.releaseEndpoint),
        error: generationKey !== this.options.generationKey ? '작업실 복원 후 새 연결을 만들려면 앱을 다시 시작해야 합니다.' : null };
    } catch { return { available: false, revision: 0, generationKey, grants: [], error: unavailable }; }
  }
  private requireReady() {
    if (!this.store || this.failure || this.stopping || !this.releaseEndpoint) throw new McpAccessError();
    return this.store;
  }
  async create(raw: unknown): Promise<DesktopMcpCreated> {
    const input: DesktopMcpCreateInput = createSchema.parse(raw), store = this.requireReady();
    if (await this.options.generation() !== this.options.generationKey) throw new McpAccessError();
    await this.options.service.validateDesktopMcpGrantScope({ ...input, generationKey: this.options.generationKey });
    const created = await store.create(input);
    return { status: await this.status(), configuration: { mcpServers: { agent_company: {
      command: this.client.command, args: [...this.client.args, '--endpoint-file', this.endpointFile,
        '--owner-key', this.options.ownerKey, '--grant-id', created.grant.id], env: { AGENT_COMPANY_MCP_TOKEN: created.token },
    } } } };
  }
  async revoke(id: string, input: unknown): Promise<DesktopMcpStatus> {
    const body = z.object({ revision }).strict().parse(input);
    await this.requireReady().revoke({ id: z.uuid().parse(id), revision: body.revision }); return this.status();
  }
  private credentials(request: FastifyRequest) {
    const origin = this.options.origin();
    if (!origin || header(request, 'host') !== origin.slice(7) || header(request, 'origin') !== undefined
      || header(request, 'cookie') !== undefined || header(request, 'sec-fetch-site') !== undefined
      || header(request, 'x-agent-company-epoch') !== this.epoch) throw new McpAccessError();
    const id = header(request, 'x-agent-company-grant');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header(request, 'authorization') ?? '')?.[1];
    if (!z.uuid().safeParse(id).success || !token) throw new McpAccessError();
    return { id: id!, token };
  }
  assertRequest(request: FastifyRequest): void { this.requireReady(); this.credentials(request); }
  async rpc(request: FastifyRequest): Promise<unknown> {
    const store = this.requireReady(), credentials = this.credentials(request);
    const envelope = z.object({ method: z.enum(['tools/list', 'tools/call']), params: z.unknown() }).strict().safeParse(request.body);
    const call = envelope.success && envelope.data.method === 'tools/call'
      ? z.object({ name: z.string().max(100), arguments: z.record(z.string(), z.unknown()).default({}),
        _meta: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(envelope.data.params) : undefined;
    // Admission precedes the FIFO wait, so prepare cannot report ready over an accepted mutation.
    const release = call?.success && call.data.name === 'app_task_create' ? this.options.service.admitExternalRequest() : undefined;
    try { return await store.withGrant(credentials, async grant => {
      if (await this.options.generation() !== grant.generationKey) throw new McpAccessError();
      const error = { error: { code: -32602, message: 'Invalid tool request' } };
      if (!envelope.success) return error;
      if (envelope.data.method === 'tools/list') {
        if (!z.object({ _meta: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(envelope.data.params).success) return error;
        await this.options.service.validateDesktopMcpGrantScope(grant);
        return { result: { tools: desktopMcpTools.filter(tool => tool.name !== 'app_task_create' || grant.submitTasks) } };
      }
      if (!call?.success || !desktopMcpTools.some(tool => tool.name === call.data.name)) return error;
      try {
        const result = await this.options.service.desktopMcp(grant, call.data.name, call.data.arguments);
        return { result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } };
      } catch (error) {
        const failure = error instanceof DesktopMcpServiceError ? error : new DesktopMcpServiceError('MCP_OPERATION_FAILED');
        return { result: { content: [{ type: 'text', text: `${failure.code}: ${failure.message}` }], isError: true } };
      }
    }); } finally { release?.(); }
  }
  private closing?: Promise<void>;
  close(): Promise<void> {
    this.stopping = true;
    return this.closing ??= (async () => { await this.store?.close(); await this.releaseEndpoint?.(); })();
  }
}
