#!/usr/bin/env node
/**
 * AsyncThink MCP Server.
 *
 * Registers six tools (sync) plus four task RPC tools (v2.2 async):
 *   asyncthink, delegate, delegate_close, delegate_close_all,
 *   delegate_list_threads, asyncthink_config,
 *   tasks_get, tasks_list, tasks_cancel, tasks_result
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { registerAsyncThinkTool } from './tools/asyncthink.tool.js';
import { registerDelegateTools } from './tools/delegate.tool.js';
import { registerConfigTool } from './tools/config.tool.js';
import { registerTasksTools } from './tools/tasks.tool.js';
import { migrateV1Ledger } from './migrate.js';

const migration = migrateV1Ledger();
if (migration.warning) console.error(migration.warning);

const PKG_VERSION = readPackageVersion();

const server = new McpServer({
  name: 'asyncthink',
  version: PKG_VERSION,
});

registerAsyncThinkTool(server);
registerDelegateTools(server);
registerConfigTool(server);
registerTasksTools(server);

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[AsyncThink] v${PKG_VERSION} running on stdio`);
  // Best-effort cross-registry validation; warnings only.
  const { validateRegistries, bootstrapBuiltins } = await import('./app.js');
  await bootstrapBuiltins();
  await validateRegistries();
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

runServer().catch((error) => {
  console.error('[AsyncThink] Fatal:', error);
  process.exit(1);
});
