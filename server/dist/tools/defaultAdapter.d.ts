/**
 * v2.5.1 — default adapter resolver.
 *
 * When a caller invokes `delegate` or an `asyncthink` fork WITHOUT both an
 * `adapter` field AND a `skill` (which would pin one via its frontmatter),
 * the tool falls back to `ASYNCTHINK_DEFAULT_ADAPTER`. Useful for users who
 * want to anchor their orchestrator to one subordinate (e.g. gemini-only
 * because they aren't an OpenAI subscriber) without rewriting every tool
 * call.
 *
 * Validation: the env var must be one of `claude`, `gemini`, `codex`. An
 * invalid value emits a one-line stderr warning at first read and behaves
 * as if unset. Empty/absent → undefined; downstream tool handler throws
 * the existing "either adapter or skill must be supplied" error.
 *
 * Caller-supplied adapter ALWAYS wins. Skill-pinned adapter ALWAYS wins.
 * This is purely the "neither was given" fallback.
 */
type ValidAdapter = 'claude' | 'gemini' | 'codex';
/**
 * Returns the env-configured default adapter, or undefined when no valid
 * env var is set. Cached on first read; valid across the lifetime of a
 * single MCP-server process.
 */
export declare function getDefaultAdapter(): ValidAdapter | undefined;
/**
 * Exposed for tests: reset the cache so subsequent calls re-read the env.
 * Do not call from production code.
 */
export declare function __resetDefaultAdapterCache(): void;
export {};
