/**
 * delegate tools — single-subordinate threaded conversation handoff.
 *
 * Registers four tools:
 *   - delegate              (open or continue a thread; optional inline close)
 *   - delegate_close        (close one thread)
 *   - delegate_close_all    (close every open thread)
 *   - delegate_list_threads (introspection)
 *
 * Threading discipline reminders are baked into both the tool descriptions
 * and the `reminder` field on every delegate response. Defense-in-depth
 * against thread leakage:
 *   1. inline `close: true` flag for one-round-trip closure
 *   2. explicit delegate_close / delegate_close_all tools
 *   3. idle sweeper at 6h (Phase 2.3) on every tool invocation
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDelegate, getThreadStore } from '../app.js';
import { sweepIdleOnce } from '../delegate/sweeper.js';

const DELEGATE_DESCRIPTION = `Hand a focused task to a single subordinate model CLI (claude, gemini, or codex). \
The conversation runs as a thread you can continue across multiple calls by passing the returned threadId back in.

CLOSE THE THREAD WHEN DONE. Either set close: true on the final delegate call, or call delegate_close({threadId}) afterward. \
Idle threads are auto-swept after 6 hours.

Read-only by design — subordinates can read files but cannot edit, exec, or write. \
Use this for second opinions, focused research, code review, or any task where a different model's perspective adds value.`;

export function registerDelegateTools(server: McpServer): void {
  server.registerTool(
    'delegate',
    {
      title: 'Delegate',
      description: DELEGATE_DESCRIPTION,
      inputSchema: {
        adapter: z
          .enum(['claude', 'gemini', 'codex'])
          .describe('Subordinate to dispatch to.'),
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
          .describe('Optional skill id (resolved by the registry; Phase 4).'),
        close: z
          .boolean()
          .optional()
          .describe('Close the thread immediately after this turn.'),
        cwd: z.string().optional().describe('Override the working directory.'),
        timeoutMs: z.number().int().min(1_000).optional(),
        model: z.string().optional().describe('Override the adapter default model.'),
      },
    },
    async (args) => {
      await sweepIdleOnce();
      const result = await getDelegate().run({
        adapter: args.adapter,
        prompt: args.prompt,
        threadId: args.threadId,
        files: args.files,
        skill: args.skill,
        close: args.close,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
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
