/**
 * Adapter — uniform contract for invoking a subordinate model CLI.
 *
 * v1: each adapter is implemented as a TS module under ../adapters/impl/<id>.ts
 * (claude, gemini, codex). New adapter = new TS file + manifest in
 * ../adapters/manifests/<id>.json.
 *
 * Invariants:
 *  - readOnly: true. v1 forbids any subordinate from writing/editing.
 *  - All execution flows through Executor (swap point for v3 cloud companion).
 */
import type { Executor } from './executor.js';
import type { IntelligenceTier } from './manifests.js';
export interface AdapterInvocation {
    /** Prompt to send to the subordinate. Adapter encodes file context per its convention. */
    prompt: string;
    /** Absolute paths of files the subordinate may read. */
    files?: string[];
    /**
     * Intelligence tier — selects a model from the adapter's manifest tiers
     * map. Stable across model-name churn; the manifest is the single source
     * of truth that maps tier to current model id.
     */
    intelligence?: IntelligenceTier;
    /** Raw model id override; wins over `intelligence` if supplied. Escape hatch. */
    model?: string;
    /** Opaque continuation token from a prior invocation; enables threaded conversation. */
    sessionId?: string;
    /** Hard wall-clock cap on the subprocess. */
    timeoutMs?: number;
    /** Working directory for the subprocess. Defaults to the MCP server's cwd. */
    cwd?: string;
    /** Extra environment variables to set on the subprocess. */
    env?: Record<string, string>;
    /**
     * v2.3 — additive MCP-server allowlist for adapter spawn (F3-D.2). The
     * adapter merges this with `manifest.mcp.allowlist` and any skill-supplied
     * list, then passes the resolved union to the CLI via its per-CLI flag.
     */
    mcpServers?: string[];
}
export interface AdapterResult {
    /** Plain-text response from the subordinate. */
    text: string;
    /** Continuation token for follow-up invocations on the same thread. */
    sessionId: string;
    /** Adapter-specific raw output (parsed JSON or stdout) for debugging/audit. */
    raw: unknown;
    /** Subprocess exit code. */
    exitCode: number;
    /** Wall-clock duration from spawn to result. */
    durationMs: number;
}
/**
 * How an adapter handles multi-turn continuation:
 *  - 'native': the underlying CLI exposes a session-resume primitive that
 *    we drive via inv.sessionId. The orchestrator passes only the new turn's
 *    prompt; the CLI remembers prior context server-side.
 *  - 'replay': no usable native session API. The orchestrator must serialize
 *    prior turns into the prompt itself (replay strategy) before each call.
 */
export type ResumeStrategy = 'native' | 'replay';
export interface Adapter {
    /** Stable id used in skill manifests, tool args, and audit logs. */
    readonly id: string;
    /** v1 invariant — type-level guarantee that this adapter never writes. */
    readonly readOnly: true;
    /** How this adapter handles cross-invocation continuation. */
    readonly resumeStrategy: ResumeStrategy;
    /**
     * Invoke the subordinate. The adapter is responsible for:
     *  - Building the argv per its CLI's read-only conventions
     *  - Encoding file context per its CLI's convention (--include-dirs, inlined, etc.)
     *  - Translating sessionId into the right resume flag
     *  - Parsing output and surfacing a stable sessionId for the next turn
     */
    invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult>;
}
