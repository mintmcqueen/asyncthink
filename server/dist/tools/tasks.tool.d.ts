/**
 * MCP Tasks RPC tool surface (v2.2 — R2-D.1, R4-D).
 *
 * Wraps the SDK's MCP Tasks protocol primitive (SEP-1686) with user-callable
 * tool aliases:
 *   - tasks_get      → snapshot a task's current status
 *   - tasks_list     → enumerate tasks (cursor-paginated, principal-bound)
 *   - tasks_cancel   → best-effort cancellation (R-DUR-D.5)
 *   - tasks_result   → block until terminal, return the underlying CallToolResult
 *
 * These tools delegate to the singleton `LocalInProcessTaskExecutor` (R3-D.1).
 * The naming convention uses underscores (rather than slashes) so the tools
 * are callable via Claude Code's `mcp__<server>__<tool>` namespace; the SDK
 * itself ALSO auto-wires the wire-level `tasks/get|list|cancel|result` RPC
 * verbs whenever a TaskStore is supplied to the McpServer's options. Both
 * surfaces talk to the same `TaskExecutor` so observable state is identical.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare function registerTasksTools(server: McpServer): void;
