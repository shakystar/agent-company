import type { Run } from '../shared/types.ts';
import type { WorkspaceState } from './store.ts';
import { validOperatorContinuation } from './operator-request-resume.ts';

/** Preserve historical attribution while reading user control from its verified successor. */
export function currentRun(state: WorkspaceState, id: string): Run | undefined {
  const visited = new Set<string>();
  let run = state.runs.find(item => item.id === id);
  while (run?.continuedByRunId) {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    const child = state.runs.find(item => item.id === run!.continuedByRunId);
    if (!child || validOperatorContinuation(state, child)?.id !== run.id) return;
    run = child;
  }
  return run;
}
export function runControlBlocked(state: WorkspaceState, id: string): boolean {
  const run = currentRun(state, id);
  return !run || run.status === 'cancelled' || run.status === 'paused' || Boolean(run.pauseRequestedAt);
}
