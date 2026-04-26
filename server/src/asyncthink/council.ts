/**
 * Council — parallel competitor forks for an asyncthink chain.
 *
 * Each chain has a parentThreadId. Forks within the chain are child threads
 * named `<parentThreadId>::<forkId>`. Tasks in the TaskStore use the same
 * scoping so concurrent chains do not collide.
 *
 * Forks are fire-and-forget: `fork()` returns immediately after registering
 * the in-flight promise. Results land in the TaskStore as the adapter
 * promises resolve. Callers retrieve results via `getResult` or block until
 * complete via `waitFor`. On chain end, `endChain` waits for any remaining
 * in-flight forks (up to a timeout), closes all child threads, and prunes
 * the chain's tasks from the store.
 */

import { randomUUID } from 'crypto';
import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { Executor } from '../core/executor.js';
import type { TaskState, TaskStatus, TaskStore } from '../core/taskStore.js';
import type { ThreadStore } from '../core/threadStore.js';

export interface AdapterLookup {
  get(id: string): Adapter | undefined;
  list(): Adapter[];
}

export interface ForkRequest {
  id: string;
  adapter: string;
  prompt: string;
  files?: string[];
  model?: string;
  /** Skill id; ignored at council level (resolved by tool layer in Phase 4). */
  skill?: string;
  /** Set automatically by tool handler. */
  parentThreadId: string;
  /** Thought number that spawned this fork. */
  thoughtNumber: number;
}

export interface ChainStatus {
  pending: string[];
  complete: string[];
  failed: string[];
}

export interface CouncilResult {
  id: string;
  adapter: string;
  output: string;
  status: TaskStatus;
  error?: string;
  durationMs?: number;
}

