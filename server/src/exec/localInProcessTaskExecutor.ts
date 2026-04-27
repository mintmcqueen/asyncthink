/**
 * LocalInProcessTaskExecutor — v2.2 implementation of the TaskExecutor
 * interface (R3-D.1).
 *
 * Spawns adapter invocations in-process as Promises. Each task is mirrored
 * into the FsTaskStore for debug/audit visibility (R3-D.3). Cancellation
 * goes through `LocalSubprocessExecutor.cancel(taskId)` which sends SIGTERM
 * to the subprocess group (R-DUR-D.5).
 *
 * Implements:
 *   - Idempotency dedup via `(idempotencyKey, principal)` (R-DUR-D.3).
 *   - Pre-flight context-size check per `tierLimits[tier].maxContext`
 *     (R6a-D.2).
 *   - Successor-model substitution for stale pinned models (R6b-D.2).
 *   - Per-tenant principal binding (R-DUR-D.2; v2.2 single-tenant: principal=null).
 *   - Caller-supplied TTLs clamped to category limits (R-DUR-D.4).
 *   - v3-stub: any non-default `credentials` profile is rejected with the
 *     R-CRED-D.2 error.
 *
 * Lifecycle states map to MCP TaskSchema spec strings:
 *   working → completed | failed | cancelled.
 *
 * v3 swap point: RemoteCompanionTaskExecutor with the same interface but
 * dispatching via OAuth-authenticated companion daemon.
 */

import { randomUUID } from 'crypto';
import type { Adapter } from '../core/adapter.js';
import type { Executor } from '../core/executor.js';
import type { ManifestRegistry } from '../core/manifests.js';
import type { ThreadStore } from '../core/threadStore.js';
import {
  CredentialsNotSupportedError,
  TaskNotFoundError,
  TaskOwnerMismatchError,
  clampTtl,
  type AdapterLookup,
  type ExecTaskStatus,
  type ProgressListener,
  type TaskExecutor,
  type TaskExecutorRequest,
  type TaskExecutorResultEnvelope,
  type TaskExecutorState,
  type TaskProgress,
} from '../core/taskExecutor.js';
import type { AuditLog } from '../core/auditLog.js';
import { isTerminal as isTerminalTaskStatus } from '../core/taskStore.js';
import type { TaskState, TaskStore } from '../core/taskStore.js';
import { LocalSubprocessExecutor } from './localSubprocess.js';
import { checkContextLimit, resolveModel } from '../adapters/tierResolver.js';

export interface LocalInProcessTaskExecutorOptions {
  adapters: AdapterLookup;
  executor: LocalSubprocessExecutor | Executor;
  taskStore: TaskStore;
  threadStore?: ThreadStore;
  auditLog?: AuditLog;
  manifests?: ManifestRegistry;
  /** Override clock for tests. */
  now?: () => Date;
}

const TERMINAL_STATUSES: ReadonlySet<ExecTaskStatus> = new Set<ExecTaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

interface InflightHandle {
  taskId: string;
  promise: Promise<void>;
  cancelled: boolean;
}

export class LocalInProcessTaskExecutor implements TaskExecutor {
  private readonly adapters: AdapterLookup;
  private readonly subExec: LocalSubprocessExecutor | Executor;
  private readonly taskStore: TaskStore;
  private readonly threadStore?: ThreadStore;
  private readonly auditLog?: AuditLog;
  private readonly manifests?: ManifestRegistry;
  private readonly now: () => Date;
  private readonly inflight = new Map<string, InflightHandle>();
  private readonly progressListeners = new Map<string, Set<ProgressListener>>();

  constructor(opts: LocalInProcessTaskExecutorOptions) {
    this.adapters = opts.adapters;
    this.subExec = opts.executor;
    this.taskStore = opts.taskStore;
    this.threadStore = opts.threadStore;
    this.auditLog = opts.auditLog;
    this.manifests = opts.manifests;
    this.now = opts.now ?? (() => new Date());
  }

