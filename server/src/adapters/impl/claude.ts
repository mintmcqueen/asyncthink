/**
 * Claude Code adapter.
 *
 * Argv shape: claude --print <prompt>
 *
 * Session resume: Claude Code has no native cross-invocation session id we
 * can address from the outside. Strategy: orchestrator prepends prior-turn
 * history to inv.prompt before calling. This adapter echoes inv.sessionId
 * back unchanged (or mints a uuid if absent) so the caller has a stable
 * thread id.
 *
 * Files: prepended to the prompt as a "Files:" header listing absolute paths.
 * Claude Code resolves the paths relative to inv.cwd at read time.
 *
 * Read-only: Claude Code is invoked without any --allow-tool flags and we
 * never expose write capabilities. The subprocess inherits no edit tools by
 * default in --print mode.
 */

import { randomUUID } from 'crypto';
import type { Adapter, AdapterInvocation, AdapterResult } from '../../core/adapter.js';
import type { Executor } from '../../core/executor.js';
import type { IntelligenceTier } from '../../core/manifests.js';
import { resolveModel } from '../tierResolver.js';

// v2.1.1 note: `high` was claude-opus-4-7 but Anthropic's org-level cap of
// 30k input tokens/minute on opus-4-7 makes it unreliable for non-trivial
// council forks. Demoted to sonnet-4-6 so `intelligence: "high"` Just
// Works. Users with higher opus rate limits can pin the raw model id via
// `model: "claude-opus-4-7"` or edit this manifest. R6a (tier-model
// rework) will revisit; until then, high and med collapse to sonnet.
const CLAUDE_TIERS: Record<IntelligenceTier, string> = {
  high: 'claude-sonnet-4-6',
  med: 'claude-sonnet-4-6',
  low: 'claude-haiku-4-5-20251001',
};

export class ClaudeAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly readOnly = true as const;
  readonly resumeStrategy = 'replay' as const;
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
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 300_000;
    this.tiers = opts.tiers ?? CLAUDE_TIERS;
    this.defaultTier = opts.defaultTier ?? 'med';
  }

  async invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult> {
    const resolved = resolveModel(inv, this.tiers, this.defaultTier, { adapterId: this.id });
    const prompt = renderPrompt(inv);
    const argv: string[] = ['--print', '--model', resolved.model, prompt];

    const result = await exec.run({
      bin: 'claude',
      argv,
      cwd: inv.cwd ?? process.cwd(),
      env: { ...process.env, ...(inv.env ?? {}) } as Record<string, string>,
      timeoutMs: inv.timeoutMs ?? this.defaultTimeoutMs,
    });

    return {
      text: result.stdout,
      sessionId: inv.sessionId ?? randomUUID(),
      raw: result,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }
}

function renderPrompt(inv: AdapterInvocation): string {
  if (!inv.files?.length) return inv.prompt;
  const fileList = inv.files.map((p) => `- ${p}`).join('\n');
  return `Files available for review:\n${fileList}\n\n${inv.prompt}`;
}
