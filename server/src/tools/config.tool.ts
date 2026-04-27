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
import { z } from 'zod';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { getManifestRegistry, getSkillRegistry } from '../app.js';

interface AdapterListing {
  id: string;
  displayName: string;
  binary: string;
  binaryPath?: string;
  binaryAvailable: boolean;
  tiers: Record<'high' | 'med' | 'low', string>;
  defaultTier: 'high' | 'med' | 'low';
  defaultTimeoutMs: number;
  envOk: boolean;
  envMissing: string[];
  description?: string;
}

export function registerConfigTool(server: McpServer): void {
  server.registerTool(
    'asyncthink_config',
    {
      title: 'AsyncThink Configuration',
      description:
        'Introspect adapters and skills. Use list_adapters to check availability of subordinate CLIs; list_skills to see what skill ids resolve via the registry; reload_skills after editing a user skill file.',
      inputSchema: {
        action: z
          .enum(['list_adapters', 'list_skills', 'reload_skills', 'get', 'set', 'reset'])
          .describe('Action to perform.'),
      },
    },
    async (args) => {
      const action = args.action;
      let payload: Record<string, unknown>;
      switch (action) {
        case 'list_adapters': {
          const manifests = await getManifestRegistry().loadAll();
          const adapters: AdapterListing[] = manifests.map((m) => {
            const binaryPath = whichSync(m.binary);
            const envMissing = adapterEnvMissing(m.requiredEnv);
            return {
              id: m.id,
              displayName: m.displayName,
              binary: m.binary,
              binaryPath,
              binaryAvailable: !!binaryPath,
              tiers: m.tiers,
              defaultTier: m.defaultTier,
              defaultTimeoutMs: m.defaultTimeoutMs,
              envOk: envMissing.length === 0,
              envMissing,
              description: m.description,
            };
          });
          payload = { adapters };
          break;
        }
        case 'list_skills': {
          const skills = await getSkillRegistry().list();
          payload = {
            skills: skills.map((s) => ({
              name: s.name,
              adapter: s.adapter,
              model: s.model,
              filesGlob: s.filesGlob,
              timeoutMs: s.timeoutMs,
              description: s.description,
              source: s.source,
            })),
          };
          break;
        }
        case 'reload_skills': {
          await getSkillRegistry().reload();
          const skills = await getSkillRegistry().list();
          payload = { reloaded: true, skillCount: skills.length };
          break;
        }
        case 'get':
        case 'set':
        case 'reset':
          payload = {
            status: 'not_implemented',
            note: 'General config persistence ships in v2.1. v1 surface is read-only via list_adapters / list_skills.',
          };
          break;
        default:
          payload = { status: 'error', error: `Unknown action: ${String(action)}` };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );
}

/**
 * Required-env semantics: empty array means none required. Non-empty means
 * AT LEAST ONE of the listed env vars must be set. Returns the list of
 * candidates that are unset (empty if at least one is set).
 */
function adapterEnvMissing(required: string[]): string[] {
  if (required.length === 0) return [];
  const setVars = required.filter((v) => process.env[v] && process.env[v]!.length > 0);
  if (setVars.length > 0) return [];
  return required;
}

function whichSync(bin: string): string | undefined {
  if (bin.includes('/')) {
    return existsSync(bin) ? bin : undefined;
  }
  const PATH = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}
