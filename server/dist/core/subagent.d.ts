/**
 * v2.6.0 — Subagent: persistent delegation persona for the claude adapter.
 *
 * When the claude adapter spawns `claude --print` on the subscription auth
 * path (the user's authenticated Claude Code session), we pass `--agents
 * '<inline-json>' --agent <name>` so the subordinate runs as a DEDICATED
 * subagent rather than the user's default Claude Code persona. This:
 *
 *   1. Separates the delegate's tools/permissions from the parent session.
 *   2. Gives the delegate a focused system prompt suited to research/review.
 *   3. Surfaces in audit logs as a distinct actor.
 *
 * Subagents persist across MCP-server restarts at:
 *   ~/.local/share/asyncthink/subagents/<sanitized-id>.json
 *
 * Built-in subagent (`asyncthink-delegate`) is materialized on first server
 * boot if missing — see `bootstrapBuiltinSubagents` in stores/.
 */
/** v2.6 schema. Versioned so future migrations are explicit. */
export declare const SUBAGENT_SCHEMA_VERSION = 1;
export interface Subagent {
    /** Stable identifier. Sanitized to alphanumerics + dash for filesystem safety. */
    id: string;
    /** Human-readable display name. */
    name: string;
    /** One-line description; surfaced in subagent_list output. */
    description: string;
    /** System prompt — the persona / role / constraints. */
    prompt: string;
    /**
     * Optional tool allowlist passed to claude --agents. When undefined,
     * the subagent inherits Claude Code's default tool set. For an
     * AsyncThink read-only delegate, we ship the built-in with a narrow
     * read+navigation set.
     */
    tools?: string[];
    /** Optional model pin (e.g., "sonnet", "opus", "claude-sonnet-4-6"). */
    model?: string;
    /** ISO timestamp of creation. */
    createdAt: string;
    /** ISO timestamp of last successful spawn using this subagent. */
    lastUsedAt?: string;
    /** True for plugin-shipped subagents that are bootstrapped on first run. */
    isBuiltIn?: boolean;
    /** Schema version for future migrations. */
    schemaVersion: number;
}
/** Input for creating a new subagent. Server generates id/createdAt. */
export interface SubagentCreateInput {
    /** Display name. id is derived from this (sanitized + slugged). */
    name: string;
    description: string;
    prompt: string;
    tools?: string[];
    model?: string;
}
/** Input for updating an existing subagent. All fields optional patch. */
export interface SubagentUpdateInput {
    name?: string;
    description?: string;
    prompt?: string;
    tools?: string[];
    model?: string;
}
export interface SubagentRegistry {
    list(): Promise<Subagent[]>;
    get(id: string): Promise<Subagent | undefined>;
    create(input: SubagentCreateInput): Promise<Subagent>;
    update(id: string, patch: SubagentUpdateInput): Promise<Subagent>;
    delete(id: string): Promise<{
        deleted: boolean;
    }>;
    /** Bootstrap any missing built-ins. Called once at server boot. */
    bootstrapBuiltins(builtins: BuiltinSubagent[]): Promise<void>;
}
/**
 * Plugin-shipped subagent definition. Bootstrapped on first server boot.
 * If the user has already created a subagent with the same id, the
 * built-in is NOT overwritten — user customizations win.
 */
export interface BuiltinSubagent {
    id: string;
    name: string;
    description: string;
    prompt: string;
    tools?: string[];
    model?: string;
}
/**
 * The v2.6.0 default subagent. Bootstrapped at first server boot via
 * `subagentRegistry.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE])`.
 *
 * Tool set is intentionally narrow: read-only navigation only. Mirrors
 * AsyncThink's plugin-wide invariant that subordinates never edit, exec,
 * or write — the user can always shadow this subagent with a more
 * permissive one via subagent_create if their workflow demands it.
 */
export declare const DEFAULT_ASYNCTHINK_DELEGATE: BuiltinSubagent;
/**
 * v2.7.0 — code-review panel. Four built-in subagents, each with a tight
 * single-axis focus, designed to be spawned in parallel via an asyncthink
 * fork chain. Each is intentionally narrow so the orchestrator gets four
 * non-overlapping perspectives rather than four restatements of the same
 * "looks fine" review.
 *
 * The /asyncthink:review-pr slash command spawns all four against the
 * current branch's diff. Callers can also pin one individually via
 * `delegate({adapter: 'claude', subagent: '<id>', ...})`.
 *
 * All four are read-only — they may navigate, grep, and (optionally)
 * pull external context via WebFetch/WebSearch, but never edit, exec,
 * or write. This mirrors AsyncThink's plugin-wide "subordinates are
 * read-only" invariant.
 */
export declare const SECURITY_REVIEW_SUBAGENT: BuiltinSubagent;
export declare const SIMPLIFY_REVIEW_SUBAGENT: BuiltinSubagent;
export declare const TEST_COVERAGE_REVIEW_SUBAGENT: BuiltinSubagent;
export declare const CORRECTNESS_REVIEW_SUBAGENT: BuiltinSubagent;
/**
 * Convenience: all built-in subagents shipped in v2.7.0. Bootstrap via
 * `subagentRegistry.bootstrapBuiltins(BUILTIN_SUBAGENTS)`.
 */
export declare const BUILTIN_SUBAGENTS: BuiltinSubagent[];
/** Ids of the four code-review panel subagents — spawned together by /asyncthink:review-pr. */
export declare const CODE_REVIEW_PANEL_IDS: readonly ["security-review", "simplify-review", "test-coverage-review", "correctness-review"];
/**
 * v2.8.1 — validate that a string is a safe subagent id (matches what
 * `slugifyName` would produce). Used at READ + WRITE entry points in the
 * registry to defend against path-traversal attacks via caller-supplied
 * `inv.subagent`. Without this check, `inv.subagent = "../../../etc/passwd"`
 * would be normalized by `path.join` and could read arbitrary JSON files.
 *
 * Safe form: 1-64 chars, lowercase alphanumerics + dashes, no leading or
 * trailing dash, no consecutive dashes. Exactly the output shape of
 * `slugifyName`.
 */
export declare function isValidSubagentId(id: string): boolean;
/**
 * Sanitize a free-form name to a stable id slug. Maps non-alphanumerics to
 * dash, collapses runs, trims edges, lowercases, caps at 64 chars.
 *
 * `"My Code Reviewer!"` → `"my-code-reviewer"`
 */
export declare function slugifyName(name: string): string;
