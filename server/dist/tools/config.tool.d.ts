/**
 * asyncthink_config tool — adapter and skill introspection.
 *
 * v1 surface:
 *   list_adapters  → registered adapters with binary availability + env-readiness
 *   list_skills    → all loaded skills (plugin + user)
 *   reload_skills  → force re-scan of skill directories
 *
 * The general config get/set/reset surface is reserved for a future
 * persistence layer; v1 returns "not yet implemented" for those.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare function registerConfigTool(server: McpServer): void;
