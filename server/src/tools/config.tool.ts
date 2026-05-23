/**
 * asyncthink_config tool — adapter, skill, and task introspection.
 *
 * v2.2 surface:
 *   list_adapters    → registered adapters with binary availability +
 *                      env-readiness + tierLimits
 *   list_skills      → all loaded skills with pinsModel + pinIsCurrent
 *   reload_skills    → force re-scan of skill directories
 *   list_tasks       → alias for tasks_list (R4-D.2)
 *   cancel_task      → alias for tasks_cancel (R4-D.2)
 *
 * The general config get/set/reset surface remains reserved for a future
 * persistence layer; v2.2 returns "not yet implemented" for those.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import {
  getManifestRegistry,
  getSettingsStore,
  getSkillRegistry,
  getSubagentRegistry,
  getTaskExecutor,
} from '../app.js';
import { TaskNotFoundError } from '../core/taskExecutor.js';
import { detectAuthPath, type AdapterId } from '../adapters/authPath.js';

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
  tierLimits?: unknown;
  mcp?: unknown;
  /** v2.3 — detected auth-path based on current env (R6a-D.4). */
  authPath?: string;
  /** v2.3 — when verify:true was passed: result of local probe (R-DIAG-D.3). */
  authVerified?: true | false | 'env-present-not-validated' | 'not-checked';
  authVerifiedDetail?: string;
}

