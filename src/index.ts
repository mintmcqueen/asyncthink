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
    description: `A detailed tool for dynamic and reflective problem-solving through thoughts,
enhanced with async research workers that run in parallel.

## Core: Sequential Thinking
This tool helps analyze problems through a flexible thinking process that can adapt and evolve.
Each thought can build on, question, or revise previous insights as understanding deepens.

When to use this tool:
- Breaking down complex problems into steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope might not be clear initially
- Multi-step solutions that need context over steps
- Situations where irrelevant information needs to be filtered out

Key sequential thinking features:
- Adjust totalThoughts up or down as you progress
- Question or revise previous thoughts
- Add more thoughts even after reaching what seemed like the end
- Express uncertainty and explore alternative approaches
- Branch or backtrack - not every thought needs to build linearly
- Generate and verify hypotheses

## Enhancement: Async Research Workers
Fork research tasks that run in parallel while you continue thinking.
Two worker types available:

### Claude Code Workers (type: "claude") - 45-90 seconds
Full capability subprocess with ALL tools. Use for:
- **Repo/codebase investigations** (Read, Grep, Glob)
- **Documentation research** (mcp__context7, mcp__deepwiki, mcp__repo-rag)
- **Complex multi-step tasks** requiring tool chains
- **Sidebar todos** that shouldn't block main thinking

### Gemini Workers (type: "gemini") - 2-5 seconds
Fast direct API calls. **REQUIRED** for:
- **Metacognitive feedback** (workerType: "feedback") - Get alternative perspectives on your reasoning
- **Critique/challenge** (workerType: "critique") - Stress-test your conclusions
- **Web research** (workerType: "web") - Grounded Google Search for current info

**IMPORTANT: Use Gemini workers for collaboration/feedback. Gemini can also do web research with grounded search.**

Research workflow:
1. **Fork**: Use forkResearch with type ("claude" or "gemini") and workerType for Gemini
2. **Continue**: Keep thinking - Claude workers take 45-90s, Gemini takes 2-5s
3. **Check**: OUTPUT includes research.completed when workers finish
4. **Wait**: Use waitFor: ["id"] to BLOCK until research completes
5. **Read**: Use readResearch to inject results into thought stream

**CRITICAL for Claude workers: They take 45-90 seconds. Use waitFor mid-sequence if you need results.**
**Gemini workers complete in 2-5 seconds - results usually ready by next thought.**

## Parameters

### Sequential Thinking (core)
- thought: Your current thinking step (analysis, revision, hypothesis, etc.)
- thoughtNumber: Current number in sequence (1, 2, 3...)
- totalThoughts: Estimate of thoughts needed (adjustable)
- nextThoughtNeeded: True if more thinking needed
- isRevision: True if this revises previous thinking
- revisesThought: Which thought is being reconsidered
- branchFromThought: Branching point thought number
- branchId: Identifier for the current branch
- needsMoreThoughts: If reaching end but need more thoughts

### Async Research (enhancement)
- forkResearch: { id, topic, type?, workerType?, hint? } - Fork a research task
  - type: "claude" (default, full capability) or "gemini" (fast feedback/web)
  - workerType: For Gemini only - "feedback" | "critique" | "web"
- readResearch: string - ID of research to inject into thought stream
- waitFor: string[] - Block until these research IDs complete

## Output
Returns:
- thoughtNumber, totalThoughts, nextThoughtNeeded (from input)
- branches: List of branch IDs
- thoughtHistoryLength: Number of thoughts so far
- research: { pending: string[], completed: string[] }
- researchResults: Injected results (if readResearch/waitFor used)
- reminder: Status message about pending/completed research

## Final Thought Behavior (nextThoughtNeeded: false)
When ending a thinking session:
1. **Auto-wait**: Automatically waits for ALL pending research to complete
2. **Auto-inject**: All completed research results are injected into output
3. **Cleanup**: All session tasks are deleted from ledger to prevent pollution

## Example Workflows

### Claude Code Worker (Repo Research)
Thought 1: "Need to understand this codebase structure."
  → forkResearch: { id: "repo", type: "claude", topic: "Explore src/ directory structure and key services" }

Thought 2: "While that runs (45-90s), I'll review what I already know..."
  → research.pending: ["repo"]

Thought 3: "Let me wait for the codebase analysis."
  → waitFor: ["repo"]
  → researchResults with codebase findings

### Gemini Worker (Metacognitive Feedback)
Thought 1: "I think the bug is in the rate limiter because X, Y, Z..."
  → forkResearch: { id: "critique", type: "gemini", workerType: "critique", topic: "My reasoning: The bug is in rate limiter because..." }

Thought 2: "Gemini feedback is ready (2-5s). Let me check."
  → research.completed: ["critique"]
  → readResearch: "critique"
  → Gemini suggests: "Consider also: connection pooling, timeout handling..."

### Gemini Worker (Web Research)
Thought 1: "Need current info on arXiv API changes."
  → forkResearch: { id: "web", type: "gemini", workerType: "web", topic: "arXiv API changes 2024 2025" }

Thought 2: "Web research is ready. Let me review."
  → research.completed: ["web"]
  → researchResults with grounded search findings`,
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
        topic: z.string().describe("Topic to research"),
        type: z.enum(['claude', 'gemini']).optional().default('claude')
          .describe("Worker type: 'claude' (full capability, 45-90s) or 'gemini' (fast, 2-5s)"),
        workerType: z.enum(['feedback', 'critique', 'web']).optional()
          .describe("For Gemini only: 'feedback' (metacognitive), 'critique' (devil's advocate), 'web' (grounded search)"),
        hint: z.string().optional().describe("Optional hint for focus/decomposition"),
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
        const { id, topic, type = 'claude', workerType, hint } = args.forkResearch;
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

          // Execute Gemini worker (fast, synchronous)
          await executeGeminiWorker(scopedId, topic, geminiWorkerType, hint);
          console.error(`[AsyncThink] Executed Gemini worker: ${id} (type: ${geminiWorkerType})`);
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
