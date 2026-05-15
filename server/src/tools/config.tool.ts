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
  getSkillRegistry,
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
        'Introspect adapters, skills, and tasks. Use list_adapters to check availability of subordinate CLIs (now includes per-tier limits); list_skills to see what skill ids resolve via the registry; reload_skills after editing a user skill file; list_tasks / cancel_task for async-task introspection.',
      inputSchema: {
        action: z
          .enum([
            'list_adapters',
            'list_skills',
            'reload_skills',
            'list_tasks',
            'cancel_task',
            'get',
            'set',
            'reset',
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
        case 'get':
        case 'set':
        case 'reset':
          payload = {
            status: 'not_implemented',
            note: 'General config persistence ships in v2.3+. v2.2 surface is read-only via list_adapters / list_skills / list_tasks plus the cancel_task action.',
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
