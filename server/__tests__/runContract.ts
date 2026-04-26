/**
 * runContract — replay JSON acceptance specs against an MCP server instance.
 *
 * Phase 0: skeleton only. Phase 1+ fills in:
 *   - Boot an in-process MCP server with a fake Executor injected
 *   - Walk the spec's `steps` array, sending each tool call
 *   - Resolve `@from:steps[N].field` refs against earlier responses
 *   - Match values against `@string`, `@nonempty`, `@contains:<sub>` predicates
 *   - Emit a vitest `it()` per step with descriptive names
 *
 * The same runner is reused by `*.live.test.ts` against real CLIs
 * (RUN_LIVE=1) — same spec, two execution backends.
 */

export interface ContractSpec {
  name: string;
  tool: string;
  steps: ContractStep[];
}

export interface ContractStep {
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
}

export interface ContractRunOptions {
  /** Use real CLI binaries instead of the fake Executor. */
  live?: boolean;
}

export async function runContract(
  _spec: ContractSpec,
  _opts: ContractRunOptions = {}
): Promise<void> {
  throw new Error('runContract: not implemented (Phase 1+)');
}
