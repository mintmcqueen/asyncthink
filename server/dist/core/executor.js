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
export {};
