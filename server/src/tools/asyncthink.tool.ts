/**
 * asyncthink tool — sequential thinking + parallel competitor council.
 *
 * Sequential thinking is the wrapping deliberation layer (one thought per
 * tool call). Within each thought the caller can spawn forks: parallel,
 * fire-and-forget invocations of subordinate adapters that come back with
 * independent perspectives. Forks belong to a chain (one chain per
 * server-active thinking session); on the final thought
 * (nextThoughtNeeded:false), all in-flight forks are awaited, all child
 * threads closed, and the chain's task records pruned.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getCouncil,
  getThinking,
  getSkillRegistry,
  getManifestRegistry,
  getAuditLog,
} from '../app.js';
import type { CouncilResult } from '../asyncthink/council.js';
import { sweepIdleOnce } from '../delegate/sweeper.js';
import { resolveSkill } from '../skills/resolver.js';
import { getSettingsStore } from '../app.js';

const DEFAULT_FORK_TIMEOUT_MS = 180_000;

let activeChainId: string | null = null;

const ASYNCTHINK_DESCRIPTION = `Sequential thinking with optional parallel forks to subordinate model CLIs (claude, gemini, codex).

Each call processes one thought. Within a thought you may spawn forks — parallel, fire-and-forget invocations to subordinate adapters that produce independent perspectives. Forks return immediately as task ids; collect results later via waitFor or readResearch, or let the final thought auto-collect everything.

The thought chain auto-closes when nextThoughtNeeded is false: all in-flight forks are awaited (with timeout), child threads are closed, and the response includes any final fork results. Subordinates are read-only — they may navigate files but never edit, exec, or write.`;

export function registerAsyncThinkTool(server: McpServer): void {
  server.registerTool(
    'asyncthink',
    {
      title: 'AsyncThink',
      description: ASYNCTHINK_DESCRIPTION,
      inputSchema: {
        // Sequential thinking core
        thought: z.string().describe('The current thinking step.'),
        nextThoughtNeeded: z
          .boolean()
          .describe('False on the final thought; triggers auto-wait + chain close.'),
        thoughtNumber: z.number().int().min(1).describe('Current thought number.'),
        totalThoughts: z.number().int().min(1).describe('Estimated total thoughts.'),
        isRevision: z.boolean().optional(),
        revisesThought: z.number().int().min(1).optional(),
        branchFromThought: z.number().int().min(1).optional(),
        branchId: z.string().optional(),
        needsMoreThoughts: z.boolean().optional(),

        // Parallel council forks
        forks: z
          .array(
            z.object({
              id: z.string().describe('Caller-chosen fork id, unique within the chain.'),
              adapter: z
                .enum(['claude', 'gemini', 'codex'])
                .optional()
                .describe('Subordinate to dispatch to. Required if skill not supplied.'),
              prompt: z.string().describe('Fork-specific prompt.'),
              files: z.array(z.string()).optional(),
              intelligence: z
                .enum(['high', 'med', 'low'])
                .optional()
                .describe('Intelligence tier (preferred over raw model id).'),
              model: z.string().optional().describe('Raw model id override.'),
              skill: z
                .string()
                .optional()
                .describe('Skill id; supplies adapter + prompt prefix from the registry.'),
              async: z
                .boolean()
                .optional()
                .describe(
                  'v2.2 — fire-and-forget detached fork. Survives chain end; reaped by TTL sweeper. Returns immediately as a task id, queryable via tasks_get.'
                ),
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
                  'v2.3 — additive MCP-server allowlist for this fork. Merged with manifest + skill defaults; cannot remove (F3-D.2).'
                ),
              preflight: z
                .enum(['auth', 'none'])
                .optional()
                .describe(
                  "v2.3 — opt-in auth probe before spawning this fork. Off by default; skills can pin via frontmatter (R-DIAG-D.4)."
                ),
              authPath: z
                .string()
                .optional()
                .describe(
                  "v2.3.3 — auth-path override for the rate-limit gate on this fork. Use when env-derived path misclassifies the real auth route."
                ),
              bypassRateLimit: z
                .boolean()
                .optional()
                .describe(
                  "v2.3.3 — opt out of pre-flight rate-limit refuse for this fork. Caller assumes 429 risk."
                ),
              subagent: z
                .string()
                .optional()
                .describe(
                  'v2.7.0 — subagent id for this fork. Applies only when the fork resolves to the claude adapter on the subscription auth path. Powers parallel multi-persona reviews (e.g. spawning security-review + simplify-review + test-coverage-review + correctness-review forks at once).'
                ),
            })
          )
          .optional()
          .describe('Forks to spawn during this thought.'),

        // Result collection
        readResearch: z
          .string()
          .optional()
          .describe('Fork id whose result to inject into this response (if complete).'),
        waitFor: z
          .array(z.string())
          .optional()
          .describe('Fork ids to await before returning (up to per-fork timeout).'),
      },
    },
    async (args) => {
      await sweepIdleOnce();
      const council = getCouncil();
      const thinking = getThinking();

      // 1. Open chain if needed.
      if (!activeChainId) activeChainId = council.newChain();
      const chainId = activeChainId;

      // 2. Process the thought through sequential thinking.
      const thoughtResult = thinking.processThought({
        thought: args.thought,
        thoughtNumber: args.thoughtNumber,
        totalThoughts: args.totalThoughts,
        nextThoughtNeeded: args.nextThoughtNeeded,
        isRevision: args.isRevision,
        revisesThought: args.revisesThought,
        branchFromThought: args.branchFromThought,
        branchId: args.branchId,
        needsMoreThoughts: args.needsMoreThoughts,
      });
      if (thoughtResult.isError) return thoughtResult;
      const parsedThought = JSON.parse(thoughtResult.content[0].text) as Record<string, unknown>;

      // 3. Spawn forks (fire-and-forget). Resolve skills first.
      const spawnErrors: { id: string; error: string }[] = [];
      const detachedTaskIds: { forkId: string; taskId: string }[] = [];
      if (args.forks) {
        for (const f of args.forks) {
          try {
            let adapter = f.adapter;
            let prompt = f.prompt;
            let intelligence = f.intelligence;
            let model = f.model;
            let credentials = f.credentials;
            let mcpServers = f.mcpServers;
            let preflight = f.preflight;
            let forkAuthPath = f.authPath;
            let forkBypassRateLimit = f.bypassRateLimit;
            let forkSubagent = f.subagent;
            if (f.skill) {
              const resolved = await resolveSkill(
                getSkillRegistry(),
                {
                  skill: f.skill,
                  callerPrompt: f.prompt,
                  callerAdapter: f.adapter,
                  callerIntelligence: f.intelligence,
                  callerModel: f.model,
                  callerCredentials: f.credentials,
                },
                { manifests: getManifestRegistry(), auditLog: getAuditLog() }
              );
              adapter = resolved.adapter as typeof f.adapter;
              prompt = resolved.prompt;
              intelligence = resolved.intelligence;
              model = resolved.model;
              credentials = resolved.credentials;
              // v2.3 — extend allowlist additively; caller's preflight wins over skill's.
              if (resolved.mcpServers && resolved.mcpServers.length > 0) {
                mcpServers = [...new Set([...(mcpServers ?? []), ...resolved.mcpServers])];
              }
              preflight = f.preflight ?? resolved.preflight;
              // v2.3.3 — caller authPath/bypass wins; skill provides default.
              forkAuthPath = f.authPath ?? resolved.authPath;
              forkBypassRateLimit = f.bypassRateLimit ?? resolved.bypassRateLimit;
              // v2.7.0 — caller subagent wins; skill provides default.
              forkSubagent = f.subagent ?? resolved.subagent;
            }
            // v2.6.0 — settings-layer default applies per-fork when neither
            // caller adapter nor skill was supplied. Resolution chain:
            // caller arg > skill > project settings > user settings > built-in.
            if (!adapter) {
              const settings = await getSettingsStore().get();
              adapter = settings.effective?.defaults?.adapter as typeof f.adapter;
            }
            if (!adapter) {
              throw new Error(
                `fork "${f.id}": either adapter or skill must be supplied (or set defaults.adapter via asyncthink_config).`
              );
            }
            // R-CRED-D.2: any non-default profile is rejected at fork time.
            if (credentials !== undefined && credentials !== '' && credentials !== 'default') {
              throw new Error(
                `fork "${f.id}": credential profile "${credentials}" is not supported in v2.2 ` +
                  '(R-CRED-D.2). Drop the credentials argument or pass "default".'
              );
            }
            // v2.2 — async forks bypass chain-end and run via TaskExecutor.
            if (f.async) {
              const { getTaskExecutor } = await import('../app.js');
              const state = await getTaskExecutor().start({
                adapter,
                prompt,
                files: f.files,
                intelligence,
                model,
                detached: true,
                principal: null,
                credentials,
                threadId: `${chainId}::${f.id}`,
                parentChainId: chainId,
                skill: f.skill,
                // v2.3 — additive allowlist + opt-in preflight (F3-D.2, R-DIAG-D.4).
                // First-class on TaskExecutorRequest as of v2.3.1 B1.
                mcpServers,
                preflight,
                // v2.3.3 — caller flexibility levers for async fork.
                authPath: forkAuthPath,
                bypassRateLimit: forkBypassRateLimit,
                // v2.7.0 — per-fork subagent for claude subscription auth.
                subagent: forkSubagent,
              });
              detachedTaskIds.push({ forkId: f.id, taskId: state.taskId });
              continue;
            }
            await council.fork({
              id: f.id,
              adapter,
              prompt,
              files: f.files,
              intelligence,
              model,
              skill: f.skill,
              parentThreadId: chainId,
              thoughtNumber: args.thoughtNumber,
              // v2.3 — additive MCP allowlist + preflight propagate to council forks.
              ...(mcpServers !== undefined && { mcpServers }),
              ...(preflight !== undefined && { preflight }),
              // v2.3.3 — caller flexibility levers for sync fork.
              ...(forkAuthPath !== undefined && { authPath: forkAuthPath }),
              ...(forkBypassRateLimit !== undefined && { bypassRateLimit: forkBypassRateLimit }),
              // v2.7.0 — per-fork subagent for claude subscription auth.
              ...(forkSubagent !== undefined && { subagent: forkSubagent }),
            });
          } catch (e) {
            spawnErrors.push({
              id: f.id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      // 4. waitFor.
      if (args.waitFor?.length) {
        await council.waitFor(args.waitFor, chainId, DEFAULT_FORK_TIMEOUT_MS);
      }

      // 5. End chain on final thought.
      let endResults: CouncilResult[] | undefined;
      if (!args.nextThoughtNeeded) {
        endResults = await council.endChain(chainId, DEFAULT_FORK_TIMEOUT_MS);
        activeChainId = null;
      }

      // 6. Collect results requested by the caller.
      const researchResults: CouncilResult[] = [];
      if (args.readResearch) {
        const r = await council.getResult(args.readResearch, chainId);
        if (r) researchResults.push(r);
      }
      for (const id of args.waitFor ?? []) {
        if (researchResults.some((r) => r.id === id)) continue;
        const r = await council.getResult(id, chainId);
        if (r) researchResults.push(r);
      }
      if (endResults) {
        for (const r of endResults) {
          if (!researchResults.some((x) => x.id === r.id)) researchResults.push(r);
        }
      }

      // 7. Status (only meaningful when chain is still active).
      const status = activeChainId
        ? await council.chainStatus(chainId)
        : { pending: [], complete: [], failed: [] };

      const reminderParts: string[] = [];
      if (status.complete.length > 0) {
        reminderParts.push(
          `Forks complete: ${status.complete.join(', ')}. Use readResearch to inject results.`
        );
      }
      if (status.failed.length > 0) {
        reminderParts.push(`Forks FAILED: ${status.failed.join(', ')}.`);
      }
      if (status.pending.length > 0) {
        reminderParts.push(`Forks pending: ${status.pending.join(', ')}.`);
      }
      if (spawnErrors.length > 0) {
        reminderParts.push(
          `Spawn errors: ${spawnErrors.map((e) => `${e.id}: ${e.error}`).join('; ')}`
        );
      }
      const reminder = reminderParts.length > 0 ? reminderParts.join(' ') : undefined;

      const output = {
        ...parsedThought,
        chainId,
        chainEnded: activeChainId === null,
        research: status,
        ...(researchResults.length > 0 && { researchResults }),
        ...(spawnErrors.length > 0 && { spawnErrors }),
        ...(detachedTaskIds.length > 0 && { detachedTasks: detachedTaskIds }),
        ...(reminder && { reminder }),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output as Record<string, unknown>,
      };
    }
  );
}
