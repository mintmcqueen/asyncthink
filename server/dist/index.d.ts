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
