/**
 * Adapter — uniform contract for invoking a subordinate model CLI.
 *
 * v1: each adapter is implemented as a TS module under ../adapters/impl/<id>.ts
 * (claude, gemini, codex). New adapter = new TS file + manifest in
 * ../adapters/manifests/<id>.json.
 *
 * Invariants:
 *  - readOnly: true. v1 forbids any subordinate from writing/editing.
 *  - All execution flows through Executor (swap point for v3 cloud companion).
 */

import type { Executor } from './executor.js';

export interface AdapterInvocation {
  /** Prompt to send to the subordinate. Adapter encodes file context per its convention. */
  prompt: string;
  /** Absolute paths of files the subordinate may read. */
  files?: string[];
  /** Adapter-specific model id; falls back to manifest default. */
  model?: string;
  /** Opaque continuation token from a prior invocation; enables threaded conversation. */
  sessionId?: string;
  /** Hard wall-clock cap on the subprocess. */
  timeoutMs?: number;
  /** Working directory for the subprocess. Defaults to the MCP server's cwd. */
  cwd?: string;
  /** Extra environment variables to set on the subprocess. */
  env?: Record<string, string>;
}

export interface AdapterResult {
  /** Plain-text response from the subordinate. */
  text: string;
  /** Continuation token for follow-up invocations on the same thread. */
  sessionId: string;
  /** Adapter-specific raw output (parsed JSON or stdout) for debugging/audit. */
  raw: unknown;
  /** Subprocess exit code. */
  exitCode: number;
  /** Wall-clock duration from spawn to result. */
  durationMs: number;
}

export interface Adapter {
  /** Stable id used in skill manifests, tool args, and audit logs. */
  readonly id: string;
  /** v1 invariant — type-level guarantee that this adapter never writes. */
  readonly readOnly: true;
  /**
   * Invoke the subordinate. The adapter is responsible for:
   *  - Building the argv per its CLI's read-only conventions
   *  - Encoding file context per its CLI's convention (--include-dirs, inlined, etc.)
   *  - Translating sessionId into the right resume flag
   *  - Parsing output and surfacing a stable sessionId for the next turn
   */
  invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult>;
}
