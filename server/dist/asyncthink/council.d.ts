/**
 * Council — parallel competitor forks for an asyncthink chain.
 *
 * Each chain has a parentThreadId. Forks within the chain are child threads
 * named `<parentThreadId>::<forkId>`. Tasks in the TaskStore use the same
 * scoping so concurrent chains do not collide.
 *
 * Forks are fire-and-forget: `fork()` returns immediately after registering
 * the in-flight promise. Results land in the TaskStore as the adapter
 * promises resolve. Callers retrieve results via `getResult` or block until
 * complete via `waitFor`. On chain end, `endChain` waits for any remaining
 * in-flight forks (up to a timeout), closes all child threads, and prunes
 * the chain's tasks from the store.
 */
import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { Executor } from '../core/executor.js';
import type { IntelligenceTier } from '../core/manifests.js';
import type { TaskStatus, TaskStore } from '../core/taskStore.js';
import type { ThreadStore } from '../core/threadStore.js';
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
    /** Skill id; ignored at council level (resolved by tool layer in Phase 4). */
    skill?: string;
    /** Set automatically by tool handler. */
    parentThreadId: string;
    /** Thought number that spawned this fork. */
    thoughtNumber: number;
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
}
export declare class Council {
    private readonly adapters;
    private readonly threadStore;
    private readonly taskStore;
    private readonly executor;
    private readonly auditLog?;
    private readonly inflight;
    constructor(adapters: AdapterLookup, threadStore: ThreadStore, taskStore: TaskStore, executor: Executor, auditLog?: AuditLog | undefined);
    newChain(): string;
    /** Spawn a fork. Resolves once the task is registered (not when it completes). */
    fork(req: ForkRequest): Promise<void>;
    private runFork;
    /** Wait for any of the named forks (chain-scoped) to settle, up to timeoutMs. */
    waitFor(forkIds: string[], parentThreadId: string, timeoutMs: number): Promise<void>;
    getResult(forkId: string, parentThreadId: string): Promise<CouncilResult | undefined>;
    chainStatus(parentThreadId: string): Promise<ChainStatus>;
    /** Wait for all pending forks in the chain, close child threads, prune tasks. */
    endChain(parentThreadId: string, timeoutMs: number): Promise<CouncilResult[]>;
    private scopeId;
}
