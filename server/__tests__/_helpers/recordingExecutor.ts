/**
 * RecordingExecutor — test double for Executor.
 *
 * Captures every ExecRequest and returns a scripted ExecResult without ever
 * spawning a process. Used by golden-argv tests to verify each adapter
 * produces the expected argv/env/stdin without needing the real CLI installed.
 */

import type { ExecRequest, ExecResult, Executor } from '../../src/core/executor.js';

export interface RecordedCall {
  bin: string;
  argv: string[];
  cwd: string;
  envKeys: string[];
  stdin: string | undefined;
  timeoutMs: number;
}

export type ScriptedResponse = ExecResult | ((req: ExecRequest) => ExecResult);

export class RecordingExecutor implements Executor {
  readonly calls: RecordedCall[] = [];
  private readonly responses: ScriptedResponse[];

  constructor(responses: ScriptedResponse[] = [defaultOk()]) {
    this.responses = [...responses];
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    this.calls.push({
      bin: req.bin,
      argv: req.argv,
      cwd: req.cwd,
      envKeys: Object.keys(req.env).sort(),
      stdin: req.stdin,
      timeoutMs: req.timeoutMs,
    });
    const next = this.responses.shift() ?? defaultOk();
    return typeof next === 'function' ? next(req) : next;
  }
}

function defaultOk(): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
}
