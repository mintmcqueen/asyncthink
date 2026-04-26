#!/usr/bin/env node
/**
 * AsyncThink MCP Server — Phase 0 scaffold.
 *
 * Registers six stub tools:
 *   asyncthink, delegate, delegate_close, delegate_close_all,
 *   delegate_list_threads, asyncthink_config
 *
 * Real implementations land progressively from Phase 1 onward. Until then,
 * every tool returns a v2-in-progress notice. Pin to v1.1.9 for stable
 * behavior in the meantime.
 */

import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerAsyncThinkTool } from './tools/asyncthink.tool.js';
import { registerDelegateTools } from './tools/delegate.tool.js';
import { registerConfigTool } from './tools/config.tool.js';
import { migrateV1Ledger } from './migrate.js';

const migration = migrateV1Ledger();
if (migration.warning) console.error(migration.warning);

const server = new McpServer({
  name: 'asyncthink',
  version: '2.0.0',
});

registerAsyncThinkTool(server);
registerDelegateTools(server);
registerConfigTool(server);

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[AsyncThink] v2.0.0 running on stdio');
}

runServer().catch((error) => {
  console.error('[AsyncThink] Fatal:', error);
  process.exit(1);
});
