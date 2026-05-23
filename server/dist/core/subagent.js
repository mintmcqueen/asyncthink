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
/**
 * The v2.6.0 default subagent. Bootstrapped at first server boot via
 * `subagentRegistry.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE])`.
 *
 * Tool set is intentionally narrow: read-only navigation only. Mirrors
 * AsyncThink's plugin-wide invariant that subordinates never edit, exec,
 * or write — the user can always shadow this subagent with a more
 * permissive one via subagent_create if their workflow demands it.
 */
export const DEFAULT_ASYNCTHINK_DELEGATE = {
    id: 'asyncthink-delegate',
    name: 'AsyncThink Delegate',
    description: 'Default delegate persona for claude adapter on subscription auth path. ' +
        'Read-only navigation; focused on the single task in the prompt.',
    prompt: 'You are an AsyncThink delegate worker, spawned by the orchestrator to handle one focused task. ' +
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
export function slugifyName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}
