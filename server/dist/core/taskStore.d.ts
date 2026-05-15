/**
 * TaskStore — in-flight async worker state.
 *
 * Replaces v1 ledger.json's role: tracks ephemeral worker handles
 * (PID, taskDir, status, timing) for the duration of a council fork.
 * Distinct from ThreadStore, which durably persists conversation transcripts.
 *
 * v1: filesystem-backed at ~/.local/share/asyncthink/tasks/.
 * v3: Firestore.
 *
 * v2.2: schema extended with `detached`, `principal`, `idempotencyKey`,
 * `taskTtlMs`, `lastUpdatedAt`, plus the protocol-spec status set so the
 * record can carry MCP Tasks state directly. Legacy v2.0 statuses
 * ('pending'|'running'|'complete'|'failed') remain valid for backward
 * compatibility with on-disk state from v2.1.x.
 */
/**
 * Status set: superset of legacy v2.0 council-fork statuses + MCP Tasks
 * spec statuses. Council still writes the legacy strings; TaskExecutor
 * writes the spec strings.
 */
export type TaskStatus = 'pending' | 'running' | 'complete' | 'failed' | 'working' | 'input_required' | 'completed' | 'cancelled';
export interface TaskState {
    /** Session-scoped id: SESSION_ID::userProvidedId. */
    id: string;
    topic: string;
    status: TaskStatus;
    /** Working directory for this worker's stdout/stderr files. */
    taskDir: string;
    pid?: number;
    startTime?: string;
    completeTime?: string;
    result?: string;
    error?: string;
    /** Thought number that spawned this fork (asyncthink only). */
    forkThought?: number;
    /** Adapter id this fork dispatched to. */
    adapter?: string;
    /** Wall-clock duration of the underlying adapter invocation. */
    durationMs?: number;
    /**
     * v2.2 — detached forks bypass chain-end cleanup (R-DUR-D.1). Council
     * tasks default to false; delegate-async tasks default to true.
     */
    detached?: boolean;
    /**
     * v2.2 — owner principal. v2 single-tenant local: null. v3 OAuth subject.
     * (R-DUR-D.2)
     */
    principal?: string | null;
    /** v2.2 — caller-supplied idempotency key for dedup. (R-DUR-D.3) */
    idempotencyKey?: string;
    /** v2.2 — effective TTL for this task in ms (after clamping). (R-DUR-D.4) */
    taskTtlMs?: number;
    /** v2.2 — ISO timestamp of the last status change. (R-DUR-D.4) */
    lastUpdatedAt?: string;
    /** v2.2 — parent chain id for council forks. */
    parentChainId?: string;
    /** v2.2 — continuation token from the underlying adapter (for thread chains). */
    sessionId?: string;
    /** v2.2 — substituted-from model id when R6b-D.2 successor substitution kicks in. */
    substitutedFrom?: string;
    /** v2.2 — exit code from the adapter result. */
    exitCode?: number;
    /** v2.3 — typed error kind from AdapterError (R-DIAG-D.1). */
    errorKind?: string;
    /** v2.3 — one-sentence actionable next step from AdapterError (R-DIAG-D.1). */
    errorActionable?: string;
    /** v2.3.1 — structured per-kind details (e.g. capTokens, cap.dim for rate-limit). */
    errorDetails?: Record<string, unknown>;
}
export interface TaskStore {
    /** Allocate a task and return its working directory. */
    create(id: string, topic: string): Promise<string>;
    /** Patch fields on an existing task. */
    update(id: string, patch: Partial<TaskState>): Promise<void>;
    /** Read current state, or undefined if not present. */
    get(id: string): Promise<TaskState | undefined>;
    /** Filter by status (e.g. all 'running'). */
    byStatus(status: TaskStatus): Promise<TaskState[]>;
    /** Remove a task; safe to call on absent ids. */
    delete(id: string): Promise<void>;
    /**
     * Mark orphaned tasks (PIDs that no longer exist) as 'failed'. Returns ids cleaned.
     * v2.3: optional `skip` set protects tasks that are still being cleaned up
     * (R5-D.3); the store still force-deletes past the 30m hard ceiling (R5-D.4).
     */
    cleanupStale(opts?: {
        skip?: Set<string>;
    }): Promise<string[]>;
    /** v2.2 — find non-terminal tasks by `(idempotencyKey, principal)`. (R-DUR-D.3) */
    findByIdempotencyKey?(key: string, principal: string | null): Promise<TaskState | undefined>;
    /** v2.2 — list every task (for executor list + sweep). */
    list?(): Promise<TaskState[]>;
}
/** Statuses that represent a task still in flight. */
export declare const NON_TERMINAL_STATUSES: ReadonlySet<TaskStatus>;
export declare function isTerminal(status: TaskStatus): boolean;
