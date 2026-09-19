import { z } from 'zod';

export const deploymentHoldSchema = z.object({
  version: z.literal(1), id: z.uuid(), requestedAt: z.iso.datetime(), readyAt: z.iso.datetime().nullable(),
}).strict();
export type DeploymentHold = z.infer<typeof deploymentHoldSchema>;
export interface DeploymentStatus {
  phase: 'running' | 'draining' | 'ready' | 'blocked';
  requestedAt: string | null;
  readyAt: string | null;
  activeRunIds: string[];
  pendingRunCount: number;
  reason: string | null;
}
