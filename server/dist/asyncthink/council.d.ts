/**
 * Council — parallel competitor forks for an asyncthink chain.
 *
 * v2.9.0 refactor: forks now dispatch through `TaskExecutor.start()` and
 * Council waits for completion via `taskExecutor.result(taskId)` (which
 * resolves when the task reaches a terminal state — internally event-driven,
 * no shared timeout race). The previous in-flight Promise + shared
 * `Promise.race([allForks, timeout(180s)])` architecture was replaced
 * because a single tight timeout cut off healthy long-running forks
 * (claude haiku panels routinely exceeded the 180s default in playtests).
 *
 * The new model:
 *   - Each fork is a Task in the TaskStore (already was; now uniformly
 *     created via `taskExecutor.start({detached: false})`).
 *   - `Council.endChain()` awaits `taskExecutor.result(taskId)` per
 *     non-detached fork. Each resolves when its adapter's natural
 *     timeline lands (per-adapter `defaultTimeoutMs` still applies as
 *     the per-fork bound).
 *   - A configurable safety ceiling (`ceilingMs`, default 15 minutes via
 *     `defaults.chainEndTimeoutMs`) catches genuine runaway cases.
 *
 * Detached forks (R-DUR-D.1) bypass chain-end as before: they survive
 * past the final thought, are reaped only by category TTL, and are
 * queryable via `tasks_get` / `tasks_result`.
 *
 * Pre-flight gates (R-DIAG-D.4 auth, R6a-D.5 rate-limit) and thread
 * lifecycle (open/close + audit) all happen inside `TaskExecutor.start`
 * + `runTask`. Council no longer needs its own adapter.invoke call site
 * or `CouncilGates` injection — those were duplicated v2.3.1 (H1+H2) work
 * that's now subsumed by the unified task pipeline.
 */
import type { Adapter } from '../core/adapter.js';
import type { IntelligenceTier } from '../core/manifests.js';
import type { TaskState, TaskStatus, TaskStore } from '../core/taskStore.js';
import type { TaskExecutor, TaskExecutorState } from '../core/taskExecutor.js';
export interface AdapterLookup {
    get(id: string): Adapter | undefined;
    list(): Adapter[];
}
export interface ForkRequest {
    id: string;
    adapter: string;
    prompt: string;
    files?: string[];
    intelligence?: IntelligenceTier;
    model?: string;
    /** Skill id; ignored at council level (resolved by tool layer). */
    skill?: string;
    /** Set automatically by tool handler. */
    parentThreadId: string;
    /** Thought number that spawned this fork (audit metadata). */
    thoughtNumber: number;
    /** v2.3 — additive MCP-server allowlist (F3-D.2). */
    mcpServers?: string[];
    /** v2.3 — auth pre-flight opt-in (R-DIAG-D.4). */
    preflight?: 'auth' | 'none';
    /** v2.3.3 — auth-path override for the rate-limit gate. */
    authPath?: string;
    /** v2.3.3 — opt-out of the rate-limit refuse on this fork. */
    bypassRateLimit?: boolean;
    /** v2.7.0 — per-fork subagent override for claude adapter. */
    subagent?: string;
}
export interface ChainStatus {
    pending: string[];
    complete: string[];
    failed: string[];
}
export interface CouncilResult {
    id: string;
    adapter: string;
    output: string;
    status: TaskStatus;
    error?: string;
    durationMs?: number;
    /** v2.3 — typed kind from AdapterError when fork failed (R-DIAG-D.1). */
    errorKind?: string;
    /** v2.3 — actionable next step from AdapterError when fork failed. */
    errorActionable?: string;
}
/**
 * Default safety ceiling for `endChain`. The expected-wait is much
 * shorter (per-adapter timeouts dominate); this is the absolute outer
 * bound on how long we'll block before returning whatever results we
 * have. Configurable via `defaults.chainEndTimeoutMs` in settings.
 */
export declare const DEFAULT_CHAIN_END_CEILING_MS: number;
export declare class Council {
    private readonly taskExecutor;
    private readonly taskStore;
    /**
     * AsyncThink-side mapping: `<parentThreadId>::<forkId>` → TaskExecutor taskId.
     * Lets us look up the right task when callers ask by forkId.
     *
     * v2.9.0 — replaces the old `Map<scopedTaskId, Promise<void>>` in-flight
     * tracker. The tasks themselves are the source of truth; this map just
     * records which forkId in which chain each task belongs to.
     */
    private readonly fork2task;
    constructor(taskExecutor: TaskExecutor, taskStore: TaskStore);
    newChain(): string;
    /**
     * Spawn a fork. Returns immediately once the task is registered (status
     * `working` in the TaskStore). The adapter call happens asynchronously
     * inside TaskExecutor.runTask.
     */
    fork(req: ForkRequest): Promise<void>;
    /**
     * Wait for the named forks to settle. Uses `taskExecutor.result` which
     * blocks until terminal — no shared timeout race. The `timeoutMs` arg
     * is preserved as a safety ceiling (same semantics as endChain).
     */
    waitFor(forkIds: string[], parentThreadId: string, timeoutMs: number): Promise<void>;
    /**
     * Look up the current state of one fork. Reads from the TaskStore via
     * the executor — non-blocking. Returns undefined if the fork isn't
     * known to this Council instance.
     */
    getResult(forkId: string, parentThreadId: string): Promise<CouncilResult | undefined>;
    /**
     * Snapshot the chain's fork statuses (pending / complete / failed).
     * Reads from in-memory tracking + TaskStore — fast, no awaits except
     * the parallel store reads.
     */
    chainStatus(parentThreadId: string): Promise<ChainStatus>;
    /**
     * Wait for non-detached forks in the chain to reach terminal status,
     * then return their results.
     *
     * The safety ceiling (`ceilingMs`) is an absolute outer bound — the
     * expected wait is dominated by per-adapter `defaultTimeoutMs`. Forks
     * resolve naturally on their `taskExecutor.result()` promise; if a
     * fork never terminates (genuine hang), the ceiling unblocks the
     * chain so the caller isn't stuck.
     *
     * Detached forks (R-DUR-D.1) survive past chain end — they're skipped
     * here and reaped via category TTL by the sweeper.
     *
     * Cleanup (closing child threads, reaping codex overlays, deleting
     * task state) happens inside `TaskExecutor.runTask` when each task
     * reaches terminal — Council doesn't repeat that work.
     */
    endChain(parentThreadId: string, ceilingMs?: number): Promise<CouncilResult[]>;
    private scopeId;
}
/**
 * Translate a TaskStore record (v1 + v2.2 fields blended) into the
 * Council's caller-facing shape. CouncilResult.status is kept as the
 * legacy v1 TaskStatus enum (`pending|running|complete|failed`) so
 * existing callers continue to see the same wire shape; v2.2 statuses
 * (`working`/`completed`/`cancelled`/`input_required`) are folded in.
 */
declare function councilResultFromTaskState(state: TaskState, forkId: string): CouncilResult | undefined;
export { councilResultFromTaskState as __councilResultFromTaskState };
export type { TaskExecutorState };
