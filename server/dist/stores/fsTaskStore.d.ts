/**
 * FsTaskStore — filesystem-backed in-flight worker state.
 *
 * Replaces v1 ledger.json. Tracks one record per fork: id, adapter, status,
 * result, error, timestamps. In-memory primary; mirrored to one JSON file
 * per task at ~/.local/share/asyncthink/tasks/<id>.json so a debug session
 * can see the state of recent forks.
 *
 * Unlike v1, v2 forks are in-process Promises (not detached subprocesses),
 * so there is no PID-based stale recovery — if the server dies mid-fork,
 * the in-flight invocation dies with it. The disk mirror is observability
 * only.
 *
 * v2.2 additions:
 *   - `findByIdempotencyKey(key, principal)`: scans non-terminal tasks for
 *     dedup match (R-DUR-D.3).
 *   - `cleanupStale()` reaps tasks whose `lastUpdatedAt` exceeds the
 *     category TTL (R-DUR-D.4): WORKING 60m, COMPLETED 60m, FAILED 10m,
 *     CANCELLED 5m. Returns reaped ids.
 *   - `list()` enumerates every task.
 *   - Atomic disk-mirror updates via write-temp + rename.
 */
import { type TaskState, type TaskStatus, type TaskStore } from '../core/taskStore.js';
export interface FsTaskStoreOptions {
    /** Directory; defaults to ~/.local/share/asyncthink/tasks/. */
    rootDir?: string;
    /** Override clock for tests. */
    now?: () => Date;
}
/** Category-wise sweep TTLs (R-DUR-D.4). All ms. */
export declare const SWEEP_TTL_MS: Record<string, number>;
/**
 * v2.3 (R5-D.4): hard ceiling on the "skip while subprocess is cancelling"
 * protection. Past this age, the sweeper force-deletes the cancelled task
 * even if its subprocess hasn't confirmed exit (and the executor will emit
 * `task.terminated` with `signal: 'orphaned'`).
 */
export declare const CANCELLING_HARD_CEILING_MS: number;
export declare class FsTaskStore implements TaskStore {
    private readonly rootDir;
    private readonly mem;
    private readonly now;
    constructor(opts?: FsTaskStoreOptions);
    create(id: string, topic: string): Promise<string>;
    update(id: string, patch: Partial<TaskState>): Promise<void>;
    get(id: string): Promise<TaskState | undefined>;
    byStatus(status: TaskStatus): Promise<TaskState[]>;
    list(): Promise<TaskState[]>;
    delete(id: string): Promise<void>;
    findByIdempotencyKey(key: string, principal: string | null): Promise<TaskState | undefined>;
    /**
     * Reap tasks whose `lastUpdatedAt` (or `startTime` fallback) exceeds the
     * per-category TTL. Removes from memory and disk. Returns reaped ids.
     *
     * v2.3 (R5-D.3): `opts.skip` protects in-flight-cancelling tasks from
     * deletion while their subprocess hasn't confirmed exit. Skipped tasks are
     * still subject to the hard ceiling (R5-D.4) — past 30 minutes in the
     * skip set, the sweeper force-deletes anyway.
     */
    cleanupStale(opts?: {
        skip?: Set<string>;
    }): Promise<string[]>;
    /**
     * Optional helper for tests / debugging: reload all tasks from disk into
     * memory. Used to recover state when reattaching to an existing dir.
     */
    reloadFromDisk(): void;
    private path;
    private persist;
}
