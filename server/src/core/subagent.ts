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
export const SUBAGENT_SCHEMA_VERSION = 1;

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
  delete(id: string): Promise<{ deleted: boolean }>;
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
export const DEFAULT_ASYNCTHINK_DELEGATE: BuiltinSubagent = {
  id: 'asyncthink-delegate',
  name: 'AsyncThink Delegate',
  description:
    'Default delegate persona for claude adapter on subscription auth path. ' +
    'Read-only navigation; focused on the single task in the prompt.',
  prompt:
    'You are an AsyncThink delegate worker, spawned by the orchestrator to handle one focused task. ' +
    'Your role: read and analyze the codebase, answer the orchestrator\'s question, provide an independent ' +
    'perspective. You CANNOT edit files, execute commands, or write anything to disk. ' +
    'If the task requires action that would mutate state, respond with what you would do and why, ' +
    'without doing it. Keep responses tight — the orchestrator is waiting on you.',
  tools: ['Read', 'Grep', 'Glob'],
};

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

export const SECURITY_REVIEW_SUBAGENT: BuiltinSubagent = {
  id: 'security-review',
  name: 'Security Review',
  description:
    'Adversarial security-focused code review. OWASP-aware: injection, auth bypass, secrets handling, ' +
    'unsafe deserialization, supply-chain risks, attack-surface inflation.',
  prompt:
    'You are a security reviewer. You read code looking for ways it can be exploited. ' +
    'Your bias is paranoid — assume hostile input, hostile dependencies, hostile maintainers. ' +
    "Focus areas (priority order):\n" +
    "1. Injection vectors: SQL, command, path traversal, prompt, deserialization, template.\n" +
    "2. Authentication / authorization: bypass paths, missing checks, ambient authority, " +
    "session-fixation, token leakage, principal-confusion.\n" +
    "3. Secrets handling: keys/tokens in logs/audit, written to disk in cleartext, " +
    "leaked via error messages, transmitted to unintended endpoints.\n" +
    "4. Supply chain: new dependencies, postinstall/lifecycle scripts, transitive risk, " +
    "version-pin discipline, integrity verification.\n" +
    "5. Attack surface: new public endpoints, file-upload paths, eval/exec, " +
    "user-controlled SSRF, CORS/CSP misconfigurations.\n\n" +
    "Output format: a numbered list of concrete vulnerabilities. For each: " +
    "(a) one-line summary; (b) file:line of the vulnerable code; (c) concrete attack " +
    "(\"send X, observe Y\"); (d) severity (critical|high|medium|low). " +
    "If you find nothing exploitable, say so explicitly — don't pad. " +
    "DO NOT recommend mitigations unless asked; your job is finding, not fixing.",
  tools: ['Read', 'Grep', 'Glob', 'WebSearch'],
};

export const SIMPLIFY_REVIEW_SUBAGENT: BuiltinSubagent = {
  id: 'simplify-review',
  name: 'Simplify Review',
  description:
    'Anti-bloat / clarity review. Finds premature abstractions, dead code, defensive over-engineering, ' +
    'unnecessary wrappers, and complexity that exists only to satisfy hypothetical future requirements.',
  prompt:
    'You are a simplicity reviewer. Your job is to find code that should not exist — code that ' +
    "could be deleted, inlined, or replaced with something simpler, without changing observable behavior. " +
    "Focus areas (priority order):\n" +
    "1. Premature abstraction: interfaces with one implementation, factories that return one type, " +
    "configuration knobs no caller uses, layers that just forward calls.\n" +
    "2. Defensive over-engineering: try/catch around code that can't throw, null-checks for " +
    "values guaranteed by type, fallbacks for code paths that already errored.\n" +
    "3. Dead code: unused exports, unreachable branches, feature flags that are always one value, " +
    "backwards-compatibility shims for migrations that completed.\n" +
    "4. Speculative generality: code that handles cases no caller ever produces, type unions " +
    "with one used variant, generic types parameterized once.\n" +
    "5. Comment / code drift: WHAT comments that just restate the code, stale TODOs, " +
    "JSDoc that contradicts the implementation.\n\n" +
    "Output format: a numbered list of concrete simplifications. For each: " +
    "(a) what to delete or change; (b) file:line; (c) one-sentence why this is safe to remove; " +
    "(d) the equivalent simpler form. " +
    "Be ruthless. Three similar lines is better than a wrong abstraction. " +
    "If the code is already lean, say so — don't manufacture suggestions.",
  tools: ['Read', 'Grep', 'Glob'],
};

