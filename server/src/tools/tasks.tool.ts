/**
 * MCP Tasks RPC tool surface (v2.2 — R2-D.1, R4-D).
 *
 * Wraps the SDK's MCP Tasks protocol primitive (SEP-1686) with user-callable
 * tool aliases:
 *   - tasks_get      → snapshot a task's current status
 *   - tasks_list     → enumerate tasks (cursor-paginated, principal-bound)
 *   - tasks_cancel   → best-effort cancellation (R-DUR-D.5)
 *   - tasks_result   → block until terminal, return the underlying CallToolResult
 *
 * These tools delegate to the singleton `LocalInProcessTaskExecutor` (R3-D.1).
 * The naming convention uses underscores (rather than slashes) so the tools
 * are callable via Claude Code's `mcp__<server>__<tool>` namespace; the SDK
 * itself ALSO auto-wires the wire-level `tasks/get|list|cancel|result` RPC
 * verbs whenever a TaskStore is supplied to the McpServer's options. Both
 * surfaces talk to the same `TaskExecutor` so observable state is identical.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTaskExecutor } from '../app.js';
import { sweepIdleOnce } from '../delegate/sweeper.js';
import { TaskNotFoundError, TaskOwnerMismatchError } from '../core/taskExecutor.js';

export function registerTasksTools(server: McpServer): void {
  server.registerTool(
    'tasks_get',
    {
      title: 'Tasks Get',
      description:
        'Snapshot the current status of an async task created by delegate({async:true}) or council forks. Returns status (working|completed|failed|cancelled), createdAt, lastUpdatedAt, ttlMs, and any current error. Idempotent.',
      inputSchema: {
        taskId: z.string().describe('Task id returned by a previous async create call.'),
      },
    },
    async (args) => {
      await sweepIdleOnce();
      try {
        const state = await getTaskExecutor().get(args.taskId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }],
          structuredContent: state as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorEnvelope(err);
      }
    }
  );

  server.registerTool(
    'tasks_list',
    {
      title: 'Tasks List',
      description:
        'List async tasks with cursor pagination. v2.2 single-tenant: returns every task owned by `principal: null`. Use `cursor` from a prior response to fetch the next page; default page size is 50.',
      inputSchema: {
        cursor: z.string().optional().describe('Pagination cursor from a prior tasks_list call.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Page size cap (default 50, max 200).'),
      },
    },
    async (args) => {
      await sweepIdleOnce();
      const result = await getTaskExecutor().list({
        cursor: args.cursor,
        limit: args.limit,
        principal: null,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    'tasks_cancel',
    {
      title: 'Tasks Cancel',
      description:
        'Best-effort cancel an in-flight task. Flips state to "cancelled" immediately and signals SIGTERM to the underlying subprocess (R-DUR-D.5). Idempotent: cancelling a terminal task is a no-op that returns its current state.',
      inputSchema: {
        taskId: z.string(),
      },
    },
    async (args) => {
      await sweepIdleOnce();
      try {
        const state = await getTaskExecutor().cancel(args.taskId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }],
          structuredContent: state as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorEnvelope(err);
      }
    }
  );

  server.registerTool(
    'tasks_result',
    {
      title: 'Tasks Result',
      description:
        'Block until the task reaches a terminal state, then return its full state including result text, exitCode, durationMs, and continuation sessionId. Cancelled or failed tasks return a state with `error` populated. Use tasks_get if you need a non-blocking snapshot.',
      inputSchema: {
        taskId: z.string(),
      },
    },
    async (args) => {
      await sweepIdleOnce();
      try {
        const state = await getTaskExecutor().result(args.taskId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }],
          structuredContent: state as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorEnvelope(err);
      }
    }
  );
}

function errorEnvelope(err: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
  structuredContent: Record<string, unknown>;
} {
  if (err instanceof TaskNotFoundError) {
    const payload = { error: 'task_not_found', message: err.message };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
      structuredContent: payload,
    };
  }
  if (err instanceof TaskOwnerMismatchError) {
    const payload = { error: 'task_owner_mismatch', message: err.message };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
      structuredContent: payload,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const payload = { error: 'task_error', message };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
    structuredContent: payload,
  };
}
