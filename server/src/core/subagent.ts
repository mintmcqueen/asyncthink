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
