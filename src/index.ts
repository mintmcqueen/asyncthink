#!/usr/bin/env node

/**
 * AsyncThink MCP Server
 *
 * Combines Sequential Thinking with async research workers:
 * - Claude Code workers: Full capability (repo, docs, web) - 45-90s
 * - Gemini workers: Fast feedback/web research - 2-5s
 *
 * Inspired by claudecode-mcp-async, rebuilt in TypeScript.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AsyncThinkingServer } from './lib/thinking.js';
import { getLedger } from './lib/ledger.js';
import { getConfigManager } from './lib/config.js';
import {
  spawnOrganizerWorker,
  executeGeminiWorker,
  checkAndCollectResults,
  checkTimeouts,
} from './lib/orchestrator.js';
import { GeminiClient } from './lib/gemini-client.js';

// =============================================================================
// Server Setup
// =============================================================================

const server = new McpServer({
  name: "asyncthink",
  version: "1.0.0",
});

const thinkingServer = new AsyncThinkingServer();

// Initialize config and ledger
const config = getConfigManager();
config.ensureDirectories();
const ledger = getLedger();

// Generate a unique session ID for this server instance
// This ensures tasks from concurrent sessions don't collide
const SESSION_ID = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
console.error(`[AsyncThink] Session ID: ${SESSION_ID}`);

// Clean up stale tasks from previous sessions
ledger.cleanupStaleTasks();

/**
 * Prefix a task ID with the session ID to ensure uniqueness
 */
function scopeTaskId(id: string): string {
  return `${SESSION_ID}::${id}`;
}

/**
 * Check if a task ID belongs to this session
 */
function isCurrentSession(taskId: string): boolean {
  return taskId.startsWith(`${SESSION_ID}::`);
}

/**
 * Extract the user-facing ID from a scoped task ID
 */
function unscopeTaskId(scopedId: string): string {
  const prefix = `${SESSION_ID}::`;
  return scopedId.startsWith(prefix) ? scopedId.slice(prefix.length) : scopedId;
}

// =============================================================================
// Tool Registration
// =============================================================================

