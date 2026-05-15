/**
 * Idle thread + task sweeper — closes threads that have gone stale and reaps
 * tasks whose `lastUpdatedAt` exceeds their per-category TTL.
 *
 * Called on every tool invocation so leakage is bounded by the idle
 * threshold even if the orchestrator forgets to close. The sweeper itself
 * is cheap (one directory listing for threads, an in-memory walk for tasks);
 * the cost only rises if many entries are actually stale, which is exactly
 * the case where sweeping pays off.
 *
 * Default thread idle threshold: 6 hours. Made overridable for tests (zero
 * idle = "close everything not currently being written").
 *
 * v2.2: extends to also call `taskStore.cleanupStale()` (R-DUR-D.4) which
 * applies category-wise TTLs (working 60m, completed 60m, failed 10m,
 * cancelled 5m). Same 30s rate-limit on combined sweeps.
 */

import { getTaskExecutor, getThreadStore } from '../app.js';

const DEFAULT_IDLE_MS = 6 * 60 * 60 * 1000;

let lastSweepAt = 0;
const MIN_SWEEP_INTERVAL_MS = 30_000;

export interface SweepResult {
  closedThreads: string[];
  reapedTasks: string[];
}

/**
 * Best-effort sweep with rate limiting. Calls more often than once per 30s
 * are no-ops so a flurry of tool calls doesn't spam the filesystem.
 */
export async function sweepIdleOnce(idleMs: number = DEFAULT_IDLE_MS): Promise<string[]> {
  const r = await sweepBoth(idleMs, false);
  return r.closedThreads;
}

/** Force a sweep regardless of rate limit. Used by tests and explicit close-all. */
export async function sweepIdleNow(idleMs: number): Promise<string[]> {
  const r = await sweepBoth(idleMs, true);
  return r.closedThreads;
}

/** Combined sweep entry point — used by Phase 2.5. */
export async function sweepAll(
  idleMs: number = DEFAULT_IDLE_MS,
  force = false
): Promise<SweepResult> {
  return sweepBoth(idleMs, force);
}

async function sweepBoth(idleMs: number, force: boolean): Promise<SweepResult> {
  const now = Date.now();
  if (!force && now - lastSweepAt < MIN_SWEEP_INTERVAL_MS) {
    return { closedThreads: [], reapedTasks: [] };
  }
  lastSweepAt = now;
  let closedThreads: string[] = [];
  let reapedTasks: string[] = [];
  try {
    closedThreads = await getThreadStore().sweepIdle(idleMs);
  } catch {
    // Sweeper failures must never break a tool call.
  }
  try {
    // v2.3.1 (B3): route through the executor's sweepIdle() so the in-memory
    // `cancelling` set actually protects in-flight cancellations from premature
    // deletion (R5-D.3) and the 30m hard ceiling (R5-D.4) fires `task.terminated`
    // with signal:'orphaned' (R5-D.5) instead of a generic `task.expire`.
    // Direct `taskStore.cleanupStale()` was bypassing all three of those.
    reapedTasks = await getTaskExecutor().sweepIdle();
  } catch {
    // ditto
  }
  return { closedThreads, reapedTasks };
}
