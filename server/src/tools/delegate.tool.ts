/**
 * delegate tools — single-subordinate threaded conversation handoff.
 *
 * Registers four tools:
 *   - delegate              (open or continue a thread)
 *   - delegate_close        (close one thread)
 *   - delegate_close_all    (close every open thread)
 *   - delegate_list_threads (introspection)
 *
 * Phase 0: all four are stubs. Real impl lands in Phase 2.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stubResponse } from './_stub.js';

export function registerDelegateTools(server: McpServer): void {
  server.registerTool(
    'delegate',
    {
      title: 'Delegate',
      description:
        'Hand a focused task to a single subordinate model CLI. Threads are mandatory; close with delegate_close when done. Read-only. v2 stub.',
      inputSchema: {
        adapter: z.enum(['claude', 'gemini', 'codex']).optional(),
        prompt: z.string().optional(),
        threadId: z.string().optional(),
        files: z.array(z.string()).optional(),
        skill: z.string().optional(),
        close: z.boolean().optional(),
      },
    },
    async () => stubResponse('delegate')
  );

  server.registerTool(
    'delegate_close',
    {
      title: 'Delegate Close',
      description: 'Close a single delegate thread. Idempotent. v2 stub.',
      inputSchema: {
        threadId: z.string().optional(),
      },
    },
    async () => stubResponse('delegate_close')
  );

  server.registerTool(
    'delegate_close_all',
    {
      title: 'Delegate Close All',
      description: 'Close every open delegate thread. End-of-session safety net. v2 stub.',
      inputSchema: {},
    },
    async () => stubResponse('delegate_close_all')
  );

  server.registerTool(
    'delegate_list_threads',
    {
      title: 'Delegate List Threads',
      description: 'List currently open delegate threads with adapter and idle time. v2 stub.',
      inputSchema: {},
    },
    async () => stubResponse('delegate_list_threads')
  );
}
