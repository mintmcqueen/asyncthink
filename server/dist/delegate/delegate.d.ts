/**
 * Delegate — single-subordinate threaded conversation handoff.
 *
 * Opens or continues a thread, dispatches one turn to the named adapter,
 * persists user + assistant turns to the ThreadStore, optionally closes the
 * thread, and returns the response.
 *
 * Resume strategy is per-adapter (declared on the Adapter):
 *  - 'native' adapters (codex): the orchestrator passes the prior assistant
 *    turn's sessionId; the adapter uses its CLI's resume primitive.
 *  - 'replay' adapters (claude, gemini): the orchestrator serializes prior
 *    turns into the prompt itself before invoking.
 *
 * v2.2: optional `async: true` mode (R4-D). When set, the Delegate routes
 * the call through the injected TaskExecutor and returns an AsyncDelegate
 * envelope ({taskId, status: 'working'}) instead of the synchronous
 * DelegateResponse. Callers poll via `tasks/get`, block via `tasks/result`,
 * or cancel via `tasks/cancel`. The synchronous path is unchanged.
 */
import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { Executor } from '../core/executor.js';
import type { IntelligenceTier, ManifestRegistry } from '../core/manifests.js';
import type { TaskExecutor, TaskExecutorState } from '../core/taskExecutor.js';
import type { ThreadStore } from '../core/threadStore.js';
export interface DelegateRequest {
    adapter: string;
    prompt: string;
    threadId?: string;
    files?: string[];
    /** Optional skill id; resolved by SkillRegistry in Phase 4 (ignored here). */
    skill?: string;
    /** If true, close the thread immediately after this turn. */
    close?: boolean;
    /** Optional cwd override; defaults to the server's cwd. */
    cwd?: string;
    /** Optional timeout override in ms. */
    timeoutMs?: number;
    /** Intelligence tier — preferred over raw model id. */
    intelligence?: IntelligenceTier;
    /** Raw model id override (escape hatch); wins over `intelligence`. */
    model?: string;
    /**
     * v2.2 — when true, route through the TaskExecutor and return an
     * AsyncDelegateResponse with `taskId`. Default false (sync path
     * unchanged).
     */
    async?: boolean;
    /**
     * v2.2 — caller-supplied idempotency key; only meaningful when
     * `async: true` (R-DUR-D.3).
     */
    idempotencyKey?: string;
    /**
     * v2.2 — caller-requested TTL in ms (clamped to category cap). Only
     * meaningful when `async: true`.
     */
    ttlMs?: number;
    /**
     * v2.2 — cred profile name. Wire-only stub in v2.2 (R-CRED-D.1); any
     * non-default value is rejected with R-CRED-D.2 error.
     */
    credentials?: string;
    /** Owner principal; null in v2.2 single-tenant local. */
    principal?: string | null;
    /**
     * v2.3 — additive MCP-server allowlist for the adapter spawn (F3-D.2). Merged
     * with the adapter's manifest default. Skills CANNOT remove servers.
     */
    mcpServers?: string[];
    /**
     * v2.3 — auth pre-flight opt-in (R-DIAG-D.4). When 'auth', runs a local
     * probe BEFORE allocating a task row. Only applies in async mode.
     */
    preflight?: 'auth' | 'none';
}
export interface DelegateResponse {
    threadId: string;
    adapter: string;
    output: string;
    sessionId: string;
    closed: boolean;
    turn: number;
    exitCode: number;
    durationMs: number;
    reminder: string;
}
export interface AsyncDelegateResponse {
    /** Task id; pass to `tasks/get`, `tasks/result`, `tasks/cancel`. */
    taskId: string;
    /** Adapter the task was dispatched to. */
    adapter: string;
    /** Initial status — always 'working' immediately after start. */
    status: TaskExecutorState['status'];
    /** Reminder for the orchestrator. */
    reminder: string;
}
export interface AdapterLookup {
    get(id: string): Adapter | undefined;
    list(): Adapter[];
}
export declare class Delegate {
    private readonly adapters;
    private readonly threadStore;
    private readonly executor;
    private readonly auditLog?;
    private readonly taskExecutor?;
    /**
     * v2.3.1 (H1+H2): optional manifest registry. When provided alongside a
     * gate-bearing taskExecutor (LocalInProcessTaskExecutor), sync delegate
     * applies the same rate-limit + auth pre-flight gates that the async path
     * runs in executor.start().
     */
    private readonly manifests?;
    constructor(adapters: AdapterLookup, threadStore: ThreadStore, executor: Executor, auditLog?: AuditLog | undefined, taskExecutor?: TaskExecutor | undefined, 
    /**
     * v2.3.1 (H1+H2): optional manifest registry. When provided alongside a
     * gate-bearing taskExecutor (LocalInProcessTaskExecutor), sync delegate
     * applies the same rate-limit + auth pre-flight gates that the async path
     * runs in executor.start().
     */
    manifests?: ManifestRegistry | undefined);
    /** Synchronous turn — returns the assistant response inline. */
    run(req: DelegateRequest): Promise<DelegateResponse>;
    /**
     * Async turn (v2.2). Routes through the injected TaskExecutor; returns
     * `{taskId, status}` immediately. Subsequent polling/blocking happens via
     * `tasks/get`, `tasks/result`, `tasks/cancel`.
     *
     * Idempotency: if `req.idempotencyKey` is supplied and a non-terminal
     * task with the same `(idempotencyKey, principal)` exists, the existing
     * taskId is returned (R-DUR-D.3).
     */
    runAsync(req: DelegateRequest): Promise<AsyncDelegateResponse>;
}
