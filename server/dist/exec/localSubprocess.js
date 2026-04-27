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
const KILL_GRACE_MS = 1_000;
export class LocalSubprocessExecutor {
    inflight = new Map();
    /**
     * Set of taskIds the caller has cancelled. We hold cancellation requests
     * until the next spawn for that task arrives — close the race where
     * cancel() is called before the subprocess has spawned.
     */
    cancelled = new Set();
    async run(req) {
        const start = Date.now();
        const taskId = req.__taskId;
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = spawn(req.bin, req.argv, {
                    cwd: req.cwd,
                    env: req.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: true,
                });
            }
            catch (err) {
                reject(err);
                return;
            }
            if (taskId) {
                this.inflight.set(taskId, proc);
                // If a cancel arrived before this spawn, honor it now.
                if (this.cancelled.has(taskId)) {
                    this.cancelled.delete(taskId);
                    killGroup(proc.pid, 'SIGTERM');
                    setTimeout(() => killGroup(proc.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
                }
            }
            const stdoutChunks = [];
            const stderrChunks = [];
            let timedOut = false;
            let settled = false;
            proc.stdout?.on('data', (c) => stdoutChunks.push(c));
            proc.stderr?.on('data', (c) => stderrChunks.push(c));
            const timer = setTimeout(() => {
                timedOut = true;
                killGroup(proc.pid, 'SIGTERM');
                setTimeout(() => {
                    if (!settled)
                        killGroup(proc.pid, 'SIGKILL');
                }, KILL_GRACE_MS).unref();
            }, req.timeoutMs);
            proc.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (taskId)
                    this.inflight.delete(taskId);
                reject(err);
            });
            proc.on('close', (code, signal) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (taskId)
                    this.inflight.delete(taskId);
                const stdout = Buffer.concat(stdoutChunks).toString('utf8');
                const stderr = Buffer.concat(stderrChunks).toString('utf8');
                const exitCode = code !== null ? code : signal === 'SIGTERM' || signal === 'SIGKILL' ? 124 : 1;
                resolve({
                    stdout,
                    stderr: timedOut && !stderr ? `[timeout after ${req.timeoutMs}ms]` : stderr,
                    exitCode,
                    durationMs: Date.now() - start,
                });
            });
            if (req.stdin !== undefined) {
                proc.stdin?.end(req.stdin);
            }
            else {
                proc.stdin?.end();
            }
        });
    }
    /** Bind a taskId to the next spawn. Used by the TaskExecutor. */
    bindNextSpawn(taskId) {
        return (req) => {
            req.__taskId = taskId;
            return this.run(req);
        };
    }
    /**
     * Cancel a running task by id (R-DUR-D.5). Best-effort: if the subprocess
     * has not yet spawned, the cancellation is recorded and applied as soon
     * as the spawn happens. If already terminated, no-op.
     */
    cancel(taskId) {
        const proc = this.inflight.get(taskId);
        if (!proc) {
            this.cancelled.add(taskId);
            return;
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
function killGroup(pid, signal) {
    if (pid === undefined)
        return;
    try {
        // Negative pid signals the entire process group (Unix).
        process.kill(-pid, signal);
    }
    catch {
        // Group may not exist (subprocess already exited) or platform doesn't
        // support negative-pid signaling. Fall back to direct child kill.
        try {
            process.kill(pid, signal);
        }
        catch {
            /* nothing more to do */
        }
    }
}
