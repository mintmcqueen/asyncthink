/**
 * asyncthink_config tool — adapter, skill, and task introspection.
 *
 * v2.2 surface:
 *   list_adapters    → registered adapters with binary availability +
 *                      env-readiness + tierLimits
 *   list_skills      → all loaded skills with pinsModel + pinIsCurrent
 *   reload_skills    → force re-scan of skill directories
 *   list_tasks       → alias for tasks_list (R4-D.2)
 *   cancel_task      → alias for tasks_cancel (R4-D.2)
 *
 * The general config get/set/reset surface remains reserved for a future
 * persistence layer; v2.2 returns "not yet implemented" for those.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare function registerConfigTool(server: McpServer): void;
