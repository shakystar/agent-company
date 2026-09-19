import { z } from 'zod';
import type { AgentService } from './service.ts';

export const desktopUpdateControlSchema = z.object({
  type: z.enum(['prepare-update', 'update-status', 'cancel-update']), updateId: z.uuid(),
}).strict();
export type DesktopUpdateControl = z.infer<typeof desktopUpdateControlSchema>;
export const desktopUpdateStatusSchema = z.object({
  phase: z.enum(['running', 'draining', 'ready', 'blocked']),
  activeRunCount: z.number().int().nonnegative(), pendingRunCount: z.number().int().nonnegative(),
}).strict();
export type DesktopUpdateStatus = z.infer<typeof desktopUpdateStatusSchema>;
export const MAX_DESKTOP_UPDATE_ATTEMPTS = 256;

/** One native update attempt owns one durable deployment hold. No URL, signing
 * key, installer bytes or model authority is accepted over this control pipe. */
export class DesktopUpdatePreparation {
  private active?: { updateId: string; lease: Awaited<ReturnType<AgentService['acquireDesktopUpdate']>> };
  private pending = false;
  private readonly cancelledIds = new Set<string>();
  constructor(private readonly service: Pick<AgentService, 'acquireDesktopUpdate' | 'deploymentStatus' | 'beginClose'>) {}

  beginClose(): void { this.service.beginClose(); }

  async control(raw: DesktopUpdateControl, signal: AbortSignal): Promise<DesktopUpdateStatus> {
    const request = desktopUpdateControlSchema.parse(raw);
    signal.throwIfAborted();
    if (this.pending) throw new Error('DESKTOP_UPDATE_CONTROL_BUSY');
    this.pending = true;
    try {
      if (request.type === 'prepare-update') {
        if (this.active && this.active.updateId !== request.updateId) throw new Error('DESKTOP_UPDATE_NOT_OWNED');
        if (!this.active) {
          // A cancelled identifier cannot acquire a later, unrelated hold.
          if (this.cancelledIds.has(request.updateId)) throw new Error('DESKTOP_UPDATE_ALREADY_CANCELLED');
          if (this.cancelledIds.size >= MAX_DESKTOP_UPDATE_ATTEMPTS) throw new Error('DESKTOP_UPDATE_SESSION_LIMIT');
          const lease = await this.service.acquireDesktopUpdate();
          this.active = { updateId: request.updateId, lease };
        }
      } else if (request.type === 'cancel-update' && !this.active && this.cancelledIds.has(request.updateId)) {
        return this.status(await this.service.deploymentStatus());
      }
      if (!this.active || this.active.updateId !== request.updateId) throw new Error('DESKTOP_UPDATE_NOT_OWNED');
      // Parent EOF/close never resumes work behind a closing application.
      signal.throwIfAborted();
      const current = this.active;
      const status = request.type === 'cancel-update' ? await current.lease.cancel() : await current.lease.status();
      if (request.type === 'cancel-update') {
        this.active = undefined; this.cancelledIds.add(current.updateId);
      }
      return this.status(status);
    } finally { this.pending = false; }
  }

  private status(value: Awaited<ReturnType<AgentService['deploymentStatus']>>): DesktopUpdateStatus {
    return desktopUpdateStatusSchema.parse({ phase: value.phase,
      activeRunCount: value.activeRunIds.length, pendingRunCount: value.pendingRunCount });
  }
}
