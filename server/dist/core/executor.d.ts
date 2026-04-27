/**
 * Executor — abstract subprocess execution.
 *
 * v1: LocalSubprocessExecutor (../exec/localSubprocess.ts) spawns processes
 * directly via child_process.
 *
 * v3 swap point: RemoteCompanionExecutor for hosted MCP — the cloud server
 * dispatches ExecRequests to a local companion daemon authenticated with the
 * user's OAuth token. The interface stays identical; only the transport changes.
 */
export interface ExecRequest {
    bin: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    /** If provided, written to subprocess stdin and stdin is closed. */
    stdin?: string;
    /** Hard wall-clock cap. Subprocess is tree-killed on expiry. */
    timeoutMs: number;
}
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
}
export interface Executor {
    run(req: ExecRequest): Promise<ExecResult>;
}
