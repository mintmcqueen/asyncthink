/**
 * OpenAI Codex CLI adapter.
 *
 * Targets codex v0.47.x (current at time of writing).
 *
 * Argv shape (first turn):
 *   codex exec --sandbox read-only --json --skip-git-repo-check --color never
 *              --output-last-message <tmp> --model <model> --cd <cwd>
 *              <prompt>
 *
 * Argv shape (resume):
 *   codex exec resume <threadId> --sandbox read-only --json --skip-git-repo-check
 *              --color never --output-last-message <tmp> --model <model>
 *              --cd <cwd> <prompt>
 *
 * Read-only: --sandbox read-only is the enforcement primitive. Earlier docs
 * referenced --ask-for-approval; that flag was removed in v0.47 — sandbox
 * mode now governs both access and approval flow. Read-only sandboxing means
 * the subordinate can analyze the codebase but cannot edit, exec, or hit the
 * network outside its model API connection.
 *
 * Session resume: native, via the 'resume' subcommand. The first turn reads
 * the thread id out of the {"type":"thread.started"} event in --json stdout
 * and echoes it back via AdapterResult.sessionId; the orchestrator passes
 * that id on the next call.
 *
 * Files: Codex has no --include-dirs equivalent. Files are inlined into the
 * prompt as XML-fenced sections at the top so the subordinate sees them as
 * context. --cd points Codex at the project root for any additional reads.
 *
 * Auth: requires `codex login` or OPENAI_API_KEY in env; failures surface as
 * "Failed to refresh token: 401 Unauthorized" in stderr/stdout.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Adapter, AdapterInvocation, AdapterResult } from '../../core/adapter.js';
import type { Executor } from '../../core/executor.js';
import type { IntelligenceTier } from '../../core/manifests.js';
import { resolveModel } from '../tierResolver.js';

const CODEX_TIERS: Record<IntelligenceTier, string> = {
  high: 'gpt-5.5',
  med: 'gpt-5-codex',
  low: 'gpt-5-mini',
};

export class CodexAdapter implements Adapter {
  readonly id = 'codex' as const;
  readonly readOnly = true as const;
  readonly resumeStrategy = 'native' as const;
  private readonly defaultTimeoutMs: number;
  private readonly tiers: Record<IntelligenceTier, string>;
  private readonly defaultTier: IntelligenceTier;

  constructor(
    opts: {
      defaultTimeoutMs?: number;
      tiers?: Record<IntelligenceTier, string>;
      defaultTier?: IntelligenceTier;
    } = {}
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 180_000;
    this.tiers = opts.tiers ?? CODEX_TIERS;
    this.defaultTier = opts.defaultTier ?? 'med';
  }

  async invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult> {
    const tmp = join(
      tmpdir(),
      `asyncthink-codex-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.txt`
    );
    const prompt = renderPrompt(inv);

    const argv: string[] = ['exec'];
    if (inv.sessionId) {
      argv.push('resume', inv.sessionId);
    }
    const resolved = resolveModel(inv, this.tiers, this.defaultTier, { adapterId: this.id });
    argv.push(
      '--sandbox',
      'read-only',
      '--json',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--output-last-message',
      tmp,
      '--model',
      resolved.model,
      '--cd',
      inv.cwd ?? process.cwd(),
      prompt
    );

    const result = await exec.run({
      bin: 'codex',
      argv,
      cwd: inv.cwd ?? process.cwd(),
      env: { ...process.env, ...(inv.env ?? {}) } as Record<string, string>,
      timeoutMs: inv.timeoutMs ?? this.defaultTimeoutMs,
    });

    let text = '';
    try {
      text = await fs.readFile(tmp, 'utf8');
      await fs.unlink(tmp).catch(() => {});
    } catch {
      // Fallback: scrape last assistant message from JSON event stream.
      text = scrapeLastAssistant(result.stdout);
    }

    const newSessionId = extractSessionId(result.stdout) ?? inv.sessionId ?? randomUUID();

    return {
      text,
      sessionId: newSessionId,
      raw: { stdout: result.stdout, stderr: result.stderr },
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }
}

function renderPrompt(inv: AdapterInvocation): string {
  if (!inv.files?.length) return inv.prompt;
  const blocks = inv.files
    .map((p) => `<file path="${p}">\n${p}\n</file>`)
    .join('\n');
  return `<context>\n${blocks}\n</context>\n\n${inv.prompt}`;
}

function extractSessionId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as {
        type?: string;
        thread_id?: string;
        session_id?: string;
        id?: string;
      };
      // v0.47+: {"type":"thread.started","thread_id":"..."}
      if (obj.type === 'thread.started' && typeof obj.thread_id === 'string' && obj.thread_id) {
        return obj.thread_id;
      }
      // Legacy and miscellaneous fallbacks.
      if (typeof obj.thread_id === 'string' && obj.thread_id.length > 0) return obj.thread_id;
      if (typeof obj.session_id === 'string' && obj.session_id.length > 0) return obj.session_id;
      if (obj.type === 'session.created' && typeof obj.id === 'string' && obj.id.length > 0) {
        return obj.id;
      }
    } catch {
      // Not a JSON line; skip.
    }
  }
  return undefined;
}

function scrapeLastAssistant(stdout: string): string {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; role?: string; content?: string; text?: string };
      if (obj.role === 'assistant' && (obj.content || obj.text)) {
        return obj.content ?? obj.text ?? '';
      }
    } catch {
      /* not JSON */
    }
  }
  return stdout;
}