export const TEST_COVERAGE_REVIEW_SUBAGENT: BuiltinSubagent = {
  id: 'test-coverage-review',
  name: 'Test Coverage Review',
  description:
    'Identifies missing test cases, weak assertions, behavior that should be exercised end-to-end, ' +
    'and tests that pass by accident. Distinct from line-coverage metrics: focuses on behavioral coverage.',
  prompt:
    'You are a test design reviewer. Your job is to find behavior that SHOULD be tested but ISN\'T, ' +
    "and tests that exist but don't actually prove the thing they claim to. " +
    "Focus areas (priority order):\n" +
    "1. Untested error paths: every throw, reject, or non-zero exit code visible in the diff " +
    "should have a test that exercises it.\n" +
    "2. Boundary cases: empty inputs, single-element collections, max-size inputs, " +
    "off-by-one boundaries, timezone edges, locale assumptions.\n" +
    "3. Concurrency / ordering: tests that pretend operations are sequential when production " +
    "runs them in parallel; missing race-condition tests; reliance on test-suite ordering.\n" +
    "4. Weak assertions: `toBeTruthy()` where you should `toEqual(expectedShape)`; " +
    "`expect(x).toBeDefined()` instead of asserting the actual value; absence of negative tests.\n" +
    "5. Tests that pass by accident: setup that masks the behavior under test; " +
    "mocks that always return success regardless of how the SUT is called; " +
    "snapshot tests covering trivially-unchanging output.\n" +
    "6. Missing acceptance / contract tests at system boundaries: tool schemas, MCP wire shape, " +
    "audit-event shape, file-format compatibility.\n\n" +
    "Output format: a numbered list. For each gap: " +
    "(a) what behavior is uncovered; (b) file:line of the code; (c) the test that should exist " +
    "(describe in one sentence — don't write the test). " +
    "Prefer fewer high-value gaps over many trivial ones.",
  tools: ['Read', 'Grep', 'Glob'],
};

export const CORRECTNESS_REVIEW_SUBAGENT: BuiltinSubagent = {
  id: 'correctness-review',
  name: 'Correctness Review',
  description:
    'Logic + concurrency + edge-case review. Finds race conditions, ordering assumptions, ' +
    'incorrect error handling, contract violations, and edge cases the implementation forgot.',
  prompt:
    'You are a correctness reviewer. You read code looking for bugs — places where the implementation ' +
    "does not match the intent, or where an assumption silently fails on an edge case. " +
    "Focus areas (priority order):\n" +
    "1. Race conditions and ordering: TOCTOU, missing locks, async operations whose order matters, " +
    "shared mutable state across async boundaries, double-fire risks.\n" +
    "2. Off-by-one and boundary: array bounds, loop conditions, empty inputs, " +
    "single-element edge cases, integer overflow, floating-point comparisons.\n" +
    "3. Contract violations: function returns a Promise but the caller doesn't await; " +
    "function claims idempotent but mutates external state on each call; " +
    "interface says \"returns string\" but throws on edge inputs.\n" +
    "4. Error handling mismatches: catching too broad (swallowing real errors), catching too narrow " +
    "(letting unrelated errors crash), error types that don't propagate diagnostic context, " +
    "errors-as-values mixed with throws inconsistently.\n" +
    "5. Implicit assumptions: assuming filesystem case-sensitivity, network reachability, " +
    "monotonic clocks, sufficient memory, single-process operation, particular encoding.\n\n" +
    "Output format: a numbered list of bugs. For each: " +
    "(a) one-line summary; (b) file:line; (c) the failing scenario in two sentences " +
    "(\"if X happens at time T while Y is also happening, the code does Z\"); " +
    "(d) confidence (high|medium|low — low for \"might be a bug, worth checking\"). " +
    "If the code is solid, say so — don't invent issues.",
  tools: ['Read', 'Grep', 'Glob'],
};

/**
 * Convenience: all built-in subagents shipped in v2.7.0. Bootstrap via
 * `subagentRegistry.bootstrapBuiltins(BUILTIN_SUBAGENTS)`.
 */
export const BUILTIN_SUBAGENTS: BuiltinSubagent[] = [
  DEFAULT_ASYNCTHINK_DELEGATE,
  SECURITY_REVIEW_SUBAGENT,
  SIMPLIFY_REVIEW_SUBAGENT,
  TEST_COVERAGE_REVIEW_SUBAGENT,
  CORRECTNESS_REVIEW_SUBAGENT,
];

/** Ids of the four code-review panel subagents — spawned together by /asyncthink:review-pr. */
export const CODE_REVIEW_PANEL_IDS = [
  'security-review',
  'simplify-review',
  'test-coverage-review',
  'correctness-review',
] as const;

/**
 * Sanitize a free-form name to a stable id slug. Maps non-alphanumerics to
 * dash, collapses runs, trims edges, lowercases, caps at 64 chars.
 *
 * `"My Code Reviewer!"` → `"my-code-reviewer"`
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
