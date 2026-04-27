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
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { registerAsyncThinkTool } from './tools/asyncthink.tool.js';
import { registerDelegateTools } from './tools/delegate.tool.js';
import { registerConfigTool } from './tools/config.tool.js';
import { migrateV1Ledger } from './migrate.js';
const migration = migrateV1Ledger();
if (migration.warning)
    console.error(migration.warning);
const PKG_VERSION = readPackageVersion();
const server = new McpServer({
    name: 'asyncthink',
    version: PKG_VERSION,
});
registerAsyncThinkTool(server);
registerDelegateTools(server);
registerConfigTool(server);
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[AsyncThink] v${PKG_VERSION} running on stdio`);
    // Best-effort cross-registry validation; warnings only.
    const { validateRegistries } = await import('./app.js');
    await validateRegistries();
}
function readPackageVersion() {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const pkgPath = join(here, '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        return pkg.version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
runServer().catch((error) => {
    console.error('[AsyncThink] Fatal:', error);
    process.exit(1);
});
