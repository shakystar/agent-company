import { z } from 'zod';

export interface BudgetAttribution { projectId: string | null; rootRunId: string; teamId?: string | null; agentId?: string }
export interface OperationalBudgetBlock {
  source: 'operational'; blockedBy: 'global' | 'project' | 'team' | 'agent'; projectId: string | null;
  teamId?: string | null; agentId?: string;
  date: string; resetAt: string; reason: string;
}
export interface OperationalBudgetStatus {
  enabled: true; date: string; timezone: 'Asia/Seoul'; resetAt: string; revision: number;
  dailyLimit: number; used: number; remaining: number; projectDailyLimits: Record<string, number | null>;
  projects: Array<{ projectId: string; limit: number | null; used: number; remaining: number | null }>;
  teamDailyLimits?: Record<string, number | null>; agentDailyLimits?: Record<string, number | null>;
  /** Per-scope used includes the corresponding legacyUnattributed count conservatively. */
  teams?: Array<{ teamId: string; limit: number | null; used: number; remaining: number | null }>;
  agents?: Array<{ agentId: string; limit: number | null; used: number; remaining: number | null }>;
  /** Today's records with missing attribution, not explicit teamId:null (no team). */
  legacyUnattributed?: { team: number; agent: number };
  waiting: Array<{ runId: string; projectId: string | null; rootRunId: string;
    teamId?: string | null; agentId?: string;
    blockedBy: 'global' | 'project' | 'team' | 'agent'; reason: string; resetAt: string }>;
}
export const operationalLimit = z.number().int().min(0).max(1_000_000);
export const updateOperationalBudgetSchema = z.object({ expectedRevision: z.number().int().nonnegative(),
  dailyLimit: operationalLimit.optional(), projectDailyLimits: z.record(z.uuid(), operationalLimit.nullable()).optional(),
  teamDailyLimits: z.record(z.uuid(), operationalLimit.nullable()).optional(),
  agentDailyLimits: z.record(z.uuid(), operationalLimit.nullable()).optional(),
}).strict().refine(value => value.dailyLimit !== undefined || value.projectDailyLimits !== undefined
  || value.teamDailyLimits !== undefined || value.agentDailyLimits !== undefined, '변경할 한도가 없습니다.');
export type UpdateOperationalBudgetInput = z.input<typeof updateOperationalBudgetSchema>;
