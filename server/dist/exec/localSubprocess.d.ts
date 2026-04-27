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
import type { Executor, ExecRequest, ExecResult } from '../core/executor.js';
export declare class LocalSubprocessExecutor implements Executor {
    run(req: ExecRequest): Promise<ExecResult>;
}
