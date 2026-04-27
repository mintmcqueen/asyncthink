/**
 * delegate tools — single-subordinate threaded conversation handoff.
 *
 * Registers four tools:
 *   - delegate              (open or continue a thread; optional inline close; optional async)
 *   - delegate_close        (close one thread)
 *   - delegate_close_all    (close every open thread)
 *   - delegate_list_threads (introspection)
 *
 * v2.2: `delegate` gains `async`, `idempotencyKey`, `ttlMs`, `credentials`
 * fields. When `async: true`, the call returns a `{taskId}` envelope and
 * the work runs in the background via the TaskExecutor. The synchronous
 * path is unchanged for callers that omit `async`.
 *
 * Threading discipline reminders are baked into both the tool descriptions
 * and the `reminder` field on every delegate response. Defense-in-depth
 * against thread leakage:
 *   1. inline `close: true` flag for one-round-trip closure
 *   2. explicit delegate_close / delegate_close_all tools
 *   3. idle sweeper at 6h on every tool invocation
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare function registerDelegateTools(server: McpServer): void;
