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
import type { IntelligenceTier, ManifestRegistry } from '../core/manifests.js';
import type { TaskStatus, TaskStore } from '../core/taskStore.js';
import type { ThreadStore } from '../core/threadStore.js';
/**
 * v2.3.1 (H1+H2): Council gates injected from the executor singleton so sync
 * forks honor the same rate-limit + auth pre-flight contract that async forks
 * already use. Provided via constructor as an optional dependency so existing
 * tests that don't pass the executor still work.
 */
export interface CouncilGates {
    applyAuthGate(adapter: string, principal: string | null, resolvedModel?: string): void;
    applyRateLimitGate(args: {
        adapter: string;
        prompt: string;
        files?: string[];
        principal: string | null;
        resolvedModel?: string;
        resolvedTier: string;
        rateLimit: NonNullable<NonNullable<import('../core/manifests.js').TierLimits>['rateLimit']>;
    }): Promise<(() => void) | undefined>;
}
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
    /** v2.3 — additive MCP-server allowlist (F3-D.2). */
    mcpServers?: string[];
    /**
     * v2.3 — auth pre-flight opt-in (R-DIAG-D.4). v2.3.1 (H2) wires this
     * through the sync council path via the optional Council gates.
     */
    preflight?: 'auth' | 'none';
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
export declare class Council {
    private readonly adapters;
    private readonly threadStore;
    private readonly taskStore;
    private readonly executor;
    private readonly auditLog?;
    /**
     * v2.3.1 (H1+H2): optional pre-flight gates. When wired (via app.ts),
     * sync forks honor `preflight: 'auth'` and the R6a-D.5 rate-limit refuse.
     * Tests that build Council directly without gates keep working.
     */
    private readonly gates?;
    private readonly manifests?;
    private readonly inflight;
    constructor(adapters: AdapterLookup, threadStore: ThreadStore, taskStore: TaskStore, executor: Executor, auditLog?: AuditLog | undefined, 
    /**
     * v2.3.1 (H1+H2): optional pre-flight gates. When wired (via app.ts),
     * sync forks honor `preflight: 'auth'` and the R6a-D.5 rate-limit refuse.
     * Tests that build Council directly without gates keep working.
     */
    gates?: CouncilGates | undefined, manifests?: ManifestRegistry | undefined);
    newChain(): string;
    /** Spawn a fork. Resolves once the task is registered (not when it completes). */
    fork(req: ForkRequest): Promise<void>;
    private runFork;
    /** Wait for any of the named forks (chain-scoped) to settle, up to timeoutMs. */
    waitFor(forkIds: string[], parentThreadId: string, timeoutMs: number): Promise<void>;
    getResult(forkId: string, parentThreadId: string): Promise<CouncilResult | undefined>;
    chainStatus(parentThreadId: string): Promise<ChainStatus>;
    /**
     * Wait for non-detached forks in the chain, close their child threads,
     * prune their tasks. Detached forks (R-DUR-D.1) are immune: they survive
     * past chain end and are reaped by the TTL sweeper.
     */
    endChain(parentThreadId: string, timeoutMs: number): Promise<CouncilResult[]>;
    private scopeId;
}
