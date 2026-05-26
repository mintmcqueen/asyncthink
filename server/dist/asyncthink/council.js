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
import { randomUUID } from 'crypto';
/**
 * Default safety ceiling for `endChain`. The expected-wait is much
 * shorter (per-adapter timeouts dominate); this is the absolute outer
 * bound on how long we'll block before returning whatever results we
 * have. Configurable via `defaults.chainEndTimeoutMs` in settings.
 */
export const DEFAULT_CHAIN_END_CEILING_MS = 15 * 60 * 1000;
export class Council {
    taskExecutor;
    taskStore;
    /**
     * AsyncThink-side mapping: `<parentThreadId>::<forkId>` → TaskExecutor taskId.
     * Lets us look up the right task when callers ask by forkId.
     *
     * v2.9.0 — replaces the old `Map<scopedTaskId, Promise<void>>` in-flight
     * tracker. The tasks themselves are the source of truth; this map just
     * records which forkId in which chain each task belongs to.
     */
    fork2task = new Map();
    constructor(taskExecutor, taskStore) {
        this.taskExecutor = taskExecutor;
        this.taskStore = taskStore;
    }
    newChain() {
        return `chain-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    }
    /**
     * Spawn a fork. Returns immediately once the task is registered (status
     * `working` in the TaskStore). The adapter call happens asynchronously
     * inside TaskExecutor.runTask.
     */
    async fork(req) {
        const forkScopedId = this.scopeId(req.parentThreadId, req.id);
        if (this.fork2task.has(forkScopedId)) {
            throw new Error(`Fork id "${req.id}" already exists in chain ${req.parentThreadId}`);
        }
        const state = await this.taskExecutor.start({
            adapter: req.adapter,
            prompt: req.prompt,
            files: req.files,
            intelligence: req.intelligence,
            model: req.model,
            mcpServers: req.mcpServers,
            preflight: req.preflight,
            authPath: req.authPath,
            bypassRateLimit: req.bypassRateLimit,
            subagent: req.subagent,
            principal: null, // v2.2 single-tenant; populated from OAuth in v3.
            detached: false, // Non-detached forks are reaped at chain end.
            threadId: forkScopedId,
            parentChainId: req.parentThreadId,
            skill: req.skill,
        });
        this.fork2task.set(forkScopedId, state.taskId);
    }
    /**
     * Wait for the named forks to settle. Uses `taskExecutor.result` which
     * blocks until terminal — no shared timeout race. The `timeoutMs` arg
     * is preserved as a safety ceiling (same semantics as endChain).
     */
    async waitFor(forkIds, parentThreadId, timeoutMs) {
        const taskIds = forkIds
            .map((id) => this.fork2task.get(this.scopeId(parentThreadId, id)))
            .filter((t) => t !== undefined);
        if (taskIds.length === 0)
            return;
        await Promise.race([
            Promise.allSettled(taskIds.map((tid) => this.taskExecutor.result(tid).catch(() => null))),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
    }
    /**
     * Look up the current state of one fork. Reads from the TaskStore via
     * the executor — non-blocking. Returns undefined if the fork isn't
     * known to this Council instance.
     */
    async getResult(forkId, parentThreadId) {
        const taskId = this.fork2task.get(this.scopeId(parentThreadId, forkId));
        if (!taskId)
            return undefined;
        // We read taskStore directly (not executor.get) because the latter
        // wraps state in TaskExecutorState which drops errorKind /
        // errorActionable. Council surfaces those for the v2.3 R-DIAG-D.5
        // diagnostic envelope. Both share the same underlying FsTaskStore.
        const state = await this.taskStore.get(taskId);
        if (!state)
            return undefined;
        return councilResultFromTaskState(state, forkId);
    }
    /**
     * Snapshot the chain's fork statuses (pending / complete / failed).
     * Reads from in-memory tracking + TaskStore — fast, no awaits except
     * the parallel store reads.
     */
    async chainStatus(parentThreadId) {
        const prefix = `${parentThreadId}::`;
        const pending = [];
        const complete = [];
        const failed = [];
        for (const [scopedId, taskId] of this.fork2task) {
            if (!scopedId.startsWith(prefix))
                continue;
            const forkId = scopedId.slice(prefix.length);
            const state = await this.taskStore.get(taskId);
            if (!state) {
                // Task evaporated (manual delete, TTL sweeper). Treat as failed
                // for diagnostic visibility rather than silently dropping.
                failed.push(forkId);
                continue;
            }
            const status = state.status;
            // Translate from on-disk schema (v1 + v2.2) to the council
            // pending/complete/failed buckets. v1: pending/running/complete/failed.
            // v2.2: working/completed/failed/cancelled/input_required.
            if (status === 'complete' ||
                status === 'completed') {
                complete.push(forkId);
            }
            else if (status === 'failed' ||
                status === 'cancelled') {
                failed.push(forkId);
            }
            else {
                // pending / running / working / input_required → still pending.
                pending.push(forkId);
            }
        }
        return { pending, complete, failed };
    }
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
    async endChain(parentThreadId, ceilingMs = DEFAULT_CHAIN_END_CEILING_MS) {
        const prefix = `${parentThreadId}::`;
        const chainEntries = [...this.fork2task.entries()].filter(([scopedId]) => scopedId.startsWith(prefix));
        // Identify detached vs non-detached forks. Detached survive chain end.
        const nonDetached = [];
        for (const [scopedId, taskId] of chainEntries) {
            const state = await this.taskStore.get(taskId);
            if (!state)
                continue; // Task disappeared; skip silently.
            const detached = state.detached === true;
            if (!detached) {
                nonDetached.push({
                    forkId: scopedId.slice(prefix.length),
                    taskId,
                });
            }
        }
        // Wait for non-detached forks to terminal. Per-task result() resolves
        // independently — one slow fork doesn't hold up the rest.
        if (nonDetached.length > 0) {
            await Promise.race([
                Promise.allSettled(nonDetached.map(({ taskId }) => this.taskExecutor.result(taskId).catch(() => null))),
                new Promise((resolve) => setTimeout(resolve, ceilingMs)),
            ]);
        }
        // Build the result envelope. Read final state from taskStore (gives us
        // errorKind / errorActionable that the executor interface drops).
        const results = [];
        for (const { forkId, taskId } of nonDetached) {
            const state = await this.taskStore.get(taskId);
            if (!state)
                continue;
            const r = councilResultFromTaskState(state, forkId);
            if (r)
                results.push(r);
        }
        // Drop tracking for this chain's non-detached forks. TaskExecutor's
        // sweeper handles the actual task-state cleanup per category TTL.
        for (const { taskId } of nonDetached) {
            for (const [k, v] of this.fork2task) {
                if (v === taskId) {
                    this.fork2task.delete(k);
                    break;
                }
            }
        }
        return results;
    }
    scopeId(parentThreadId, forkId) {
        return `${parentThreadId}::${forkId}`;
    }
}
/**
 * Translate a TaskStore record (v1 + v2.2 fields blended) into the
 * Council's caller-facing shape. CouncilResult.status is kept as the
 * legacy v1 TaskStatus enum (`pending|running|complete|failed`) so
 * existing callers continue to see the same wire shape; v2.2 statuses
 * (`working`/`completed`/`cancelled`/`input_required`) are folded in.
 */
function councilResultFromTaskState(state, forkId) {
    // Status translation — keep the legacy enum on the wire.
    let status = state.status;
    if (state.status === 'completed')
        status = 'complete';
    if (state.status === 'cancelled')
        status = 'failed';
    if (state.status === 'working')
        status = 'running';
    if (state.status === 'input_required')
        status = 'running';
    return {
        id: forkId,
        adapter: state.adapter ?? 'unknown',
        output: state.result ?? '',
        status,
        error: state.error ??
            (state.status === 'cancelled' ? 'cancelled' : undefined),
        durationMs: state.durationMs,
        errorKind: state.errorKind,
        errorActionable: state.errorActionable,
    };
}
// Re-exported for tests/diagnostics that want to project a raw TaskState
// into Council shape without going through the registry.
export { councilResultFromTaskState as __councilResultFromTaskState };
