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
import { AdapterError } from '../core/adapterError.js';
import type { AuditLog } from '../core/auditLog.js';
import type { Executor } from '../core/executor.js';
import type { IntelligenceTier, ManifestRegistry } from '../core/manifests.js';
import type { TaskState, TaskStatus, TaskStore } from '../core/taskStore.js';
import type { ThreadStore } from '../core/threadStore.js';
import { resolveModel } from '../adapters/tierResolver.js';

/**
 * v2.3.1 (H1+H2): Council gates injected from the executor singleton so sync
 * forks honor the same rate-limit + auth pre-flight contract that async forks
 * already use. Provided via constructor as an optional dependency so existing
 * tests that don't pass the executor still work.
 */
export interface CouncilGates {
  applyAuthGate(adapter: string, principal: string | null, resolvedModel?: string): void;
  applyRateLimitGate(args: {
    adapter: string;
    prompt: string;
    files?: string[];
    principal: string | null;
    resolvedModel?: string;
    resolvedTier: string;
    rateLimit: NonNullable<NonNullable<import('../core/manifests.js').TierLimits>['rateLimit']>;
    /** v2.3.3 — auth-path override (skips detectAuthPath). */
    authPathOverride?: string;
    /** v2.3.3 — opt out of the gate; returns undefined without throwing. */
    bypassRateLimit?: boolean;
  }): Promise<(() => void) | undefined>;
}

export interface AdapterLookup {
  get(id: string): Adapter | undefined;
  list(): Adapter[];
}

export interface ForkRequest {
  id: string;
  adapter: string;
  prompt: string;
  files?: string[];
  intelligence?: IntelligenceTier;
  model?: string;
  /** Skill id; ignored at council level (resolved by tool layer in Phase 4). */
  skill?: string;
  /** Set automatically by tool handler. */
  parentThreadId: string;
  /** Thought number that spawned this fork. */
  thoughtNumber: number;
  /** v2.3 — additive MCP-server allowlist (F3-D.2). */
  mcpServers?: string[];
  /**
   * v2.3 — auth pre-flight opt-in (R-DIAG-D.4). v2.3.1 (H2) wires this
   * through the sync council path via the optional Council gates.
   */
  preflight?: 'auth' | 'none';
  /** v2.3.3 — auth-path override for the rate-limit gate. */
  authPath?: string;
  /** v2.3.3 — opt-out of the rate-limit refuse on this fork. */
  bypassRateLimit?: boolean;
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
  /** v2.3 — typed kind from AdapterError when fork failed (R-DIAG-D.1). */
  errorKind?: string;
  /** v2.3 — actionable next step from AdapterError when fork failed. */
  errorActionable?: string;
}

