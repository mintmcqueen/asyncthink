/**
 * Delegate — single-subordinate threaded conversation handoff.
 *
 * Opens or continues a thread, dispatches one turn to the named adapter,
 * persists user + assistant turns to the ThreadStore, optionally closes the
 * thread, and returns the response.
 *
 * Resume strategy is per-adapter (declared on the Adapter):
 *  - 'native' adapters (codex): the orchestrator passes the prior assistant
 *    turn's sessionId; the adapter uses its CLI's resume primitive.
 *  - 'replay' adapters (claude, gemini): the orchestrator serializes prior
 *    turns into the prompt itself before invoking.
 */

import { randomUUID } from 'crypto';
import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { Executor } from '../core/executor.js';
import type { IntelligenceTier } from '../core/manifests.js';
import type { ThreadStore, ThreadTurn } from '../core/threadStore.js';

export interface DelegateRequest {
  adapter: string;
  prompt: string;
  threadId?: string;
  files?: string[];
  /** Optional skill id; resolved by SkillRegistry in Phase 4 (ignored here). */
  skill?: string;
  /** If true, close the thread immediately after this turn. */
  close?: boolean;
  /** Optional cwd override; defaults to the server's cwd. */
  cwd?: string;
  /** Optional timeout override in ms. */
  timeoutMs?: number;
  /** Intelligence tier — preferred over raw model id. */
  intelligence?: IntelligenceTier;
  /** Raw model id override (escape hatch); wins over `intelligence`. */
  model?: string;
}

export interface DelegateResponse {
  threadId: string;
  adapter: string;
  output: string;
  sessionId: string;
  closed: boolean;
  turn: number;
  exitCode: number;
  durationMs: number;
  reminder: string;
}

export interface AdapterLookup {
  get(id: string): Adapter | undefined;
  list(): Adapter[];
}

const REMINDER_OPEN =
  'Thread is open. Call delegate_close({threadId}) when this conversation is done. ' +
  'Idle threads are auto-swept after 6 hours.';
const REMINDER_CLOSED = 'Thread closed.';

export class Delegate {
  constructor(
    private readonly adapters: AdapterLookup,
    private readonly threadStore: ThreadStore,
    private readonly executor: Executor,
    private readonly auditLog?: AuditLog
  ) {}

  async run(req: DelegateRequest): Promise<DelegateResponse> {
    const adapter = this.adapters.get(req.adapter);
    if (!adapter) {
      const known = this.adapters.list().map((a) => a.id).join(', ');
      throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
    }

    const threadId = req.threadId ?? newThreadId();
    const wasNew = (await this.threadStore.read(threadId)).length === 0;
    await this.threadStore.open(threadId, adapter.id);
    if (wasNew) {
      await this.auditLog?.record({
        kind: 'thread.open',
        threadId,
        adapter: adapter.id,
      });
    }
    const history = await this.threadStore.read(threadId);

    let effectivePrompt = req.prompt;
    let sessionId: string | undefined;
    if (history.length > 0) {
      if (adapter.resumeStrategy === 'native') {
        sessionId = lastAssistantSessionId(history);
      } else {
        effectivePrompt = renderReplay(history, req.prompt);
      }
    }

    const userTurn: ThreadTurn = {
      ts: new Date().toISOString(),
      role: 'user',
      adapter: adapter.id,
      content: req.prompt,
    };
    await this.threadStore.append(threadId, userTurn);

    const result = await adapter.invoke(
      {
        prompt: effectivePrompt,
        files: req.files,
        sessionId,
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        intelligence: req.intelligence,
        model: req.model,
      },
      this.executor
    );

    const assistantTurn: ThreadTurn = {
      ts: new Date().toISOString(),
      role: 'assistant',
      adapter: adapter.id,
      sessionId: result.sessionId,
      content: result.text,
      meta: { durationMs: result.durationMs, exitCode: result.exitCode },
    };
    await this.threadStore.append(threadId, assistantTurn);

    await this.auditLog?.record({
      kind: 'invoke',
      adapter: adapter.id,
      durationMs: result.durationMs,
      threadId,
      error: result.exitCode !== 0 ? `exit code ${result.exitCode}` : undefined,
    });

    const closed = !!req.close;
    if (closed) {
      await this.threadStore.close(threadId);
      await this.auditLog?.record({
        kind: 'thread.close',
        threadId,
        adapter: adapter.id,
      });
    }

    return {
      threadId,
      adapter: adapter.id,
      output: result.text,
      sessionId: result.sessionId,
      closed,
      // Each turn = one user + one assistant pair. After this call, history
      // length doubled. Turn number = (history.length / 2) + 1.
      turn: Math.floor(history.length / 2) + 1,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      reminder: closed ? REMINDER_CLOSED : REMINDER_OPEN,
    };
  }
}

function newThreadId(): string {
  // Short, file-system-safe thread id. Collisions are practically impossible
  // and the orchestrator is the only writer.
  return `t-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function lastAssistantSessionId(history: ThreadTurn[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant' && history[i].sessionId) {
      return history[i].sessionId;
    }
  }
  return undefined;
}

function renderReplay(history: ThreadTurn[], newPrompt: string): string {
  const lines = ['<conversation>'];
  for (const t of history) {
    const tag = t.role === 'user' ? 'user' : 'assistant';
    lines.push(`<${tag}>`, t.content, `</${tag}>`);
  }
  lines.push('</conversation>');
  lines.push('');
  lines.push(newPrompt);
  return lines.join('\n');
}
