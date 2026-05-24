/**
 * delegate tools — single-subordinate threaded conversation handoff.
 *
 * Registers four tools:
 *   - delegate              (open or continue a thread; optional inline close; optional async)
 *   - delegate_close        (close one thread)
 *   - delegate_close_all    (close every open thread)
 *   - delegate_list_threads (introspection)
 *
 * v2.2: `delegate` gains `async`, `idempotencyKey`, `ttlMs`, `credentials`
 * fields. When `async: true`, the call returns a `{taskId}` envelope and
 * the work runs in the background via the TaskExecutor. The synchronous
 * path is unchanged for callers that omit `async`.
 *
 * Threading discipline reminders are baked into both the tool descriptions
 * and the `reminder` field on every delegate response. Defense-in-depth
 * against thread leakage:
 *   1. inline `close: true` flag for one-round-trip closure
 *   2. explicit delegate_close / delegate_close_all tools
 *   3. idle sweeper at 6h on every tool invocation
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getDelegate,
  getThreadStore,
  getSkillRegistry,
  getManifestRegistry,
  getAuditLog,
} from '../app.js';
import { sweepIdleOnce } from '../delegate/sweeper.js';
import { resolveSkill } from '../skills/resolver.js';
import {
  ContextLimitExceededError,
  CredentialsNotSupportedError,
} from '../core/taskExecutor.js';
import { getSettingsStore } from '../app.js';

const DELEGATE_DESCRIPTION = `Hand a focused task to a single subordinate model CLI (claude, gemini, or codex). \
The conversation runs as a thread you can continue across multiple calls by passing the returned threadId back in.

CLOSE THE THREAD WHEN DONE. Either set close: true on the final delegate call, or call delegate_close({threadId}) afterward. \
Idle threads are auto-swept after 6 hours.

Read-only by design — subordinates can read files but cannot edit, exec, or write. \
Use this for second opinions, focused research, code review, or any task where a different model's perspective adds value.

Async mode (v2.2): set async: true to spawn the work in the background and return immediately with a {taskId}. \
Poll status via tasks_get({taskId}); fetch the final result via tasks_result({taskId}); cancel via tasks_cancel({taskId}). \
Optional idempotencyKey + ttlMs for retry-safe spawning and category-bounded retention.`;

export function registerDelegateTools(server: McpServer): void {
  server.registerTool(
    'delegate',
    {
      title: 'Delegate',
      description: DELEGATE_DESCRIPTION,
      inputSchema: {
        adapter: z
          .enum(['claude', 'gemini', 'codex'])
          .optional()
          .describe('Subordinate to dispatch to. Required if skill is not supplied.'),
        prompt: z.string().describe('Instruction or message for the subordinate.'),
        threadId: z
          .string()
          .optional()
          .describe('Continue an existing conversation. Omit to open a fresh thread.'),
        files: z
          .array(z.string())
          .optional()
          .describe('Absolute paths the subordinate may read.'),
        skill: z
          .string()
          .optional()
          .describe(
            "Skill id from the registry. The skill's frontmatter supplies the adapter and a prompt prefix; caller may still override model/timeout."
          ),
        close: z
          .boolean()
          .optional()
          .describe('Close the thread immediately after this turn. Sync mode only.'),
        cwd: z.string().optional().describe('Override the working directory.'),
        timeoutMs: z.number().int().min(1_000).optional(),
        intelligence: z
          .enum(['high', 'med', 'low'])
          .optional()
          .describe(
            'Intelligence tier — preferred over raw model id. Maps to a model via the adapter manifest, so callers stay stable as model names evolve.'
          ),
        model: z
          .string()
          .optional()
          .describe('Raw model id override (escape hatch); wins over intelligence.'),
        async: z
          .boolean()
          .optional()
          .describe(
            'v2.2 — when true, spawn the work in the background and return {taskId}. Poll via tasks_get/tasks_result; cancel via tasks_cancel.'
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            'v2.2 (async only) — caller-supplied dedup key. A repeat call with the same key + principal returns the existing in-flight taskId instead of spawning a new one.'
          ),
        ttlMs: z
          .number()
          .int()
          .min(60_000)
          .optional()
          .describe('v2.2 (async only) — caller TTL in ms; clamped to category cap.'),
        credentials: z
          .string()
          .optional()
          .describe(
            "v2.2 — credential profile name. v2.2 only accepts 'default'; non-default profiles will be supported in v3."
          ),
        mcpServers: z
          .array(z.string())
          .optional()
          .describe(
            'v2.3 — additive MCP-server allowlist for the adapter subprocess (F3-D.2). Merged with manifest defaults and any skill-supplied list.'
          ),
        preflight: z
          .enum(['auth', 'none'])
          .optional()
          .describe(
            "v2.3 — opt-in auth pre-flight (R-DIAG-D.4). When 'auth', runs a local probe before spawning; fails fast on missing/invalid auth."
          ),
        authPath: z
          .string()
          .optional()
          .describe(
            "v2.3.3 — auth-path override for the rate-limit gate (e.g. 'subscription' when ANTHROPIC_API_KEY is set but the CLI uses subscription auth). Does NOT change actual adapter routing; only the advisory lookup."
          ),
        bypassRateLimit: z
          .boolean()
          .optional()
          .describe(
            "v2.3.3 — opt out of pre-flight rate-limit refuse. Caller assumes 429 risk; an audit event records the bypass."
          ),
        subagent: z
          .string()
          .optional()
          .describe(
            'v2.7.0 — subagent id (from the registry) to use for this call. Applies only when adapter resolves to "claude" on the subscription auth path. Resolution precedence: this > skill `subagent:` frontmatter > settings `defaults.subagent` > built-in `asyncthink-delegate`.'
          ),
      },
    },
    async (args) => {
      await sweepIdleOnce();

      let adapter = args.adapter;
      let prompt = args.prompt;
      let intelligence = args.intelligence;
      let model = args.model;
      let timeoutMs = args.timeoutMs;
      let credentials = args.credentials;
      let mcpServers = args.mcpServers;
      let preflight = args.preflight;
      let authPath = args.authPath;
      let bypassRateLimit = args.bypassRateLimit;
      let subagent = args.subagent;
      if (args.skill) {
        const resolved = await resolveSkill(
          getSkillRegistry(),
          {
            skill: args.skill,
            callerPrompt: args.prompt,
            callerAdapter: args.adapter,
            callerIntelligence: args.intelligence,
            callerModel: args.model,
            callerTimeoutMs: args.timeoutMs,
            callerCredentials: args.credentials,
          },
          { manifests: getManifestRegistry(), auditLog: getAuditLog() }
        );
        adapter = resolved.adapter as typeof args.adapter;
        prompt = resolved.prompt;
        intelligence = resolved.intelligence;
        model = resolved.model;
        timeoutMs = resolved.timeoutMs;
        credentials = resolved.credentials;
        // v2.3: skill frontmatter extends mcp/preflight; caller can further
        // extend mcpServers (additive); caller's preflight overrides skill's.
        if (resolved.mcpServers && resolved.mcpServers.length > 0) {
          mcpServers = [...new Set([...(mcpServers ?? []), ...resolved.mcpServers])];
        }
        preflight = args.preflight ?? resolved.preflight;
        // v2.3.3 — caller authPath/bypassRateLimit wins; skill provides default.
        authPath = args.authPath ?? resolved.authPath;
        bypassRateLimit = args.bypassRateLimit ?? resolved.bypassRateLimit;
        // v2.7.0 — caller subagent wins; skill provides default.
        subagent = args.subagent ?? resolved.subagent;
      }
      // v2.6.0 — fall back to the settings layer when neither caller-supplied
      // adapter nor skill (which pins one) were provided. Resolution chain:
      // caller arg > skill > project settings > user settings > built-in.
      if (!adapter) {
        const settings = await getSettingsStore().get();
        adapter = settings.effective?.defaults?.adapter as typeof args.adapter;
      }
      if (!adapter) {
        throw new Error(
          'delegate: either `adapter` or `skill` must be supplied (or set defaults.adapter via asyncthink_config).'
        );
      }

      try {
        if (args.async) {
          const result = await getDelegate().runAsync({
            adapter,
            prompt,
            threadId: args.threadId,
            files: args.files,
            skill: args.skill,
            cwd: args.cwd,
            timeoutMs,
            intelligence,
            model,
            idempotencyKey: args.idempotencyKey,
            ttlMs: args.ttlMs,
            credentials,
            mcpServers,
            preflight,
            authPath,
            bypassRateLimit,
            subagent,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }
        const result = await getDelegate().run({
          adapter,
          prompt,
          threadId: args.threadId,
          files: args.files,
          skill: args.skill,
          close: args.close,
          cwd: args.cwd,
          timeoutMs,
          intelligence,
          model,
          credentials,
          mcpServers,
          authPath,
          bypassRateLimit,
          subagent,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof CredentialsNotSupportedError) {
          const payload = {
            error: 'credentials_not_supported',
            message: err.message,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
            isError: true,
            structuredContent: payload,
          };
        }
        if (err instanceof ContextLimitExceededError) {
          const payload = {
            error: 'context_limit_exceeded',
            message: err.message,
            tier: err.tier,
            adapter: err.adapter,
            approxTokens: err.approxTokens,
            maxTokens: err.maxTokens,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
            isError: true,
            structuredContent: payload,
          };
        }
        throw err;
      }
    }
  );

  server.registerTool(
    'delegate_close',
    {
      title: 'Delegate Close',
      description:
        'Close a single delegate thread. Idempotent — closing an already-closed or unknown thread is a no-op.',
      inputSchema: {
        threadId: z.string().describe('Thread id returned by delegate.'),
      },
    },
    async (args) => {
      await sweepIdleOnce();
      await getThreadStore().close(args.threadId);
      const payload = { threadId: args.threadId, closed: true };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    'delegate_close_all',
    {
      title: 'Delegate Close All',
      description:
        'Close every open delegate thread. End-of-session safety net — call when wrapping up if any threads might be leaking.',
      inputSchema: {},
    },
    async () => {
      await sweepIdleOnce();
      const closed = await getThreadStore().closeAll();
      const payload = { closed };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    'delegate_list_threads',
    {
      title: 'Delegate List Threads',
      description: 'List currently open delegate threads with adapter and idle time.',
      inputSchema: {},
    },
    async () => {
      await sweepIdleOnce();
      const threads = await getThreadStore().list();
      const payload = { threads };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );
}
