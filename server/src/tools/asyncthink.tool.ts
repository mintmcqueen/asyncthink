/**
 * asyncthink tool — sequential thinking + parallel competitor council.
 *
 * Phase 0: stub. Real implementation lands in Phase 3 (council) backed by
 * Phase 1 adapters and Phase 2 thread/task stores.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stubResponse } from './_stub.js';

export function registerAsyncThinkTool(server: McpServer): void {
  server.registerTool(
    'asyncthink',
    {
      title: 'AsyncThink',
      description:
        'Sequential thinking with optional parallel forks to subordinate model CLIs (gemini, codex, claude). Read-only. v2 stub.',
      inputSchema: {
        thought: z.string().optional(),
        nextThoughtNeeded: z.boolean().optional(),
        thoughtNumber: z.number().int().min(1).optional(),
        totalThoughts: z.number().int().min(1).optional(),
      },
    },
    async () => stubResponse('asyncthink')
  );
}
