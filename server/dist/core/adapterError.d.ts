/**
 * AdapterError — typed failure envelope for adapter calls.
 *
 * Replaces the v2.2 status quo where adapter failures surfaced as opaque
 * `state.error: string` blobs. Per R-DIAG-D.1 / R-DIAG-D.2, every known
 * failure mode now has a `kind`, a one-sentence `actionable` next step,
 * a one-line `summary` (the .message), and the raw subprocess output
 * preserved for debugging.
 *
 * Per-adapter detector functions live alongside the class. Each adapter's
 * `invoke()` calls its own detector on the raw `ExecResult` and throws on a
 * match. The executor's `runTask` catches and persists `errorKind` +
 * `errorActionable` into `TaskState`.
 *
 * v2.2's `ContextLimitExceededError` is kept as a named subclass (R-DIAG-D.6)
 * so existing `instanceof ContextLimitExceededError` checks continue working.
 */
export type AdapterErrorKind = 'auth' | 'rate-limit' | 'context' | 'network' | 'binary-missing' | 'timeout' | 'silent-failure' | 'unknown';
export interface AdapterErrorRaw {
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs?: number;
}
export interface AdapterErrorOpts {
    kind: AdapterErrorKind;
    adapter: string;
    model?: string;
    actionable: string;
    summary: string;
    raw?: AdapterErrorRaw;
    cause?: unknown;
    /** Optional per-kind metadata (e.g. cap for rate-limit). */
    details?: Record<string, unknown>;
}
export declare class AdapterError extends Error {
    readonly kind: AdapterErrorKind;
    readonly adapter: string;
    readonly model?: string;
    readonly actionable: string;
    readonly summary: string;
    readonly raw?: AdapterErrorRaw;
    readonly details?: Record<string, unknown>;
    constructor(opts: AdapterErrorOpts);
    /**
     * JSON shape for transport. Strips `raw` so audit lines / council outputs
     * stay compact — callers that need raw output read it from TaskState via
     * `tasks_get`.
     */
    toJSON(): Record<string, unknown>;
}
/**
 * Context-limit specialization (R-DIAG-D.6). Keeps the v2.2 class name so
 * `instanceof ContextLimitExceededError` checks in existing code keep working.
 */
export declare class ContextLimitExceededError extends AdapterError {
    readonly approxTokens: number;
    readonly maxTokens: number;
    readonly tier: string;
    constructor(opts: {
        approxTokens: number;
        maxTokens: number;
        tier: string;
        adapter: string;
        model?: string;
    });
}
/**
 * Locate the first balanced JSON object in `s` and parse it. Used by gemini
 * detector to scan stderr (gemini puts error envelopes on stderr) and re-used
 * from `gemini.ts:parseGeminiJson`'s findMatchingBrace logic.
 */
declare function tryExtractFirstJson(s: string): Record<string, unknown> | null;
export declare function detectClaudeError(raw: AdapterErrorRaw, model: string | undefined): AdapterError | null;
export declare function detectGeminiError(raw: AdapterErrorRaw, model: string | undefined): AdapterError | null;
export declare function detectCodexError(raw: AdapterErrorRaw, model: string | undefined): AdapterError | null;
/** Detect ENOENT-class errors from a thrown Error (binary not on PATH). */
export declare function detectBinaryMissing(err: unknown, adapter: string, binary: string): AdapterError | null;
export { tryExtractFirstJson };
