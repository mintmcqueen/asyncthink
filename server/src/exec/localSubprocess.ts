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
 */

import { spawn } from 'child_process';
import type { Executor, ExecRequest, ExecResult } from '../core/executor.js';

const KILL_GRACE_MS = 1_000;

export class LocalSubprocessExecutor implements Executor {
  async run(req: ExecRequest): Promise<ExecResult> {
    const start = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      let proc: ReturnType<typeof spawn>;
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
        }, KILL_GRACE_MS);
      }, req.timeoutMs);

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      proc.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