  async start(req: TaskExecutorRequest): Promise<TaskExecutorState> {
    // 1. Cred-stub gate (R-CRED-D.2): reject any non-default profile.
    if (req.credentials !== undefined && req.credentials !== '' && req.credentials !== 'default') {
      throw new CredentialsNotSupportedError(req.credentials);
    }
    // 2. Adapter lookup.
    const adapter = this.adapters.get(req.adapter);
    if (!adapter) {
      const known = this.adapters
        .list()
        .map((a) => a.id)
        .join(', ');
      throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
    }

    // 3. Idempotency dedup (R-DUR-D.3).
    const principal = req.principal ?? null;
    if (req.idempotencyKey && this.taskStore.findByIdempotencyKey) {
      const existing = await this.taskStore.findByIdempotencyKey(req.idempotencyKey, principal);
      if (existing) {
        return projectState(existing);
      }
    }

    // 4. Pre-flight context check (R6a-D.2). Resolve model first so we know the tier.
    const manifest = this.manifests ? await this.manifests.get(req.adapter) : undefined;
    if (manifest) {
      const resolved = resolveModel(
        {
          prompt: req.prompt,
          intelligence: req.intelligence,
          model: req.model,
          files: req.files,
        },
        manifest.tiers,
        manifest.defaultTier,
        {
          adapterId: req.adapter,
          tierLimits: manifest.tierLimits,
          auditLog: this.auditLog,
        }
      );
      await checkContextLimit(
        { prompt: req.prompt, files: req.files },
        resolved.tier,
        req.adapter,
        resolved.limits
      );
      // If substitution occurred, embed the resolved model on req so the
      // adapter's invoke() does not need to re-resolve. The adapter will
      // still call resolveModel() but will get the same answer; we only use
      // the substitutedFrom signal to record on the TaskState.
    }

    // 5. Allocate task id and TaskState row.
    const taskId = newTaskId();
    const ttlMs = clampTtl(req.ttlMs);
    const startedAt = this.now().toISOString();
    await this.taskStore.create(taskId, req.prompt);
    await this.taskStore.update(taskId, {
      status: 'working',
      adapter: req.adapter,
      startTime: startedAt,
      lastUpdatedAt: startedAt,
      detached: req.detached ?? false,
      principal,
      idempotencyKey: req.idempotencyKey,
      taskTtlMs: ttlMs,
      parentChainId: req.parentChainId,
      forkThought: undefined,
    });

    await this.recordAudit({
      kind: 'task.create',
      taskId,
      adapter: req.adapter,
      detached: req.detached ?? false,
      principal,
      idempotencyKey: req.idempotencyKey,
    });

    // 6. Spawn the inflight Promise.
    const handle: InflightHandle = {
      taskId,
      cancelled: false,
      promise: this.runTask(adapter, taskId, req).catch(() => {
        /* swallowed; runTask records all errors into the store */
      }),
    };
    this.inflight.set(taskId, handle);
    handle.promise.finally(() => {
      this.inflight.delete(taskId);
    });

    const state = await this.taskStore.get(taskId);
    return projectState(state!);
  }

  async get(taskId: string, principal: string | null = null): Promise<TaskExecutorState> {
    const state = await this.taskStore.get(taskId);
    if (!state) throw new TaskNotFoundError(taskId);
    this.assertPrincipal(state, principal);
    return projectState(state);
  }

  async result(taskId: string, principal: string | null = null): Promise<TaskExecutorState> {
    let state = await this.taskStore.get(taskId);
    if (!state) throw new TaskNotFoundError(taskId);
    this.assertPrincipal(state, principal);
    if (!isTerminalTaskStatus(state.status)) {
      const inflight = this.inflight.get(taskId);
      if (inflight) await inflight.promise;
      state = await this.taskStore.get(taskId);
      if (!state) throw new TaskNotFoundError(taskId);
    }
    return projectState(state);
  }