export class Council {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly adapters: AdapterLookup,
    private readonly threadStore: ThreadStore,
    private readonly taskStore: TaskStore,
    private readonly executor: Executor,
    private readonly auditLog?: AuditLog
  ) {}

  newChain(): string {
    return `chain-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  /** Spawn a fork. Resolves once the task is registered (not when it completes). */
  async fork(req: ForkRequest): Promise<void> {
    const adapter = this.adapters.get(req.adapter);
    if (!adapter) {
      const known = this.adapters.list().map((a) => a.id).join(', ');
      throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
    }
    const taskId = this.scopeId(req.parentThreadId, req.id);
    if (await this.taskStore.get(taskId)) {
      throw new Error(`Fork id "${req.id}" already exists in chain ${req.parentThreadId}`);
    }
    await this.taskStore.create(taskId, req.prompt);
    await this.taskStore.update(taskId, {
      status: 'running',
      forkThought: req.thoughtNumber,
      adapter: req.adapter,
    });

    const childThreadId = taskId;
    const promise = this.runFork(adapter, childThreadId, taskId, req).finally(() => {
      this.inflight.delete(taskId);
    });
    this.inflight.set(taskId, promise);
  }

  private async runFork(
    adapter: Adapter,
    childThreadId: string,
    taskId: string,
    req: ForkRequest
  ): Promise<void> {
    try {
      await this.threadStore.open(childThreadId, adapter.id);
      await this.auditLog?.record({
        kind: 'thread.open',
        threadId: childThreadId,
        adapter: adapter.id,
      });
      await this.threadStore.append(childThreadId, {
        ts: new Date().toISOString(),
        role: 'user',
        adapter: adapter.id,
        content: req.prompt,
      });
      const result = await adapter.invoke(
        {
          prompt: req.prompt,
          files: req.files,
          model: req.model,
        },
        this.executor
      );
      await this.threadStore.append(childThreadId, {
        ts: new Date().toISOString(),
        role: 'assistant',
        adapter: adapter.id,
        sessionId: result.sessionId,
        content: result.text,
        meta: { durationMs: result.durationMs, exitCode: result.exitCode },
      });
      await this.taskStore.update(taskId, {
        status: result.exitCode === 0 ? 'complete' : 'failed',
        result: result.text,
        error: result.exitCode !== 0 ? `exit code ${result.exitCode}` : undefined,
        durationMs: result.durationMs,
      });
      await this.auditLog?.record({
        kind: 'invoke',
        adapter: adapter.id,
        durationMs: result.durationMs,
        threadId: childThreadId,
        error: result.exitCode !== 0 ? `exit code ${result.exitCode}` : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.taskStore.update(taskId, {
        status: 'failed',
        error: message,
      });
      await this.auditLog?.record({
        kind: 'invoke',
        adapter: adapter.id,
        durationMs: 0,
        threadId: childThreadId,
        error: message,
      });
    }
  }

  /** Wait for any of the named forks (chain-scoped) to settle, up to timeoutMs. */
  async waitFor(forkIds: string[], parentThreadId: string, timeoutMs: number): Promise<void> {
    const promises = forkIds
      .map((id) => this.inflight.get(this.scopeId(parentThreadId, id)))
      .filter((p): p is Promise<void> => p !== undefined);
    if (promises.length === 0) return;
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async getResult(forkId: string, parentThreadId: string): Promise<CouncilResult | undefined> {
    const state = await this.taskStore.get(this.scopeId(parentThreadId, forkId));
    if (!state) return undefined;
    return resultFromTask(state, forkId, parentThreadId);
  }

  async chainStatus(parentThreadId: string): Promise<ChainStatus> {
    const prefix = `${parentThreadId}::`;
    const trim = (id: string) => id.slice(prefix.length);
    const pending: string[] = [];
    const complete: string[] = [];
    const failed: string[] = [];
    for (const t of await this.taskStore.byStatus('pending')) {
      if (t.id.startsWith(prefix)) pending.push(trim(t.id));
    }
    for (const t of await this.taskStore.byStatus('running')) {
      if (t.id.startsWith(prefix)) pending.push(trim(t.id));
    }
    for (const t of await this.taskStore.byStatus('complete')) {
      if (t.id.startsWith(prefix)) complete.push(trim(t.id));
    }
    for (const t of await this.taskStore.byStatus('failed')) {
      if (t.id.startsWith(prefix)) failed.push(trim(t.id));
    }
    return { pending, complete, failed };
  }

  /** Wait for all pending forks in the chain, close child threads, prune tasks. */
  async endChain(parentThreadId: string, timeoutMs: number): Promise<CouncilResult[]> {
    const prefix = `${parentThreadId}::`;
    const promises: Promise<void>[] = [];
    for (const [tid, p] of this.inflight) {
      if (tid.startsWith(prefix)) promises.push(p);
    }
    if (promises.length > 0) {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }

    const results: CouncilResult[] = [];
    for (const status of ['complete', 'failed', 'running', 'pending'] as const) {
      for (const t of await this.taskStore.byStatus(status)) {
        if (!t.id.startsWith(prefix)) continue;
        const forkId = t.id.slice(prefix.length);
        const r = resultFromTask(t, forkId, parentThreadId);
        if (r) results.push(r);
      }
    }

    // Close child threads.
    for (const t of await this.threadStore.list()) {
      if (t.threadId.startsWith(prefix)) {
        await this.threadStore.close(t.threadId);
        await this.auditLog?.record({
          kind: 'thread.close',
          threadId: t.threadId,
          adapter: t.adapter,
        });
      }
    }
    // Prune tasks from the store.
    for (const r of results) {
      await this.taskStore.delete(this.scopeId(parentThreadId, r.id));
    }
    return results;
  }

  private scopeId(parentThreadId: string, forkId: string): string {
    return `${parentThreadId}::${forkId}`;
  }
}

function resultFromTask(
  state: TaskState,
  forkId: string,
  _parentThreadId: string
): CouncilResult | undefined {
  return {
    id: forkId,
    adapter: state.adapter ?? 'unknown',
    output: state.result ?? '',
    status: state.status,
    error: state.error,
    durationMs: state.durationMs,
  };
}
