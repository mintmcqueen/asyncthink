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
 *
 * v2.2: optional `async: true` mode (R4-D). When set, the Delegate routes
 * the call through the injected TaskExecutor and returns an AsyncDelegate
 * envelope ({taskId, status: 'working'}) instead of the synchronous
 * DelegateResponse. Callers poll via `tasks/get`, block via `tasks/result`,
 * or cancel via `tasks/cancel`. The synchronous path is unchanged.
 */

import { randomUUID } from 'crypto';
import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { Executor } from '../core/executor.js';
import type { IntelligenceTier, ManifestRegistry } from '../core/manifests.js';
import type {
  TaskExecutor,
  TaskExecutorState,
} from '../core/taskExecutor.js';
import {
  CredentialsNotSupportedError,
} from '../core/taskExecutor.js';
import type { ThreadStore, ThreadTurn } from '../core/threadStore.js';
import { cleanupCodexOverlay } from '../adapters/codexOverlay.js';
import { resolveModel } from '../adapters/tierResolver.js';
import type { LocalInProcessTaskExecutor } from '../exec/localInProcessTaskExecutor.js';

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
  /**
   * v2.2 — when true, route through the TaskExecutor and return an
   * AsyncDelegateResponse with `taskId`. Default false (sync path
   * unchanged).
   */
  async?: boolean;
  /**
   * v2.2 — caller-supplied idempotency key; only meaningful when
   * `async: true` (R-DUR-D.3).
   */
  idempotencyKey?: string;
  /**
   * v2.2 — caller-requested TTL in ms (clamped to category cap). Only
   * meaningful when `async: true`.
   */
  ttlMs?: number;
  /**
   * v2.2 — cred profile name. Wire-only stub in v2.2 (R-CRED-D.1); any
   * non-default value is rejected with R-CRED-D.2 error.
   */
  credentials?: string;
  /** Owner principal; null in v2.2 single-tenant local. */
  principal?: string | null;
  /**
   * v2.3 — additive MCP-server allowlist for the adapter spawn (F3-D.2). Merged
   * with the adapter's manifest default. Skills CANNOT remove servers.
   */
  mcpServers?: string[];
  /**
   * v2.3 — auth pre-flight opt-in (R-DIAG-D.4). When 'auth', runs a local
   * probe BEFORE allocating a task row. Only applies in async mode.
   */
  preflight?: 'auth' | 'none';
  /**
   * v2.3.3 — auth-path override for the rate-limit gate. Use when the
   * env-derived authPath misclassifies the call (e.g., subscription auth
   * with ANTHROPIC_API_KEY set).
   */
  authPath?: string;
  /**
   * v2.3.3 — opt-out of the rate-limit refuse. Caller assumes 429 risk.
   * Emits a `task.bypass_rate_limit` audit event for observability.
   */
  bypassRateLimit?: boolean;
  /**
   * v2.7.0 — per-call subagent override for claude adapter subscription
   * auth. Pins which Subagent persona spawns this delegate. Resolution
   * precedence: this > skill `subagent:` > settings `defaults.subagent`
   * > built-in `asyncthink-delegate`. Non-claude adapters ignore.
   */
  subagent?: string;
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

export interface AsyncDelegateResponse {
  /** Task id; pass to `tasks/get`, `tasks/result`, `tasks/cancel`. */
  taskId: string;
  /** Adapter the task was dispatched to. */
  adapter: string;
  /** Initial status — always 'working' immediately after start. */
  status: TaskExecutorState['status'];
  /** Reminder for the orchestrator. */
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
const REMINDER_ASYNC =
  'Async task created. Poll status via tasks/get({taskId}); fetch result via ' +
  'tasks/result({taskId}); cancel via tasks/cancel({taskId}). Idle tasks expire per ' +
  'category TTL (working/completed 60m, failed 10m, cancelled 5m).';

export class Delegate {
  constructor(
    private readonly adapters: AdapterLookup,
    private readonly threadStore: ThreadStore,
    private readonly executor: Executor,
    private readonly auditLog?: AuditLog,
    private readonly taskExecutor?: TaskExecutor,
    /**
     * v2.3.1 (H1+H2): optional manifest registry. When provided alongside a
     * gate-bearing taskExecutor (LocalInProcessTaskExecutor), sync delegate
     * applies the same rate-limit + auth pre-flight gates that the async path
     * runs in executor.start().
     */
    private readonly manifests?: ManifestRegistry
  ) {}

