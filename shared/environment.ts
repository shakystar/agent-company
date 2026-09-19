import { z } from 'zod';

const packageName = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const jsonObject = z.record(z.string().max(200), z.unknown()).refine(value => JSON.stringify(value).length <= 32_768, '도구 입력이 너무 큽니다.');
export const environmentSpecSchema = z.object({
  packages: z.array(z.object({ name: packageName, version: z.string().max(80).regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/) }).strict()).max(10),
  servers: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), package: packageName,
    bin: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
    args: z.array(z.string().max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value))).max(20),
    probe: z.object({ tool: z.string().min(1).max(100), arguments: jsonObject }).strict(),
  }).strict()).max(2),
}).strict().superRefine((spec, ctx) => {
  if (new Set(spec.packages.map(item => item.name)).size !== spec.packages.length) ctx.addIssue({ code: 'custom', message: '중복 패키지입니다.' });
  if (new Set(spec.servers.map(item => item.name)).size !== spec.servers.length) ctx.addIssue({ code: 'custom', message: '중복 MCP 이름입니다.' });
  for (const server of spec.servers) if (!spec.packages.some(item => item.name === server.package)) ctx.addIssue({ code: 'custom', message: 'MCP의 패키지를 고정 버전으로 지정해야 합니다.' });
});
export const environmentProposalSchema = z.object({
  reason: z.string().trim().min(1).max(4000), spec: environmentSpecSchema,
  requestedAccess: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
}).strict();
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>;
export type EnvironmentProposal = z.infer<typeof environmentProposalSchema>;
export interface EnvironmentTool { server: string; name: string; description: string; inputSchema: Record<string, unknown> }
export interface EnvironmentBuildReport {
  imageId: string; contentHash: string; lockfileHash: string;
  packages: Array<{ name: string; version: string }>;
  tools: EnvironmentTool[];
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  createdAt: string;
}
export const environmentBuildReportSchema = z.object({
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/), lockfileHash: z.string().regex(/^[a-f0-9]{64}$/),
  packages: z.array(z.object({ name: packageName, version: z.string().min(1).max(80) }).strict()).max(10),
  tools: z.array(z.object({ server: z.string().max(40), name: z.string().min(1).max(100), description: z.string().max(4000), inputSchema: jsonObject }).strict()).max(100),
  checks: z.array(z.object({ name: z.string().min(1).max(200), passed: z.boolean(), detail: z.string().max(8000) }).strict()).min(1).max(100), createdAt: z.iso.datetime(),
}).strict();
export interface EnvironmentRevision {
  id: string; agentId: string; baseRevisionId: string | null; sourceRevisionId?: string;
  sourceRunId: string | null; buildRunId: string | null;
  reason: string; spec: EnvironmentSpec; requestedAccess: string[];
  status: 'queued' | 'building' | 'ready' | 'failed' | 'blocked' | 'cancelled';
  report?: EnvironmentBuildReport; error: string | null;
  createdAt: string; completedAt: string | null;
}
/** An immutable selection frozen in the Run's persisted input; never contains credentials. */
export interface EnvironmentSelection {
  revisionId: string; buildRunId: string; spec: EnvironmentSpec; report: EnvironmentBuildReport;
}
export interface EnvironmentToolCall { server: string; tool: string; arguments: Record<string, unknown> }
export const environmentCallSchema = z.object({ server: z.string().min(1).max(40), tool: z.string().min(1).max(100), arguments: jsonObject }).strict();
export const environmentTools = [{ name: 'environment_call', description: '현재 실행에 고정된 개인 MCP 도구를 호출합니다. 서버·도구·입력 스키마는 개인 환경 자료에서 확인합니다. 네트워크·계정·개인 파일 권한은 추가되지 않습니다.',
  inputSchema: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'tool', 'arguments'], additionalProperties: false } }];
