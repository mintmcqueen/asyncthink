/**
 * Idle thread sweeper — closes threads that have gone stale.
 *
 * Called on every delegate-tool invocation so leakage is bounded by the idle
 * threshold even if Claude forgets to close. The sweeper itself is cheap
 * (one directory listing, mtime checks); the cost only rises if many threads
 * are actually stale, which is exactly the case where sweeping pays off.
 *
 * Default threshold: 6 hours. Made overridable for tests (zero idle =
 * "close everything not currently being written").
 */

import { getThreadStore } from '../app.js';

const DEFAULT_IDLE_MS = 6 * 60 * 60 * 1000;

let lastSweepAt = 0;
const MIN_SWEEP_INTERVAL_MS = 30_000;

/**
 * Best-effort sweep with rate limiting. Calls more often than once per 30s
 * are no-ops so a flurry of tool calls doesn't spam the filesystem.
 */
export async function sweepIdleOnce(idleMs: number = DEFAULT_IDLE_MS): Promise<string[]> {
  const now = Date.now();
  if (now - lastSweepAt < MIN_SWEEP_INTERVAL_MS) return [];
  lastSweepAt = now;
  try {
    return await getThreadStore().sweepIdle(idleMs);
  } catch {
    // Sweeper failures must never break a tool call.
    return [];
  }
}

/**
 * Force a sweep regardless of rate limit. Used by tests and the explicit
 * close-all path.
 */
export async function sweepIdleNow(idleMs: number): Promise<string[]> {
  lastSweepAt = Date.now();
  return getThreadStore().sweepIdle(idleMs);
}
