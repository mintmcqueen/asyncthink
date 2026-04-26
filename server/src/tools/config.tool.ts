/**
 * asyncthink_config tool — view config, list adapters, list/reload skills.
 *
 * Phase 0: stub. Real implementation lands in Phase 5 with new actions
 * (list_adapters, list_skills, reload_skills) replacing v1's Gemini-specific
 * actions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stubResponse } from './_stub.js';

export function registerConfigTool(server: McpServer): void {
  server.registerTool(
    'asyncthink_config',
    {
      title: 'AsyncThink Configuration',
      description:
        'View and update configuration; list registered adapters and skills. v2 stub.',
      inputSchema: {
        action: z
          .enum(['get', 'set', 'reset', 'list_adapters', 'list_skills', 'reload_skills'])
          .optional(),
      },
    },
    async () => stubResponse('asyncthink_config')
  );
}