  async cancel(taskId: string, principal: string | null = null): Promise<TaskExecutorState> {
    const state = await this.taskStore.get(taskId);
    if (!state) throw new TaskNotFoundError(taskId);
    this.assertPrincipal(state, principal);
    if (isTerminalTaskStatus(state.status)) return projectState(state);

    const handle = this.inflight.get(taskId);
    if (handle) handle.cancelled = true;

    if ('cancel' in this.subExec && typeof (this.subExec as LocalSubprocessExecutor).cancel === 'function') {
      (this.subExec as LocalSubprocessExecutor).cancel(taskId);
    }

    const completeTime = this.now().toISOString();
    await this.taskStore.update(taskId, {
      status: 'cancelled',
      error: state.error ?? 'cancelled by caller',
      completeTime,
      lastUpdatedAt: completeTime,
    });
    await this.recordAudit({
      kind: 'task.cancel',
      taskId,
      adapter: state.adapter ?? 'unknown',
      reason: 'caller',
    });
    const fresh = await this.taskStore.get(taskId);
    return projectState(fresh!);
  }

  async list(opts?: {
    cursor?: string;
    principal?: string | null;
    limit?: number;
  }): Promise<{ tasks: TaskExecutorState[]; nextCursor?: string }> {
    const all = this.taskStore.list ? await this.taskStore.list() : [];
    const principal = opts?.principal ?? null;
    const filtered = all.filter((t) => (t.principal ?? null) === principal);
    filtered.sort((a, b) => (a.lastUpdatedAt ?? '').localeCompare(b.lastUpdatedAt ?? ''));
    const limit = opts?.limit ?? 50;
    const startIdx = opts?.cursor ? Math.max(0, parseInt(opts.cursor, 10)) : 0;
    const slice = filtered.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + slice.length < filtered.length ? String(startIdx + slice.length) : undefined;
    return { tasks: slice.map(projectState), nextCursor };
  }

  onProgress(taskId: string, cb: ProgressListener): () => void {
    let listeners = this.progressListeners.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.progressListeners.set(taskId, listeners);
    }
    listeners.add(cb);
    return () => {
      const set = this.progressListeners.get(taskId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.progressListeners.delete(taskId);
    };
  }

  emitProgress(taskId: string, message: string): void {
    const listeners = this.progressListeners.get(taskId);
    if (!listeners) return;
    const evt: TaskProgress = { taskId, message, ts: this.now().toISOString() };
    for (const cb of listeners) {
      try {
        cb(evt);
      } catch {
        /* listener failures must not break execution */
      }
    }
  }

  async sweepIdle(): Promise<string[]> {
    const reaped = await this.taskStore.cleanupStale();
    for (const id of reaped) {
      await this.recordAudit({
        kind: 'task.expire',
        taskId: id,
        adapter: 'unknown',
        reason: 'ttl',
      });
    }
    return reaped;
  }

