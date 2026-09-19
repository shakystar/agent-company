import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);
const version = z.number().int().positive();
export const operatorRequestScopeSchema = z.object({ type: z.enum(['agent', 'team', 'project']), id }).strict();
export const operatorRequestLinksSchema = z.object({ objectiveId: id.optional(), taskId: id.optional(),
  environmentRevisionId: id.optional(), messageId: id.optional() }).strict();
export const operatorRequestContentSchema = z.object({ scope: operatorRequestScopeSchema,
  links: operatorRequestLinksSchema.default({}), category: z.enum(['connector', 'environment', 'permission', 'budget', 'other']),
  title: text.max(200), reason: text.max(8000), requestedAction: text.max(4000),
  requestedScope: text.max(8000), verificationCriteria: text.max(4000) }).strict();
export const createOperatorRequestSchema = operatorRequestContentSchema.extend({ idempotencyKey: id }).strict();
export const reviseOperatorRequestSchema = operatorRequestContentSchema.extend({ expectedVersion: version }).strict();
export const decideOperatorRequestSchema = z.object({ expectedVersion: version,
  status: z.enum(['needs_information', 'approved', 'rejected']), reason: text.max(4000) }).strict();
export const progressOperatorRequestSchema = z.object({ expectedVersion: version,
  status: z.enum(['in_progress', 'verification_pending', 'failed']), detail: text.max(4000) }).strict();
/** passed and the provider evidence are supplied by the trusted service after an actual check. */
export const verifyOperatorRequestSchema = z.object({ expectedVersion: version,
  method: z.enum(['github', 'environment', 'manual']), resourceId: id.optional(),
  passed: z.boolean(), evidence: text.max(12000), detail: text.max(4000) }).strict();
export const withdrawOperatorRequestSchema = z.object({ expectedVersion: version, reason: text.max(4000) }).strict();
export const operatorRequestListSchema = z.object({ offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20) }).strict();
export type OperatorRequestScope = z.infer<typeof operatorRequestScopeSchema>;
export type OperatorRequestLinks = z.infer<typeof operatorRequestLinksSchema>;
export type OperatorRequestContent = z.infer<typeof operatorRequestContentSchema>;
export type CreateOperatorRequestInput = z.input<typeof createOperatorRequestSchema>;
export type OperatorRequestActor = { kind: 'operator' } | { kind: 'agent'; agentId: string };
export type OperatorRequestDecisionStatus = 'pending' | 'needs_information' | 'approved' | 'rejected' | 'withdrawn';
export type OperatorRequestProcessingStatus = 'idle' | 'in_progress' | 'verification_pending' | 'verified' | 'failed';
export interface OperatorRequestDecision {
  status: OperatorRequestDecisionStatus; contentVersion: number; reason: string;
  actor: OperatorRequestActor | null; at: string;
}
export interface OperatorRequestProcessing {
  status: OperatorRequestProcessingStatus; detail: string; actor: OperatorRequestActor | null; at: string;
}
export interface OperatorRequestVerification {
  id: string; contentVersion: number; method: 'github' | 'environment' | 'manual';
  resourceId?: string; passed: boolean; evidence: string; detail: string;
  actor: OperatorRequestActor; verifiedAt: string;
}
export interface OperatorRequestHistory {
  id: string; kind: 'created' | 'revised' | 'decision' | 'processing' | 'verification' | 'withdrawn';
  version: number; contentVersion: number; actor: OperatorRequestActor; at: string;
  content?: OperatorRequestContent; decision?: OperatorRequestDecision; processing?: OperatorRequestProcessing;
  verification?: OperatorRequestVerification;
}
export interface OperatorRequest extends OperatorRequestContent {
  id: string; requesterAgentId: string; sourceRunId: string | null; idempotencyKey: string;
  /** Immutable original payload identity, including after revisions. */
  creationHash: string; sourceKey: string | null;
  version: number; contentVersion: number; decision: OperatorRequestDecision;
  processing: OperatorRequestProcessing; verification: OperatorRequestVerification | null;
  resumeReceipts: Array<{ runId: string; continuedRunId?: string; at: string; contentVersion: number; verificationId: string }>; resumeBlockReason: string | null;
  history: OperatorRequestHistory[]; createdAt: string; updatedAt: string;
}

const actorSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('operator') }).strict(),
  z.object({ kind: z.literal('agent'), agentId: id }).strict()]);
const decisionSchema = z.object({ status: z.enum(['pending', 'needs_information', 'approved', 'rejected', 'withdrawn']),
  contentVersion: version, reason: z.string().max(4000), actor: actorSchema.nullable(), at: z.iso.datetime() }).strict();
const processingSchema = z.object({ status: z.enum(['idle', 'in_progress', 'verification_pending', 'verified', 'failed']),
  detail: z.string().max(4000), actor: actorSchema.nullable(), at: z.iso.datetime() }).strict();
const verificationSchema = z.object({ id, contentVersion: version, method: z.enum(['github', 'environment', 'manual']),
  resourceId: id.optional(), passed: z.boolean(), evidence: text.max(12000), detail: text.max(4000), actor: actorSchema,
  verifiedAt: z.iso.datetime() }).strict();
const historySchema = z.object({ id, kind: z.enum(['created', 'revised', 'decision', 'processing', 'verification', 'withdrawn']),
  version, contentVersion: version, actor: actorSchema, at: z.iso.datetime(), content: operatorRequestContentSchema.optional(),
  decision: decisionSchema.optional(), processing: processingSchema.optional(), verification: verificationSchema.optional() }).strict();
export const operatorRequestSchema = operatorRequestContentSchema.extend({ id, requesterAgentId: id,
  sourceRunId: id.nullable(), idempotencyKey: id, creationHash: z.string().regex(/^[a-f0-9]{64}$/), sourceKey: id.nullable(),
  version, contentVersion: version, decision: decisionSchema, processing: processingSchema, verification: verificationSchema.nullable(),
  resumeReceipts: z.array(z.object({ runId: id, continuedRunId: id.optional(), at: z.iso.datetime(),
    contentVersion: version, verificationId: id }).strict()), resumeBlockReason: z.string().max(8000).nullable(),
  history: z.array(historySchema).min(1), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();

export const operatorRequestSchemas = {
  operator_request_create: createOperatorRequestSchema,
  operator_request_list: operatorRequestListSchema,
  operator_request_read: z.object({ requestId: id }).strict(),
  operator_request_revise: reviseOperatorRequestSchema.extend({ requestId: id }).strict(),
  operator_request_withdraw: withdrawOperatorRequestSchema.extend({ requestId: id }).strict(),
};
export type OperatorRequestOperation = keyof typeof operatorRequestSchemas;
const descriptions: Record<OperatorRequestOperation, string> = {
  operator_request_create: 'Ask the operator for a concrete action, target scope, reason and verification criteria. Use a stable idempotencyKey. Approval alone never grants access or resumes work.',
  operator_request_list: 'List your operator requests in scopes you can currently access. Decision and verified processing are separate.',
  operator_request_read: 'Read your operator request and its decision, processing, verification and revision history.',
  operator_request_revise: 'Revise your request with the current expectedVersion. Changed content invalidates earlier approval and verification.',
  operator_request_withdraw: 'Withdraw your own request with the current expectedVersion. This does not cancel related tasks or revoke existing access.',
};
export const operatorRequestTools = (Object.keys(operatorRequestSchemas) as OperatorRequestOperation[])
  .map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(operatorRequestSchemas[name]) }));
