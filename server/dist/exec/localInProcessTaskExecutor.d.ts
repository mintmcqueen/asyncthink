/**
 * LocalInProcessTaskExecutor — v2.2 implementation of the TaskExecutor
 * interface (R3-D.1).
 *
 * Spawns adapter invocations in-process as Promises. Each task is mirrored
 * into the FsTaskStore for debug/audit visibility (R3-D.3). Cancellation
 * goes through `LocalSubprocessExecutor.cancel(taskId)` which sends SIGTERM
 * to the subprocess group (R-DUR-D.5).
 *
 * Implements:
 *   - Idempotency dedup via `(idempotencyKey, principal)` (R-DUR-D.3).
 *   - Pre-flight context-size check per `tierLimits[tier].maxContext`
 *     (R6a-D.2).
 *   - Successor-model substitution for stale pinned models (R6b-D.2).
 *   - Per-tenant principal binding (R-DUR-D.2; v2.2 single-tenant: principal=null).
 *   - Caller-supplied TTLs clamped to category limits (R-DUR-D.4).
 *   - v3-stub: any non-default `credentials` profile is rejected with the
 *     R-CRED-D.2 error.
 *
 * Lifecycle states map to MCP TaskSchema spec strings:
 *   working → completed | failed | cancelled.
 *
 * v3 swap point: RemoteCompanionTaskExecutor with the same interface but
 * dispatching via OAuth-authenticated companion daemon.
 */
import type { Executor } from '../core/executor.js';
import type { ManifestRegistry } from '../core/manifests.js';
import type { ThreadStore } from '../core/threadStore.js';
import { type AdapterLookup, type ExecTaskStatus, type ProgressListener, type TaskExecutor, type TaskExecutorRequest, type TaskExecutorState } from '../core/taskExecutor.js';
import type { AuditLog } from '../core/auditLog.js';
import type { TaskStore } from '../core/taskStore.js';
import { LocalSubprocessExecutor } from './localSubprocess.js';
export interface LocalInProcessTaskExecutorOptions {
    adapters: AdapterLookup;
    executor: LocalSubprocessExecutor | Executor;
    taskStore: TaskStore;
    threadStore?: ThreadStore;
    auditLog?: AuditLog;
    manifests?: ManifestRegistry;
    /** Override clock for tests. */
    now?: () => Date;
}
declare const TERMINAL_STATUSES: ReadonlySet<ExecTaskStatus>;
export declare class LocalInProcessTaskExecutor implements TaskExecutor {
    private readonly adapters;
    private readonly subExec;
    private readonly taskStore;
    private readonly threadStore?;
    private readonly auditLog?;
    private readonly manifests?;
    private readonly now;
    private readonly inflight;
    private readonly progressListeners;
    constructor(opts: LocalInProcessTaskExecutorOptions);
    start(req: TaskExecutorRequest): Promise<TaskExecutorState>;
    get(taskId: string, principal?: string | null): Promise<TaskExecutorState>;
    result(taskId: string, principal?: string | null): Promise<TaskExecutorState>;
    cancel(taskId: string, principal?: string | null): Promise<TaskExecutorState>;
    list(opts?: {
        cursor?: string;
        principal?: string | null;
        limit?: number;
    }): Promise<{
        tasks: TaskExecutorState[];
        nextCursor?: string;
    }>;
    onProgress(taskId: string, cb: ProgressListener): () => void;
    emitProgress(taskId: string, message: string): void;
    sweepIdle(): Promise<string[]>;
    private runTask;
    private boundExecutor;
    private assertPrincipal;
    private recordAudit;
}
export { TERMINAL_STATUSES };
