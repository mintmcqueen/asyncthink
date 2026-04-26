/**
 * Gemini CLI adapter.
 *
 * Argv shape:
 *   gemini -p <prompt> --output-format json --approval-mode plan -m <model>
 *          [--include-directories <dir1,dir2,...>]
 *
 * Read-only: --approval-mode plan puts Gemini in planning mode, which is the
 * read-only navigation/analysis profile.
 *
 * Session resume: Gemini's --resume flag accepts an index/'latest' from its
 * own session list, not an externally-controlled id. v1 uses the replay
 * strategy: orchestrator prepends prior turns to inv.prompt; this adapter
 * echoes inv.sessionId back (or mints a uuid). Native session resume can be
 * adopted later if live testing shows it's reliable across invocations.
 *
 * Files: passed via --include-directories (Gemini works at directory
 * granularity, not file). The adapter dedupes parent directories of the
 * provided file paths.
 */

import { randomUUID } from 'crypto';
import { dirname } from 'path';
import type { Adapter, AdapterInvocation, AdapterResult } from '../../core/adapter.js';
import type { Executor } from '../../core/executor.js';

export class GeminiAdapter implements Adapter {
  readonly id = 'gemini' as const;
  readonly readOnly = true as const;
  readonly resumeStrategy = 'replay' as const;
  private readonly defaultTimeoutMs: number;
  private readonly defaultModel: string;

  constructor(opts: { defaultTimeoutMs?: number; defaultModel?: string } = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.defaultModel = opts.defaultModel ?? 'gemini-2.5-flash';
  }

  async invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult> {
    const argv: string[] = [
      '-p',
      inv.prompt,
      '--output-format',
      'json',
      '--approval-mode',
      'plan',
      '-m',
      inv.model ?? this.defaultModel,
    ];
    if (inv.files?.length) {
      const dirs = uniqueDirs(inv.files);
      argv.push('--include-directories', dirs.join(','));
    }

    const result = await exec.run({
      bin: 'gemini',
      argv,
      cwd: inv.cwd ?? process.cwd(),
      env: { ...process.env, ...(inv.env ?? {}) } as Record<string, string>,
      timeoutMs: inv.timeoutMs ?? this.defaultTimeoutMs,
    });

    const text = parseGeminiJson(result.stdout);

    return {
      text,
      sessionId: inv.sessionId ?? randomUUID(),
      raw: { stdout: result.stdout, stderr: result.stderr },
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }
}

function uniqueDirs(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) set.add(dirname(f));
  return [...set].sort();
}

function parseGeminiJson(stdout: string): string {
  if (!stdout.trim()) return '';
  try {
    const obj = JSON.parse(stdout) as { response?: string; error?: { message?: string } };
    if (obj.response) return obj.response;
    if (obj.error?.message) return `[gemini error] ${obj.error.message}`;
  } catch {
    // Output wasn't a single JSON object (e.g., stream-json or text fallback).
  }
  return stdout;
}
