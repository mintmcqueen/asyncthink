/**
 * LocalSubprocessExecutor — v1 implementation of the Executor interface.
 *
 * Spawns subprocesses on the local machine via child_process.spawn.
 *
 * v3 swap point: RemoteCompanionExecutor will dispatch ExecRequests to a
 * local companion daemon over an OAuth-authenticated channel. The Executor
 * interface stays identical; only the transport changes.
 *
 * Process-tree kill on timeout: subprocesses are spawned with detached=true
 * so they get their own process group; on timeout we signal the entire group
 * (negative pid) rather than just the immediate child. Avoids leaving
 * grandchildren behind when adapters launch shells that fork further.
 *
 * v2.2 — caller-initiated cancellation (R-DUR-D.5). The TaskExecutor calls
 * `bindTask(taskId, ...)` immediately before each spawn so the inflight
 * subprocess is reachable by external task id. `cancel(taskId)` signals the
 * registered process group with SIGTERM and falls back to SIGKILL after
 * 1s. Idempotent: cancelling an already-finished task is a no-op.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { Executor, ExecRequest, ExecResult } from '../core/executor.js';

const KILL_GRACE_MS = 1_000;

interface ExtendedExecRequest extends ExecRequest {
  /** Optional caller-side task id for `cancel(taskId)` registration. */
  __taskId?: string;
}

export class LocalSubprocessExecutor implements Executor {
  private readonly inflight = new Map<string, ChildProcess>();
  /**
   * Set of taskIds the caller has cancelled. We hold cancellation requests
   * until the next spawn for that task arrives — close the race where
   * cancel() is called before the subprocess has spawned.
   */
  private readonly cancelled = new Set<string>();
  /**
   * v2.3.1: per-taskId queued onExit callbacks for pre-spawn cancellations.
   * When cancel(taskId, onExit) fires before any spawn, we record the callback
   * here. The spawn path consumes it and arms the listener on the
   * subprocess's `close` event so the audit log gets real signal/exitCode
   * (instead of the bogus `null, null` that the v2.3.0 implementation fired
   * immediately).
   */
  private readonly pendingOnExit = new Map<string, (code: number | null, signal: NodeJS.Signals | null) => void>();

  async run(req: ExecRequest): Promise<ExecResult> {
    const start = Date.now();
    const taskId = (req as ExtendedExecRequest).__taskId;

    return new Promise<ExecResult>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(req.bin, req.argv, {
          cwd: req.cwd,
          env: req.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (err) {
        reject(err);
        return;
      }

      if (taskId) {
        this.inflight.set(taskId, proc);
        // If a cancel arrived before this spawn, honor it now AND arm the
        // queued onExit (if any) on the actual close event so the audit log
        // gets real signal/exitCode (v2.3.1 lower-priority fix).
        if (this.cancelled.has(taskId)) {
          this.cancelled.delete(taskId);
          const queuedOnExit = this.pendingOnExit.get(taskId);
          if (queuedOnExit) {
            this.pendingOnExit.delete(taskId);
            proc.once('close', (code, signal) => {
              try {
                queuedOnExit(code, signal);
              } catch {
                /* never throw to caller */
              }
            });
          }
          killGroup(proc.pid, 'SIGTERM');
          setTimeout(() => killGroup(proc.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
        }
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      proc.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
      proc.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(proc.pid, 'SIGTERM');
        setTimeout(() => {
          if (!settled) killGroup(proc.pid, 'SIGKILL');
        }, KILL_GRACE_MS).unref();
      }, req.timeoutMs);

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (taskId) this.inflight.delete(taskId);
        reject(err);
      });

      proc.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (taskId) this.inflight.delete(taskId);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const exitCode =
          code !== null ? code : signal === 'SIGTERM' || signal === 'SIGKILL' ? 124 : 1;
        resolve({
          stdout,
          stderr: timedOut && !stderr ? `[timeout after ${req.timeoutMs}ms]` : stderr,
          exitCode,
          durationMs: Date.now() - start,
        });
      });

      if (req.stdin !== undefined) {
        proc.stdin?.end(req.stdin);
      } else {
        proc.stdin?.end();
      }
    });
  }

  /** Bind a taskId to the next spawn. Used by the TaskExecutor. */
  bindNextSpawn(taskId: string): (req: ExecRequest) => Promise<ExecResult> {
    return (req: ExecRequest) => {
      (req as ExtendedExecRequest).__taskId = taskId;
      return this.run(req);
    };
  }

  /**
   * Cancel a running task by id (R-DUR-D.5). Best-effort: if the subprocess
   * has not yet spawned, the cancellation is recorded and applied as soon
   * as the spawn happens. If already terminated, the optional `onExit`
   * callback fires immediately with `null` signal + undefined exit code.
   *
   * v2.3 (R5-D.2): optional `onExit` callback fires when the subprocess
   * actually exits (or immediately if no subprocess is running). Lets the
   * TaskExecutor emit `task.terminated` audit events with confirmed exit
   * signal + code.
   */
  cancel(
    taskId: string,
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  ): void {
    const proc = this.inflight.get(taskId);
    if (!proc) {
      // v2.3.1: queue the cancellation request AND the onExit callback. When
      // the next spawn for this taskId arrives, both are consumed: SIGTERM
      // fires immediately, and the onExit is armed on the real close event so
      // the audit log records the actual signal/exitCode instead of `null,null`.
      this.cancelled.add(taskId);
      if (onExit) {
        this.pendingOnExit.set(taskId, onExit);
        // Fallback: if no spawn arrives within 5s (runTask threw early, the
        // task was never going to spawn), fire onExit with null,null so the
        // task.terminated audit event still records something. Bounded — if a
        // real spawn DOES arrive before this fires, the close handler clears
        // pendingOnExit first and this becomes a no-op.
        setTimeout(() => {
          const stillQueued = this.pendingOnExit.get(taskId) === onExit;
          if (stillQueued) {
            this.pendingOnExit.delete(taskId);
            this.cancelled.delete(taskId);
            try {
              onExit(null, null);
            } catch {
              /* never throw to caller */
            }
          }
        }, 5_000).unref();
      }
      return;
    }
    if (onExit) {
      proc.once('close', (code, signal) => {
        try {
          onExit(code, signal);
        } catch {
          /* never throw to caller */
        }
      });
    }
    killGroup(proc.pid, 'SIGTERM');
    setTimeout(() => {
      const stillThere = this.inflight.get(taskId);
      if (stillThere && stillThere.pid === proc.pid) {
        killGroup(proc.pid, 'SIGKILL');
      }
    }, KILL_GRACE_MS).unref();
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // Negative pid signals the entire process group (Unix).
    process.kill(-pid, signal);
  } catch {
    // Group may not exist (subprocess already exited) or platform doesn't
    // support negative-pid signaling. Fall back to direct child kill.
    try {
      process.kill(pid, signal);
    } catch {
      /* nothing more to do */
    }
  }
}
