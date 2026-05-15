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
export interface SweepResult {
    closedThreads: string[];
    reapedTasks: string[];
}
/**
 * Best-effort sweep with rate limiting. Calls more often than once per 30s
 * are no-ops so a flurry of tool calls doesn't spam the filesystem.
 */
export declare function sweepIdleOnce(idleMs?: number): Promise<string[]>;
/** Force a sweep regardless of rate limit. Used by tests and explicit close-all. */
export declare function sweepIdleNow(idleMs: number): Promise<string[]>;
/** Combined sweep entry point — used by Phase 2.5. */
export declare function sweepAll(idleMs?: number, force?: boolean): Promise<SweepResult>;