export function registerConfigTool(server: McpServer): void {
  server.registerTool(
    'asyncthink_config',
    {
      title: 'AsyncThink Configuration',
      description:
        'Introspect and modify AsyncThink configuration: adapters, skills, tasks, settings, and subagents. ' +
        'list_adapters / list_skills / reload_skills / list_tasks / cancel_task = introspection. ' +
        'get_settings / set_setting / unset_setting = the v2.6 settings layer (TOML user-level + YAML project-level, layered resolution). ' +
        'subagent_list / subagent_get / subagent_create / subagent_update / subagent_delete = persistent subagent registry; the claude adapter uses the active subagent (defaults.subagent setting) on the subscription auth path.',
      inputSchema: {
        action: z
          .enum([
            'list_adapters',
            'list_skills',
            'reload_skills',
            'list_tasks',
            'cancel_task',
            // v2.6.0 — settings layer.
            'get_settings',
            'set_setting',
            'unset_setting',
            // v2.6.0 — subagent registry.
            'subagent_list',
            'subagent_get',
            'subagent_create',
            'subagent_update',
            'subagent_delete',
          ])
          .describe('Action to perform.'),
        // Optional input for cancel_task / list_tasks.
        taskId: z.string().optional().describe('Task id (cancel_task only).'),
        cursor: z.string().optional().describe('Pagination cursor (list_tasks only).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Page size (list_tasks only; default 50).'),
        verify: z
          .boolean()
          .optional()
          .describe(
            'v2.3 — when true, list_adapters runs cheap local auth probes (R-DIAG-D.3). Defaults to false.'
          ),
        // v2.6.0 — settings layer.
        key: z
          .string()
          .optional()
          .describe(
            'v2.6.0 — dotted-path setting key for set_setting/unset_setting (e.g., "defaults.adapter").'
          ),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe('v2.6.0 — value for set_setting.'),
        scope: z
          .enum(['user', 'project'])
          .optional()
          .describe(
            'v2.6.0 — scope for set_setting/unset_setting. "user" writes to ~/.config/asyncthink/settings.toml; "project" writes to .claude/asyncthink.local.md in cwd. Default: "user".'
          ),
        // v2.6.0 — subagent registry.
        subagentId: z
          .string()
          .optional()
          .describe('v2.6.0 — subagent id (subagent_get/update/delete).'),
        subagent: z
          .object({
            name: z.string().optional(),
            description: z.string().optional(),
            prompt: z.string().optional(),
            tools: z.array(z.string()).optional(),
            model: z.string().optional(),
          })
          .optional()
          .describe(
            'v2.6.0 — subagent fields for subagent_create (name, description, prompt required) or subagent_update (any subset as a patch).'
          ),
      },
    },
    async (args) => {
      const action = args.action;
      let payload: Record<string, unknown>;
      switch (action) {
        case 'list_adapters': {
          const manifests = await getManifestRegistry().loadAll();
          // v2.3 — emit lastVerified staleness warnings to stderr (R6a-D.7).
          warnStaleAdvisories(manifests);
          const verify = args.verify === true;
          const adapters: AdapterListing[] = manifests.map((m) => {
            const binaryPath = whichSync(m.binary);
            const envMissing = adapterEnvMissing(m.requiredEnv);
            let authPath: string | undefined;
            let authVerified: AdapterListing['authVerified'] = 'not-checked';
            let authVerifiedDetail: string | undefined;
            // v2.3 — auth-path detection (R6a-D.4 supporting).
            if (['claude', 'gemini', 'codex'].includes(m.id)) {
              authPath = detectAuthPath(m.id as AdapterId);
              if (verify) {
                const probe = probeAuth(m.id as AdapterId);
                authVerified = probe.verified;
                authVerifiedDetail = probe.detail;
              }
            }
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
              tierLimits: m.tierLimits,
              mcp: m.mcp,
              authPath,
              authVerified,
              ...(authVerifiedDetail !== undefined && { authVerifiedDetail }),
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
              intelligence: s.intelligence,
              model: s.model,
              filesGlob: s.filesGlob,
              timeoutMs: s.timeoutMs,
              description: s.description,
              source: s.source,
              credentials: s.credentials,
              pinsModel: s.pinsModel ?? null,
              pinIsCurrent: s.pinIsCurrent,
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
        case 'list_tasks': {
          const result = await getTaskExecutor().list({
            cursor: args.cursor,
            limit: args.limit,
            principal: null,
          });
          payload = result as unknown as Record<string, unknown>;
          break;
        }
        case 'cancel_task': {
          if (!args.taskId) {
            payload = { error: 'invalid_args', message: 'cancel_task requires taskId.' };
            break;
          }
          try {
            const state = await getTaskExecutor().cancel(args.taskId);
            payload = state as unknown as Record<string, unknown>;
          } catch (err) {
            if (err instanceof TaskNotFoundError) {
              payload = { error: 'task_not_found', message: err.message };
              break;
            }
            payload = {
              error: 'task_error',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          break;
        }
        // v2.6.0 — settings layer.
        case 'get_settings': {
          const settings = await getSettingsStore().get();
          payload = settings as unknown as Record<string, unknown>;
          break;
        }
        case 'set_setting': {
          if (!args.key || args.value === undefined) {
            payload = {
              error: 'invalid_args',
              message: 'set_setting requires `key` and `value`.',
            };
            break;
          }
          const scope = args.scope ?? 'user';
          try {
            const updated = await getSettingsStore().set(args.key, args.value, scope);
            payload = updated as unknown as Record<string, unknown>;
          } catch (err) {
            payload = {
              error: 'settings_error',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          break;
        }
        case 'unset_setting': {
          if (!args.key) {
            payload = { error: 'invalid_args', message: 'unset_setting requires `key`.' };
            break;
          }
          const scope = args.scope ?? 'user';
          try {
            const updated = await getSettingsStore().unset(args.key, scope);
            payload = updated as unknown as Record<string, unknown>;
          } catch (err) {
            payload = {
              error: 'settings_error',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          break;
        }
        // v2.6.0 — subagent registry.
        case 'subagent_list': {
          const subagents = await getSubagentRegistry().list();
          payload = { subagents };
          break;
        }
        case 'subagent_get': {
          if (!args.subagentId) {
            payload = {
              error: 'invalid_args',
              message: 'subagent_get requires `subagentId`.',
            };
            break;
          }
          const subagent = await getSubagentRegistry().get(args.subagentId);
          payload = subagent
            ? (subagent as unknown as Record<string, unknown>)
            : { error: 'subagent_not_found', subagentId: args.subagentId };
          break;
        }
        case 'subagent_create': {
          if (
            !args.subagent ||
            !args.subagent.name ||
            !args.subagent.description ||
            !args.subagent.prompt
          ) {
            payload = {
              error: 'invalid_args',
              message:
                'subagent_create requires `subagent.{name, description, prompt}` (all non-empty).',
            };
            break;
          }
          try {
            const created = await getSubagentRegistry().create({
              name: args.subagent.name,
              description: args.subagent.description,
              prompt: args.subagent.prompt,
              tools: args.subagent.tools,
              model: args.subagent.model,
            });
            payload = created as unknown as Record<string, unknown>;
          } catch (err) {
            payload = {
              error: 'subagent_error',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          break;
        }
        case 'subagent_update': {
          if (!args.subagentId || !args.subagent) {
            payload = {
              error: 'invalid_args',
              message: 'subagent_update requires `subagentId` and `subagent` patch.',
            };
            break;
          }
          try {
            const updated = await getSubagentRegistry().update(args.subagentId, {
              name: args.subagent.name,
              description: args.subagent.description,
              prompt: args.subagent.prompt,
              tools: args.subagent.tools,
              model: args.subagent.model,
            });
            payload = updated as unknown as Record<string, unknown>;
          } catch (err) {
            payload = {
              error: 'subagent_error',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          break;
        }
        case 'subagent_delete': {
          if (!args.subagentId) {
            payload = {
              error: 'invalid_args',
              message: 'subagent_delete requires `subagentId`.',
            };
            break;
          }
          try {
            const result = await getSubagentRegistry().delete(args.subagentId);
            payload = result as unknown as Record<string, unknown>;
          } catch (err) {
            payload = {
              error: 'subagent_error',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          break;
        }
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

/**
 * v2.3 (R6a-D.7) — emit stderr warnings for cells whose `rateLimit.lastVerified`
 * is older than 90 days. Doesn't block; nudges the maintainer to recheck the
 * provider's published caps.
 */
function warnStaleAdvisories(manifests: import('../core/manifests.js').AdapterManifest[]): void {
  const cutoff = Date.now() - 90 * 24 * 60 * 60_000;
  for (const m of manifests) {
    if (!m.tierLimits) continue;
    for (const [tier, limits] of Object.entries(m.tierLimits)) {
      const rl = limits?.rateLimit;
      if (!rl?.lastVerified) continue;
      const ts = new Date(rl.lastVerified).getTime();
      if (Number.isFinite(ts) && ts < cutoff) {
        const evid = rl.byAuthPath[rl.default]?.evidenceUrl ?? '(no evidenceUrl on default path)';
        console.error(
          `[Adapter:${m.id}] WARNING: rate-limit advisory for tier "${tier}" last verified ${rl.lastVerified} (>90 days). Recheck ${evid}.`
        );
      }
    }
  }
}

/**
 * v2.3 (R-DIAG-D.3) — cheap local auth probe. Never makes paid API calls.
 *
 * Claude/codex have no offline auth-status command in v0.39/v0.125 that we
 * can rely on without paying; for v2.3 we keep this passive (env+binary).
 * The opt-in `verify: true` flag toggles whether we report 'env-present-not-validated'
 * vs 'not-checked'.
 */
function probeAuth(adapter: AdapterId): {
  verified: AdapterListing['authVerified'];
  detail: string;
} {
  const env = process.env;
  switch (adapter) {
    case 'claude': {
      // Subscription path: no offline check. API path: ANTHROPIC_API_KEY present.
      const path = detectAuthPath('claude');
      if (path === 'api') {
        return env.ANTHROPIC_API_KEY
          ? { verified: 'env-present-not-validated', detail: 'ANTHROPIC_API_KEY present (not validated)' }
          : { verified: false, detail: 'auth-path=api but ANTHROPIC_API_KEY not set' };
      }
      return { verified: 'env-present-not-validated', detail: `auth-path=${path}; subscription/cloud auth not offline-verifiable` };
    }
    case 'gemini': {
      const path = detectAuthPath('gemini');
      if (path === 'vertex') {
        return env.GOOGLE_CLOUD_PROJECT
          ? { verified: 'env-present-not-validated', detail: 'Vertex env present (not validated)' }
          : { verified: false, detail: 'GOOGLE_CLOUD_PROJECT missing' };
      }
      const hasKey = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
      return hasKey
        ? { verified: 'env-present-not-validated', detail: 'AI Studio key present (not validated)' }
        : { verified: false, detail: 'neither GEMINI_API_KEY nor GOOGLE_API_KEY set' };
    }
    case 'codex': {
      const path = detectAuthPath('codex');
      if (path === 'api' || path === 'azure') {
        return env.OPENAI_API_KEY
          ? { verified: 'env-present-not-validated', detail: `auth-path=${path} key present (not validated)` }
          : { verified: false, detail: 'auth-path=api but OPENAI_API_KEY not set' };
      }
      return {
        verified: 'env-present-not-validated',
        detail: 'auth-path=subscription; codex login state not offline-verifiable in v2.3',
      };
    }
  }
}
