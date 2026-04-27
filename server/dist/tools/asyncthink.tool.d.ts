/**
 * asyncthink tool — sequential thinking + parallel competitor council.
 *
 * Sequential thinking is the wrapping deliberation layer (one thought per
 * tool call). Within each thought the caller can spawn forks: parallel,
 * fire-and-forget invocations of subordinate adapters that come back with
 * independent perspectives. Forks belong to a chain (one chain per
 * server-active thinking session); on the final thought
 * (nextThoughtNeeded:false), all in-flight forks are awaited, all child
 * threads closed, and the chain's task records pruned.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare function registerAsyncThinkTool(server: McpServer): void;
