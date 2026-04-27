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
 */
import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { Executor } from '../core/executor.js';
import type { IntelligenceTier } from '../core/manifests.js';
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
export interface AdapterLookup {
    get(id: string): Adapter | undefined;
    list(): Adapter[];
}
export declare class Delegate {
    private readonly adapters;
    private readonly threadStore;
    private readonly executor;
    private readonly auditLog?;
    constructor(adapters: AdapterLookup, threadStore: ThreadStore, executor: Executor, auditLog?: AuditLog | undefined);
    run(req: DelegateRequest): Promise<DelegateResponse>;
}