export class Council {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly adapters: AdapterLookup,
    private readonly threadStore: ThreadStore,
    private readonly taskStore: TaskStore,
    private readonly executor: Executor,
    private readonly auditLog?: AuditLog,
    /**
     * v2.3.1 (H1+H2): optional pre-flight gates. When wired (via app.ts),
     * sync forks honor `preflight: 'auth'` and the R6a-D.5 rate-limit refuse.
     * Tests that build Council directly without gates keep working.
     */
    private readonly gates?: CouncilGates,
    private readonly manifests?: ManifestRegistry
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
      // v2.3.1 (H1+H2): apply the pre-flight gates if the executor was wired
      // through. Auth gate runs when req.preflight==='auth'. Rate-limit gate
      // runs unconditionally for rate-limited tier cells; throws AdapterError
      // when over budget so the catch below classifies it as a typed failure.
      let rateLimitSlotPush: (() => void) | undefined;
      if (this.gates) {
        if (req.preflight === 'auth') {
          this.gates.applyAuthGate(req.adapter, null /* v2.2 single-tenant */, req.model);
        }
        const manifest = this.manifests ? await this.manifests.get(req.adapter) : undefined;
        if (manifest) {
          const resolved = resolveModel(
            { prompt: req.prompt, intelligence: req.intelligence, model: req.model, files: req.files },
            manifest.tiers,
            manifest.defaultTier,
            { adapterId: req.adapter, tierLimits: manifest.tierLimits }
          );
          if (resolved.limits?.rateLimit) {
            rateLimitSlotPush = await this.gates.applyRateLimitGate({
              adapter: req.adapter,
              prompt: req.prompt,
              files: req.files,
              principal: null,
              resolvedModel: resolved.model,
              resolvedTier: resolved.tier,
              rateLimit: resolved.limits.rateLimit,
              // v2.3.3 — forward caller flexibility levers.
              authPathOverride: req.authPath,
              bypassRateLimit: req.bypassRateLimit,
            });
            // v2.3.3: bypass audit event paired with the fork's taskId.
            if (req.bypassRateLimit) {
              await this.auditLog?.record({
                kind: 'task.bypass_rate_limit',
                taskId,
                adapter: req.adapter,
                authPath: req.authPath,
                reason: 'council-fork-opt-out',
              });
            }
          }
        }
      }

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
          intelligence: req.intelligence,
          model: req.model,
          // v2.3 (F3-D.2) — additive MCP-server allowlist passes through.
          mcpServers: req.mcpServers,
        },
        this.executor
      );
      // v2.3.1 (B2): consume the rate-limit slot only after invoke succeeds.
      if (rateLimitSlotPush) rateLimitSlotPush();
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
      // v2.3 (F3-D.4 / R-DIAG-D.1): treat AdapterError-throwing adapters as
      // typed failures. Persist kind + actionable into TaskState for the
      // council aggregation surface.
      const message = err instanceof Error ? err.message : String(err);
      let errorKind: string | undefined;
      let errorActionable: string | undefined;
      if (err instanceof AdapterError) {
        errorKind = err.kind;
        errorActionable = err.actionable;
      }
      await this.taskStore.update(taskId, {
        status: 'failed',
        error: message,
        errorKind,
        errorActionable,
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

  /**
   * Wait for non-detached forks in the chain, close their child threads,
   * prune their tasks. Detached forks (R-DUR-D.1) are immune: they survive
   * past chain end and are reaped by the TTL sweeper.
   */
  async endChain(parentThreadId: string, timeoutMs: number): Promise<CouncilResult[]> {
    const prefix = `${parentThreadId}::`;
    // Collect detached task ids so we exclude them from chain-end work.
    const detachedIds = new Set<string>();
    if (this.taskStore.list) {
      for (const t of await this.taskStore.list()) {
        if (t.id.startsWith(prefix) && t.detached === true) {
          detachedIds.add(t.id);
        }
      }
    }

    const promises: Promise<void>[] = [];
    for (const [tid, p] of this.inflight) {
      if (tid.startsWith(prefix) && !detachedIds.has(tid)) promises.push(p);
    }
    if (promises.length > 0) {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }

    const results: CouncilResult[] = [];
    for (const status of [
      'complete',
      'completed',
      'failed',
      'running',
      'working',
      'pending',
    ] as const) {
      for (const t of await this.taskStore.byStatus(status)) {
        if (!t.id.startsWith(prefix)) continue;
        if (detachedIds.has(t.id)) continue;
        const forkId = t.id.slice(prefix.length);
        const r = resultFromTask(t, forkId, parentThreadId);
        if (r) results.push(r);
      }
    }

    // Close child threads (non-detached only).
    for (const t of await this.threadStore.list()) {
      if (!t.threadId.startsWith(prefix)) continue;
      if (detachedIds.has(t.threadId)) continue;
      await this.threadStore.close(t.threadId);
      await this.auditLog?.record({
        kind: 'thread.close',
        threadId: t.threadId,
        adapter: t.adapter,
      });
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
    errorKind: state.errorKind,
    errorActionable: state.errorActionable,
  };
}