  private async runTask(
    adapter: Adapter,
    taskId: string,
    req: TaskExecutorRequest
  ): Promise<void> {
    const childThreadId = req.threadId ?? taskId;
    let envelope: TaskExecutorResultEnvelope | undefined;
    let failureMessage: string | undefined;
    try {
      if (this.threadStore) {
        await this.threadStore.open(childThreadId, adapter.id);
        await this.recordAudit({
          kind: 'thread.open',
          threadId: childThreadId,
          adapter: adapter.id,
        });
        await this.threadStore.append(childThreadId, {
          ts: this.now().toISOString(),
          role: 'user',
          adapter: adapter.id,
          content: req.prompt,
        });
      }

      const exec: Executor = this.boundExecutor(taskId);
      const result = await adapter.invoke(
        {
          prompt: req.prompt,
          files: req.files,
          intelligence: req.intelligence,
          model: req.model,
          timeoutMs: req.timeoutMs,
          cwd: req.cwd,
        },
        exec
      );
      envelope = {
        text: result.text,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
      };

      if (this.threadStore) {
        await this.threadStore.append(childThreadId, {
          ts: this.now().toISOString(),
          role: 'assistant',
          adapter: adapter.id,
          sessionId: result.sessionId,
          content: result.text,
          meta: { durationMs: result.durationMs, exitCode: result.exitCode },
        });
      }
    } catch (err) {
      failureMessage = err instanceof Error ? err.message : String(err);
    }

    // If cancel arrived while running, the subprocess was killed and the
    // status was already flipped to 'cancelled'. Honor that and do not
    // overwrite.
    const stateNow = await this.taskStore.get(taskId);
    if (stateNow?.status === 'cancelled') return;

    const completeTime = this.now().toISOString();
    if (envelope && envelope.exitCode === 0) {
      await this.taskStore.update(taskId, {
        status: 'completed',
        result: envelope.text,
        durationMs: envelope.durationMs,
        sessionId: envelope.sessionId,
        exitCode: envelope.exitCode,
        completeTime,
        lastUpdatedAt: completeTime,
      });
      await this.recordAudit({
        kind: 'task.complete',
        taskId,
        adapter: adapter.id,
        durationMs: envelope.durationMs,
      });
      await this.recordAudit({
        kind: 'invoke',
        adapter: adapter.id,
        durationMs: envelope.durationMs,
        threadId: childThreadId,
      });
    } else {
      const errMsg =
        failureMessage ??
        (envelope ? `exit code ${envelope.exitCode}` : 'unknown task failure');
      await this.taskStore.update(taskId, {
        status: 'failed',
        error: errMsg,
        durationMs: envelope?.durationMs,
        sessionId: envelope?.sessionId,
        exitCode: envelope?.exitCode,
        completeTime,
        lastUpdatedAt: completeTime,
      });
      await this.recordAudit({
        kind: 'task.fail',
        taskId,
        adapter: adapter.id,
        durationMs: envelope?.durationMs ?? 0,
        error: errMsg,
      });
      await this.recordAudit({
        kind: 'invoke',
        adapter: adapter.id,
        durationMs: envelope?.durationMs ?? 0,
        threadId: childThreadId,
        error: errMsg,
      });
    }
  }

  private boundExecutor(taskId: string): Executor {
    const sub = this.subExec;
    if (sub instanceof LocalSubprocessExecutor) {
      return { run: sub.bindNextSpawn(taskId) };
    }
    return sub as Executor;
  }

  private assertPrincipal(state: TaskState, principal: string | null): void {
    const owner = state.principal ?? null;
    // v2.2 single-tenant: when both sides are null, allow.
    if (owner === null && principal === null) return;
    if (owner !== principal) {
      throw new TaskOwnerMismatchError(state.id, owner, principal);
    }
  }

  private async recordAudit(
    event: Parameters<AuditLog['record']>[0]
  ): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog.record(event);
    } catch {
      /* never throw to caller */
    }
  }
}

function newTaskId(): string {
  return `tsk-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function projectState(state: TaskState): TaskExecutorState {
  return {
    taskId: state.id,
    status: toExecStatus(state.status),
    adapter: state.adapter ?? 'unknown',
    createdAt: state.startTime ?? new Date(0).toISOString(),
    lastUpdatedAt: state.lastUpdatedAt ?? state.startTime ?? new Date(0).toISOString(),
    ttlMs: state.taskTtlMs ?? 0,
    detached: state.detached ?? false,
    principal: state.principal ?? null,
    idempotencyKey: state.idempotencyKey,
    parentChainId: state.parentChainId,
    result:
      state.result !== undefined || state.exitCode !== undefined
        ? {
            text: state.result ?? '',
            exitCode: state.exitCode ?? 0,
            durationMs: state.durationMs ?? 0,
            sessionId: state.sessionId,
            substitutedFrom: state.substitutedFrom,
          }
        : undefined,
    error: state.error,
  };
}

function toExecStatus(s: TaskState['status']): ExecTaskStatus {
  switch (s) {
    case 'pending':
    case 'running':
    case 'working':
      return 'working';
    case 'input_required':
      return 'input_required';
    case 'complete':
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

// Re-export for tests / external consumers.
export { TERMINAL_STATUSES };