  /** Synchronous turn — returns the assistant response inline. */
  async run(req: DelegateRequest): Promise<DelegateResponse> {
    if (
      req.credentials !== undefined &&
      req.credentials !== '' &&
      req.credentials !== 'default'
    ) {
      throw new CredentialsNotSupportedError(req.credentials);
    }
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

    // v2.3.1 (H1+H2): apply pre-flight gates on the sync path too. Reuses the
    // executor's shared state (recentSpawns / authProbeCache) so async and
    // sync forks share the same window+token budget. Gracefully no-ops when
    // the manifest registry or task executor isn't wired (e.g. unit tests).
    let rateLimitSlotPush: (() => void) | undefined;
    const gateBearing = this.taskExecutor as LocalInProcessTaskExecutor | undefined;
    if (gateBearing && typeof gateBearing.applyAuthGate === 'function') {
      if (req.preflight === 'auth') {
        gateBearing.applyAuthGate(req.adapter, req.principal ?? null, req.model);
      }
      if (this.manifests) {
        const manifest = await this.manifests.get(req.adapter);
        if (manifest) {
          const resolved = resolveModel(
            { prompt: req.prompt, intelligence: req.intelligence, model: req.model, files: req.files },
            manifest.tiers,
            manifest.defaultTier,
            { adapterId: req.adapter, tierLimits: manifest.tierLimits }
          );
          if (resolved.limits?.rateLimit) {
            rateLimitSlotPush = await gateBearing.applyRateLimitGate({
              adapter: req.adapter,
              prompt: req.prompt,
              files: req.files,
              principal: req.principal ?? null,
              resolvedModel: resolved.model,
              resolvedTier: resolved.tier,
              rateLimit: resolved.limits.rateLimit,
              // v2.3.3 — caller flexibility levers.
              authPathOverride: req.authPath,
              bypassRateLimit: req.bypassRateLimit,
            });
            // v2.3.3: sync-delegate bypass audit (no taskId — record under threadId).
            if (req.bypassRateLimit) {
              await this.auditLog?.record({
                kind: 'task.bypass_rate_limit',
                taskId: threadId,
                adapter: req.adapter,
                authPath: req.authPath,
                reason: 'sync-delegate-opt-out',
              });
            }
          }
        }
      }
    }

    const result = await adapter.invoke(
      {
        prompt: effectivePrompt,
        files: req.files,
        sessionId,
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        intelligence: req.intelligence,
        model: req.model,
        // v2.3.1 (B1) — sync delegate must forward the additive allowlist too;
        // previously only Council.runFork was wired (sync forks), so async
        // delegate and sync delegate silently dropped the field.
        mcpServers: req.mcpServers,
        // v2.5.0 — threadId for codex $CODEX_HOME overlay scoping.
        threadId,
        // v2.7.0 — per-call subagent override for claude subscription auth.
        subagent: req.subagent,
      },
      this.executor
    );
    // v2.3.1 (B2): consume the rate-limit slot only after invoke succeeds.
    if (rateLimitSlotPush) rateLimitSlotPush();

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
      // v2.5.0 — reap any codex $CODEX_HOME overlay scoped to this thread.
      // Idempotent + best-effort; no-op for non-codex adapters.
      await cleanupCodexOverlay(threadId);
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

  /**
   * Async turn (v2.2). Routes through the injected TaskExecutor; returns
   * `{taskId, status}` immediately. Subsequent polling/blocking happens via
   * `tasks/get`, `tasks/result`, `tasks/cancel`.
   *
   * Idempotency: if `req.idempotencyKey` is supplied and a non-terminal
   * task with the same `(idempotencyKey, principal)` exists, the existing
   * taskId is returned (R-DUR-D.3).
   */
  async runAsync(req: DelegateRequest): Promise<AsyncDelegateResponse> {
    if (!this.taskExecutor) {
      throw new Error('Async delegate requested but no TaskExecutor was injected.');
    }
    const adapter = this.adapters.get(req.adapter);
    if (!adapter) {
      const known = this.adapters.list().map((a) => a.id).join(', ');
      throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
    }
    const state = await this.taskExecutor.start({
      adapter: req.adapter,
      prompt: req.prompt,
      files: req.files,
      intelligence: req.intelligence,
      model: req.model,
      timeoutMs: req.timeoutMs,
      cwd: req.cwd,
      idempotencyKey: req.idempotencyKey,
      detached: true, // async delegates are detached by default (independent of any chain)
      principal: req.principal ?? null,
      ttlMs: req.ttlMs,
      // v2.3.3 — caller flexibility levers.
      authPath: req.authPath,
      bypassRateLimit: req.bypassRateLimit,
      credentials: req.credentials,
      threadId: req.threadId,
      skill: req.skill,
      // v2.3 (F3-D.2, R-DIAG-D.4) — forward additive allowlist + preflight opt-in.
      // Fields are now first-class on TaskExecutorRequest (v2.3.1 B1).
      mcpServers: req.mcpServers,
      preflight: req.preflight,
      // v2.7.0 — per-call subagent override for claude subscription auth.
      subagent: req.subagent,
    });
    return {
      taskId: state.taskId,
      adapter: state.adapter,
      status: state.status,
      reminder: REMINDER_ASYNC,
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
