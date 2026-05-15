/**
 * LocalSubprocessExecutor — v1 implementation of the Executor interface.
 *
 * Spawns subprocesses on the local machine via child_process.spawn.
 *
 * v3 swap point: RemoteCompanionExecutor will dispatch ExecRequests to a
 * local companion daemon over an OAuth-authenticated channel. The Executor
 * interface stays identical; only the transport changes.
 *
 * Process-tree kill on timeout: subprocesses are spawned with detached=true
 * so they get their own process group; on timeout we signal the entire group
 * (negative pid) rather than just the immediate child. Avoids leaving
 * grandchildren behind when adapters launch shells that fork further.
 *
 * v2.2 — caller-initiated cancellation (R-DUR-D.5). The TaskExecutor calls
 * `bindTask(taskId, ...)` immediately before each spawn so the inflight
 * subprocess is reachable by external task id. `cancel(taskId)` signals the
 * registered process group with SIGTERM and falls back to SIGKILL after
 * 1s. Idempotent: cancelling an already-finished task is a no-op.
 */
import type { Executor, ExecRequest, ExecResult } from '../core/executor.js';
export declare class LocalSubprocessExecutor implements Executor {
    private readonly inflight;
    /**
     * Set of taskIds the caller has cancelled. We hold cancellation requests
     * until the next spawn for that task arrives — close the race where
     * cancel() is called before the subprocess has spawned.
     */
    private readonly cancelled;
    /**
     * v2.3.1: per-taskId queued onExit callbacks for pre-spawn cancellations.
     * When cancel(taskId, onExit) fires before any spawn, we record the callback
     * here. The spawn path consumes it and arms the listener on the
     * subprocess's `close` event so the audit log gets real signal/exitCode
     * (instead of the bogus `null, null` that the v2.3.0 implementation fired
     * immediately).
     */
    private readonly pendingOnExit;
    run(req: ExecRequest): Promise<ExecResult>;
    /** Bind a taskId to the next spawn. Used by the TaskExecutor. */
    bindNextSpawn(taskId: string): (req: ExecRequest) => Promise<ExecResult>;
    /**
     * Cancel a running task by id (R-DUR-D.5). Best-effort: if the subprocess
     * has not yet spawned, the cancellation is recorded and applied as soon
     * as the spawn happens. If already terminated, the optional `onExit`
     * callback fires immediately with `null` signal + undefined exit code.
     *
     * v2.3 (R5-D.2): optional `onExit` callback fires when the subprocess
     * actually exits (or immediately if no subprocess is running). Lets the
     * TaskExecutor emit `task.terminated` audit events with confirmed exit
     * signal + code.
     */
    cancel(taskId: string, onExit?: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}