server.registerTool(
  "asyncthink",
  {
    title: "AsyncThink",
    description: `A detailed tool for dynamic and reflective problem-solving through thoughts.
This tool helps analyze problems through a flexible thinking process that can adapt and evolve.
Each thought can build on, question, or revise previous insights as understanding deepens.

When to use this tool:
- Breaking down complex problems into steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope might not be clear initially
- Problems that require a multi-step solution
- Tasks that need to maintain context over multiple steps
- Situations where irrelevant information needs to be filtered out

Key features:
- You can adjust totalThoughts up or down as you progress
- You can question or revise previous thoughts
- You can add more thoughts even after reaching what seemed like the end
- You can express uncertainty and explore alternative approaches
- Not every thought needs to build linearly - you can branch or backtrack
- Generates a solution hypothesis
- Verifies the hypothesis based on the Chain of Thought steps
- Repeats the process until satisfied
- Provides a correct answer

Parameters explained:
- thought: Your current thinking step, which can include:
  * Regular analytical steps
  * Revisions of previous thoughts
  * Questions about previous decisions
  * Realizations about needing more analysis
  * Changes in approach
  * Hypothesis generation
  * Hypothesis verification
- nextThoughtNeeded: True if you need more thinking, even if at what seemed like the end
- thoughtNumber: Current number in sequence (can go beyond initial total if needed)
- totalThoughts: Current estimate of thoughts needed (can be adjusted up/down)
- isRevision: A boolean indicating if this thought revises previous thinking
- revisesThought: If isRevision is true, which thought number is being reconsidered
- branchFromThought: If branching, which thought number is the branching point
- branchId: Identifier for the current branch (if any)
- needsMoreThoughts: If reaching end but realizing more thoughts needed

You should:
1. Start with an initial estimate of needed thoughts, but be ready to adjust
2. Feel free to question or revise previous thoughts
3. Don't hesitate to add more thoughts if needed, even at the "end"
4. Express uncertainty when present
5. Mark thoughts that revise previous thinking or branch into new paths
6. Ignore information that is irrelevant to the current step
7. Generate a solution hypothesis when appropriate
8. Verify the hypothesis based on the Chain of Thought steps
9. Repeat the process until satisfied with the solution
10. Provide a single, ideally correct answer as the final output
11. Only set nextThoughtNeeded to false when truly done and a satisfactory answer is reached

Async Research - Fork workers to think concurrently while you continue reasoning:

Use forkResearch to delegate sub-queries. Workers run in parallel while you keep thinking.
Use readResearch to inject completed results. Use waitFor to block until specific work completes.
Final thought auto-waits for all pending research.

Worker types:
- type:"gemini" (2-30s) - Fast feedback, critique, web search, or deep collaboration with files
  workerType: "feedback" | "critique" | "web" | "collaborate"
  For collaborate: include files:[] and context:"" for richer understanding
- type:"claude" (45-90s) - Full capability: codebase, docs, complex research

The structure is yours to decide. Fork when sub-queries can run independently.
Join results when you need them. Revise your thinking based on what you learn.`,
    inputSchema: {
      // Sequential Thinking core
      thought: z.string().describe("Your current thinking step"),
      nextThoughtNeeded: z.boolean().describe("Whether another thought step is needed"),
      thoughtNumber: z.number().int().min(1).describe("Current thought number"),
      totalThoughts: z.number().int().min(1).describe("Estimated total thoughts needed"),
      isRevision: z.boolean().optional().describe("Whether this revises previous thinking"),
      revisesThought: z.number().int().min(1).optional().describe("Which thought is being reconsidered"),
      branchFromThought: z.number().int().min(1).optional().describe("Branching point thought number"),
      branchId: z.string().optional().describe("Branch identifier"),
      needsMoreThoughts: z.boolean().optional().describe("If more thoughts are needed"),

      // Async Research enhancement
      forkResearch: z.object({
        id: z.string().describe("Unique ID for this research task"),
        topic: z.string().describe("Topic to research or message for collaboration"),
        type: z.enum(['claude', 'gemini']).optional().default('claude')
          .describe("Worker type: 'claude' (full capability, 45-90s) or 'gemini' (fast, 2-5s)"),
        workerType: z.enum(['feedback', 'critique', 'web', 'collaborate']).optional()
          .describe("For Gemini: 'feedback', 'critique', 'web', or 'collaborate' (deep context with files)"),
        hint: z.string().optional().describe("Optional hint for focus/decomposition"),
        files: z.array(z.string()).optional()
          .describe("File paths to upload to Gemini for context (collaborate mode)"),
        context: z.string().optional()
          .describe("Additional context/explanation for collaboration"),
      }).optional().describe("Fork a research task"),

      readResearch: z.string().optional().describe("Research ID to read and inject results"),

      waitFor: z.array(z.string()).optional().describe("Research IDs to wait for before continuing"),
    },
    outputSchema: {
      thoughtNumber: z.number(),
      totalThoughts: z.number(),
      nextThoughtNeeded: z.boolean(),
      branches: z.array(z.string()),
      thoughtHistoryLength: z.number(),
      research: z.object({
        pending: z.array(z.string()),
        completed: z.array(z.string()),
        failed: z.array(z.string()),
      }),
      researchResults: z.array(z.object({
        id: z.string(),
        topic: z.string(),
        workers: z.array(z.object({
          type: z.string(),
          query: z.string(),
          result: z.string(),
        })).optional(),
        synthesis: z.string().optional(),
        error: z.string().optional(),
      })).optional(),
      reminder: z.string().optional(),
    },
  },
  async (args) => {
    try {
      // Check for completed workers and timeouts
      checkAndCollectResults();
      checkTimeouts();

      // Handle forkResearch - spawn appropriate worker type
      if (args.forkResearch) {
        const { id, topic, type = 'claude', workerType, hint, files, context } = args.forkResearch;
        const scopedId = scopeTaskId(id);

        // Check if research ID already exists in this session
        if (ledger.hasTask(scopedId)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Research ID '${id}' already exists. Use a unique ID.`,
                status: 'failed'
              }, null, 2)
            }],
            isError: true
          };
        }

        // Route to appropriate worker type
        if (type === 'gemini') {
          // Gemini workers require workerType
          const geminiWorkerType = workerType || 'feedback';

          // Check if Gemini is available
          if (!GeminiClient.isAvailable()) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: `Gemini API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable.`,
                  status: 'failed'
                }, null, 2)
              }],
              isError: true
            };
          }

          // Fire Gemini worker (don't await - let it run async like Claude workers)
          executeGeminiWorker(scopedId, topic, geminiWorkerType, hint, files, context)
            .then(() => console.error(`[AsyncThink] Gemini worker completed: ${id}`))
            .catch(err => console.error(`[AsyncThink] Gemini worker failed: ${id}: ${err.message}`));
          console.error(`[AsyncThink] Forked Gemini worker: ${id} (type: ${geminiWorkerType}, files: ${files?.length || 0})`);
        } else {
          // Spawn Claude Code organizer worker (async, 45-90s)
          await spawnOrganizerWorker(scopedId, topic, hint);
          console.error(`[AsyncThink] Forked Claude Code research: ${id} (scoped: ${scopedId})`);
        }
      }

      // Determine what IDs to wait for (scope them for ledger lookup)
      let idsToWaitFor = (args.waitFor || []).map(id => scopeTaskId(id));

      // FINAL THOUGHT: Auto-wait for ALL pending research in this session
      if (!args.nextThoughtNeeded) {
        const allTasks = ledger.getTasksByStatus('pending')
          .concat(ledger.getTasksByStatus('running'))
          .filter(t => isCurrentSession(t.id));

        if (allTasks.length > 0) {
          const pendingIds = allTasks.map(t => t.id);
          console.error(`[AsyncThink] Final thought - auto-waiting for pending research: ${pendingIds.map(unscopeTaskId).join(', ')}`);
          idsToWaitFor = [...new Set([...idsToWaitFor, ...pendingIds])];
        }
      }

      // Handle waitFor - block until specified research completes
      if (idsToWaitFor.length > 0) {
        const maxWaitMs = config.getValue('workerTimeoutMs');
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitMs) {
          checkAndCollectResults();
          checkTimeouts();

          const stillPending = idsToWaitFor.filter(scopedId => {
            const task = ledger.getTask(scopedId);
            return task && (task.status === 'pending' || task.status === 'running');
          });

          if (stillPending.length === 0) {
            break; // All done
          }

          // Wait a bit before checking again
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Collect research results
      const researchResults: Array<{
        id: string;
        topic: string;
        workers?: Array<{ type: string; query: string; result: string }>;
        synthesis?: string;
        error?: string;
      }> = [];

      // Gather results for explicit readResearch (scope for ledger lookup)
      if (args.readResearch) {
        const scopedReadId = scopeTaskId(args.readResearch);
        const result = ledger.getResult(scopedReadId);
        if (result) {
          // Unscope the ID for output
          researchResults.push({ ...result, id: unscopeTaskId(result.id) });
        }
      }

      // Gather results for waitFor IDs
      for (const scopedId of idsToWaitFor) {
        const unscopedId = unscopeTaskId(scopedId);
        if (unscopedId !== args.readResearch) { // Avoid duplicates
          const result = ledger.getResult(scopedId);
          if (result) {
            // Unscope the ID for output
            researchResults.push({ ...result, id: unscopedId });
          }
        }
      }

      // FINAL THOUGHT: Auto-inject ALL completed AND failed research from this session
      if (!args.nextThoughtNeeded) {
        // Get completed tasks
        const completedTasks = ledger.getTasksByStatus('complete')
          .filter(t => isCurrentSession(t.id));

        for (const task of completedTasks) {
          const unscopedId = unscopeTaskId(task.id);
          if (researchResults.some(r => r.id === unscopedId)) continue;

          const result = ledger.getResult(task.id);
          if (result) {
            researchResults.push({ ...result, id: unscopedId });
          }
        }

        // Also inject failed tasks so the user knows what went wrong
        const failedTasks = ledger.getTasksByStatus('failed')
          .filter(t => isCurrentSession(t.id));

        for (const task of failedTasks) {
          const unscopedId = unscopeTaskId(task.id);
          if (researchResults.some(r => r.id === unscopedId)) continue;

          const result = ledger.getResult(task.id);
          if (result) {
            researchResults.push({ ...result, id: unscopedId });
          }
        }
      }

      // Process the thought through sequential thinking
      const thoughtResult = thinkingServer.processThought({
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

      if (thoughtResult.isError) {
        return thoughtResult;
      }

      // Parse the sequential thinking result
      const parsedThought = JSON.parse(thoughtResult.content[0].text);

      // Get research status from ledger (filtered to current session, unscoped IDs)
      const allPending = ledger.getTasksByStatus('pending')
        .concat(ledger.getTasksByStatus('running'))
        .filter(t => isCurrentSession(t.id))
        .map(t => unscopeTaskId(t.id));
      const allCompleted = ledger.getTasksByStatus('complete')
        .filter(t => isCurrentSession(t.id))
        .map(t => unscopeTaskId(t.id));
      const allFailed = ledger.getTasksByStatus('failed')
        .filter(t => isCurrentSession(t.id))
        .map(t => unscopeTaskId(t.id));

      const researchStatus = {
        pending: allPending,
        completed: allCompleted,
        failed: allFailed,
      };

      // Generate reminder for current session only
      const reminderParts: string[] = [];
      if (allCompleted.length > 0) {
        reminderParts.push(`Research completed: ${allCompleted.join(', ')}. Use readResearch to see results.`);
      }
      if (allFailed.length > 0) {
        reminderParts.push(`Research FAILED: ${allFailed.join(', ')}. Check researchResults for errors.`);
      }
      if (allPending.length > 0) {
        reminderParts.push(`Research pending: ${allPending.join(', ')}`);
      }
      const reminder = reminderParts.length > 0 ? reminderParts.join(' ') : undefined;

      // Build the extended output
      const output = {
        ...parsedThought,
        research: researchStatus,
        ...(researchResults.length > 0 && { researchResults }),
        ...(reminder && { reminder }),
      };

      // FINAL THOUGHT: Cleanup - delete only THIS session's tasks from ledger
      if (!args.nextThoughtNeeded) {
        const sessionCompleted = ledger.getTasksByStatus('complete')
          .filter(t => isCurrentSession(t.id))
          .map(t => t.id);
        const sessionFailed = ledger.getTasksByStatus('failed')
          .filter(t => isCurrentSession(t.id))
          .map(t => t.id);
        const toCleanup = [...sessionCompleted, ...sessionFailed];

        if (toCleanup.length > 0) {
          console.error(`[AsyncThink] Final thought - cleaning up ${toCleanup.length} session tasks`);
          for (const id of toCleanup) {
            ledger.deleteTask(id);
          }
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(output, null, 2)
        }],
        structuredContent: output
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            status: 'failed'
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// =============================================================================
// Configuration Tool
// =============================================================================

server.registerTool(
  "asyncthink_config",
  {
    title: "AsyncThink Configuration",
    description: `View and update AsyncThink configuration.

Use this tool to:
- Enable/disable Gemini workers
- Change the default Gemini model
- Adjust worker timeouts
- Set default worker count (max 3)

Configuration is persisted to ~/.local/share/asyncthink/config.json`,
    inputSchema: {
      action: z.enum(['get', 'set', 'reset']).describe("Action to perform"),
      settings: z.object({
        enableGemini: z.boolean().optional().describe("Enable Gemini workers (requires API key)"),
        geminiModel: z.string().optional().describe("Gemini model (default: gemini-3-pro-preview)"),
        geminiTimeoutMs: z.number().min(5000).max(60000).optional().describe("Gemini timeout in ms (5000-60000)"),
        workerTimeoutMs: z.number().min(30000).max(300000).optional().describe("Claude Code worker timeout in ms (30000-300000)"),
        defaultWorkerCount: z.number().min(1).max(3).optional().describe("Default sub-queries per task (1-3)"),
        logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional().describe("Log level"),
      }).optional().describe("Settings to update (only for 'set' action)"),
    },
    outputSchema: {
      status: z.string(),
      config: z.object({
        enableGemini: z.boolean(),
        geminiModel: z.string(),
        geminiTimeoutMs: z.number(),
        workerTimeoutMs: z.number(),
        defaultWorkerCount: z.number(),
        logLevel: z.string(),
        geminiAvailable: z.boolean(),
        configPath: z.string(),
      }).optional(),
      error: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const { action, settings } = args;

      if (action === 'get') {
        const currentConfig = config.get();
        const output = {
          status: 'ok',
          config: {
            enableGemini: currentConfig.enableGemini,
            geminiModel: currentConfig.geminiModel,
            geminiTimeoutMs: currentConfig.geminiTimeoutMs,
            workerTimeoutMs: currentConfig.workerTimeoutMs,
            defaultWorkerCount: currentConfig.defaultWorkerCount,
            logLevel: currentConfig.logLevel,
            geminiAvailable: GeminiClient.isAvailable(),
            configPath: config.getConfigPath(),
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      if (action === 'set') {
        if (!settings || Object.keys(settings).length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: 'error', error: 'No settings provided' }, null, 2) }],
            isError: true,
          };
        }

        // Validate defaultWorkerCount max of 3
        if (settings.defaultWorkerCount !== undefined && settings.defaultWorkerCount > 3) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: 'error', error: 'defaultWorkerCount cannot exceed 3' }, null, 2) }],
            isError: true,
          };
        }

        config.update(settings);

        const currentConfig = config.get();
        const output = {
          status: 'updated',
          config: {
            enableGemini: currentConfig.enableGemini,
            geminiModel: currentConfig.geminiModel,
            geminiTimeoutMs: currentConfig.geminiTimeoutMs,
            workerTimeoutMs: currentConfig.workerTimeoutMs,
            defaultWorkerCount: currentConfig.defaultWorkerCount,
            logLevel: currentConfig.logLevel,
            geminiAvailable: GeminiClient.isAvailable(),
            configPath: config.getConfigPath(),
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      if (action === 'reset') {
        config.reset();

        const currentConfig = config.get();
        const output = {
          status: 'reset to defaults',
          config: {
            enableGemini: currentConfig.enableGemini,
            geminiModel: currentConfig.geminiModel,
            geminiTimeoutMs: currentConfig.geminiTimeoutMs,
            workerTimeoutMs: currentConfig.workerTimeoutMs,
            defaultWorkerCount: currentConfig.defaultWorkerCount,
            logLevel: currentConfig.logLevel,
            geminiAvailable: GeminiClient.isAvailable(),
            configPath: config.getConfigPath(),
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: 'error', error: `Unknown action: ${action}` }, null, 2) }],
        isError: true,
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }, null, 2) }],
        isError: true,
      };
    }
  }
);

// =============================================================================
// Server Runner
// =============================================================================

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AsyncThink MCP Server running on stdio");
  console.error(`Data directory: ${config.getDataDir()}`);
  console.error(`Gemini available: ${GeminiClient.isAvailable()}`);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
