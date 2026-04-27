/**
 * TaskExecutor — abstract long-running adapter invocation engine.
 *
 * Bridges the MCP Tasks protocol primitive (SEP-1686) to our adapter
 * subsystem. The executor owns the in-flight Promise/process for each task,
 * mirrors lifecycle state into the disk-backed TaskStore (debug + audit),
 * and emits progress events for clients that subscribe.
 *
 * v2.2: LocalInProcessTaskExecutor — in-process Promise + LocalSubprocessExecutor.
 * v3 swap point: RemoteCompanionTaskExecutor will dispatch via OAuth-authed
 * companion daemon. The interface stays identical; only the transport changes.
 */
import type { Adapter } from './adapter.js';
import type { IntelligenceTier } from './manifests.js';

/** Protocol-spec task statuses (matches MCP TaskSchema). */
export type ExecTaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskExecutorRequest {
  /** Adapter id to dispatch to. */
  adapter: string;
  /** Prompt body. */
  prompt: string;
  /** Optional file paths the subordinate may read. */
  files?: string[];
  /** Intelligence tier (preferred over raw model id). */
  intelligence?: IntelligenceTier;
  /** Raw model id override; wins over `intelligence` when both are supplied. */
  model?: string;
  /** Hard wall-clock cap. */
  timeoutMs?: number;
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Idempotency key (caller-supplied via `_meta["io.asyncthink/idempotency-key"]`). */
  idempotencyKey?: string;
  /** Detached forks bypass chain-end cleanup (R-DUR-D.1). */
  detached?: boolean;
  /** Owner principal; null in v2.2 (single-tenant local), populated from OAuth in v3. */
  principal?: string | null;
  /** Caller-requested TTL in ms; clamped to category limits. */
  ttlMs?: number;
  /**
   * v3 credential profile name. v2.2 stub: any non-default profile is rejected
   * with a clear error pointing to v3 support (R-CRED-D.2).
   */
  credentials?: string;
  /** Optional thread id for transcript persistence (council fork = chain::forkId). */
  threadId?: string;
  /** Optional parent chain id (council forks; non-detached forks belong to a chain). */
  parentChainId?: string;
  /** Optional skill id used to compose the prompt (audit only). */
  skill?: string;
}

export interface TaskExecutorResultEnvelope {
  /** Adapter response text. */
  text: string;
  /** Exit code (0 = success). */
  exitCode: number;
  /** Wall-clock duration. */
  durationMs: number;
  /** Continuation token for follow-up turns. */
  sessionId?: string;
  /** Any model substitution that occurred (R6b-D.2). */
  substitutedFrom?: string;
}

export interface TaskExecutorState {
  taskId: string;
  status: ExecTaskStatus;
  adapter: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  detached: boolean;
  principal: string | null;
  idempotencyKey?: string;
  parentChainId?: string;
  result?: TaskExecutorResultEnvelope;
  error?: string;
  statusMessage?: string;
}

/** A progress message from a running task. */
export interface TaskProgress {
  taskId: string;
  message: string;
  ts: string;
}

export type ProgressListener = (msg: TaskProgress) => void;

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task "${taskId}" not found.`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskOwnerMismatchError extends Error {
  constructor(taskId: string, owner: string | null, requester: string | null) {
    super(
      `Task "${taskId}" is owned by "${owner ?? '<null>'}" but the requester is "${requester ?? '<null>'}".`
    );
    this.name = 'TaskOwnerMismatchError';
  }
}

export class CredentialsNotSupportedError extends Error {
  constructor(profile: string) {
    super(
      `Credential profile "${profile}" is not supported in v2.2. Per-delegate credentials are reserved for v3 ` +
        `(see R-CRED-D.2). Drop the credentials argument or pass "default".`
    );
    this.name = 'CredentialsNotSupportedError';
  }
}

export class ContextLimitExceededError extends Error {
  constructor(
    public readonly approxTokens: number,
    public readonly maxTokens: number,
    public readonly tier: IntelligenceTier,
    public readonly adapter: string
  ) {
    super(
      `Estimated context (${approxTokens} tokens) exceeds adapter "${adapter}" tier "${tier}" max ` +
        `(${maxTokens} tokens). Switch to a higher tier or shorten the prompt.`
    );
    this.name = 'ContextLimitExceededError';
  }
}

export interface AdapterLookup {
  get(id: string): Adapter | undefined;
  list(): Adapter[];
}

// Keep type-only import to ensure module dependency stays clear; Adapter
// is used via AdapterLookup.

/**
 * TaskExecutor — long-running, persistable adapter execution.
 *
 * Lifecycle: start() spawns the work and returns the executor state record
 * (status: 'working') immediately. Callers poll get(taskId), block on
 * result(taskId), or fire-and-forget. cancel(taskId) flips state to
 * 'cancelled' and signals the subprocess (best-effort SIGTERM).
 */
export interface TaskExecutor {
  /**
   * Spawn a task. Returns the initial state record (status='working') as
   * soon as the work is registered. Idempotency: if `req.idempotencyKey` is
   * supplied and a non-terminal task with the same `(idempotencyKey,
   * principal)` exists, returns that task's state instead of spawning a new
   * one (R-DUR-D.3).
   */
  start(req: TaskExecutorRequest): Promise<TaskExecutorState>;

  /** Snapshot the current state. Throws TaskNotFoundError if absent. */
  get(taskId: string, principal?: string | null): Promise<TaskExecutorState>;

  /** Block until the task reaches a terminal status, then return its state. */
  result(taskId: string, principal?: string | null): Promise<TaskExecutorState>;

  /**
   * Best-effort cancel: flips state to 'cancelled' immediately and signals
   * the subprocess (R-DUR-D.5). Idempotent — already-terminal tasks remain
   * in their terminal state.
   */
  cancel(taskId: string, principal?: string | null): Promise<TaskExecutorState>;

  /** List tasks (filtered to caller's principal in v3; full list in v2.2 since principal=null). */
  list(opts?: { cursor?: string; principal?: string | null; limit?: number }): Promise<{
    tasks: TaskExecutorState[];
    nextCursor?: string;
  }>;

  /** Subscribe to progress events for a task. Returns unsubscribe fn. */
  onProgress(taskId: string, cb: ProgressListener): () => void;

  /** Internal — adapters can emit progress through this. */
  emitProgress(taskId: string, message: string): void;

  /** Sweep idle tasks per category TTL; returns ids reaped. */
  sweepIdle(): Promise<string[]>;
}

/** Category-wise TTL caps (R-DUR-D.4). All values in ms. */
export const CATEGORY_TTL_MS: Record<ExecTaskStatus, number> = {
  working: 60 * 60_000, // 60 minutes
  input_required: 60 * 60_000,
  completed: 60 * 60_000,
  failed: 10 * 60_000,
  cancelled: 5 * 60_000,
};

/** Caller-supplied TTL clamps (R-DUR-D.4). */
export const TTL_MIN_MS = 60_000; // 60s
export const TTL_DEFAULT_MS = CATEGORY_TTL_MS.completed;

export function clampTtl(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return TTL_DEFAULT_MS;
  return Math.max(TTL_MIN_MS, Math.min(TTL_DEFAULT_MS, requested));
}

/** Approximate token count from text length (4 chars ≈ 1 token heuristic). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
