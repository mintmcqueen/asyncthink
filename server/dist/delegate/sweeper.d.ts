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
/**
 * Best-effort sweep with rate limiting. Calls more often than once per 30s
 * are no-ops so a flurry of tool calls doesn't spam the filesystem.
 */
export declare function sweepIdleOnce(idleMs?: number): Promise<string[]>;
/**
 * Force a sweep regardless of rate limit. Used by tests and the explicit
 * close-all path.
 */
export declare function sweepIdleNow(idleMs: number): Promise<string[]>;
