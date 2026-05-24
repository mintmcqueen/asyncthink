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
import { detectClaudeError } from '../../core/adapterError.js';
import type { AuditLog } from '../../core/auditLog.js';
import type { Executor } from '../../core/executor.js';
import type { IntelligenceTier } from '../../core/manifests.js';
import type { SettingsStore } from '../../core/settings.js';
import type { Subagent, SubagentRegistry } from '../../core/subagent.js';
import { resolveModel } from '../tierResolver.js';
import { detectAuthPath } from '../authPath.js';

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
  private readonly settingsStore?: SettingsStore;
  private readonly subagentRegistry?: SubagentRegistry;
  private readonly auditLog?: AuditLog;

  constructor(
    opts: {
      defaultTimeoutMs?: number;
      tiers?: Record<IntelligenceTier, string>;
      defaultTier?: IntelligenceTier;
      /** v2.6.0 — resolves defaults.subagent for the subscription-path spawn. */
      settingsStore?: SettingsStore;
      /** v2.6.0 — supplies the Subagent definition matched by settings. */
      subagentRegistry?: SubagentRegistry;
      /** v2.6.0 — receives claude.subagent.spawn audit events. */
      auditLog?: AuditLog;
    } = {}
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 300_000;
    this.tiers = opts.tiers ?? CLAUDE_TIERS;
    this.defaultTier = opts.defaultTier ?? 'med';
    this.settingsStore = opts.settingsStore;
    this.subagentRegistry = opts.subagentRegistry;
    this.auditLog = opts.auditLog;
  }

  async invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult> {
    const resolved = resolveModel(inv, this.tiers, this.defaultTier, { adapterId: this.id });
    const prompt = renderPrompt(inv);
    const argv: string[] = ['--print', '--model', resolved.model, prompt];

    // v2.6.0 — on the subscription auth path, spawn `claude --print` with a
    // dedicated AsyncThink subagent so the delegate runs as a separate
    // persona from the user's Claude Code session (focused system prompt,
    // narrowed tool set). On non-subscription paths (api / vertex / bedrock)
    // the subagent injection is skipped — those routes already isolate via
    // their own credential boundary.
    //
    // v2.7.0 — precedence for subagent resolution:
    //   1. inv.subagent (caller-supplied; per-fork override)
    //   2. settings effective defaults.subagent (user/project layer)
    //   3. builtin "asyncthink-delegate" (BUILTIN_DEFAULTS in settings.ts)
    // Skill frontmatter `subagent:` resolves into inv.subagent at the
    // tool-handler layer (delegate.tool / asyncthink.tool), so it shows up
    // here as a caller-supplied value with the right precedence.
    const authPath = detectAuthPath('claude');
    let subagent: Subagent | undefined;
    if (authPath === 'subscription' && this.subagentRegistry) {
      let subagentId: string | undefined = inv.subagent;
      if (!subagentId && this.settingsStore) {
        try {
          const settings = await this.settingsStore.get();
          subagentId = settings.effective?.defaults?.subagent;
        } catch {
          // Settings failure → fall through to no-subagent spawn.
        }
      }
      if (subagentId) {
        try {
          subagent = await this.subagentRegistry.get(subagentId);
        } catch {
          // Registry failure → fall through to no-subagent spawn.
        }
      }
      if (subagent) {
        const agentsJson = renderAgentsJson(subagent);
        // Prepend --agents JSON + --agent <name> BEFORE positional prompt.
        argv.splice(0, 0, '--agents', agentsJson, '--agent', subagent.id);
        if (this.auditLog) {
          await this.auditLog
            .record({
              kind: 'claude.subagent.spawn',
              subagentId: subagent.id,
              subagentName: subagent.name,
              authPath,
              model: resolved.model,
            })
            .catch(() => {
              /* failure-isolated */
            });
        }
      }
    }

    const result = await exec.run({
      bin: 'claude',
      argv,
      cwd: inv.cwd ?? process.cwd(),
      env: { ...process.env, ...(inv.env ?? {}) } as Record<string, string>,
      timeoutMs: inv.timeoutMs ?? this.defaultTimeoutMs,
    });

    // v2.3 (R-DIAG-D.2): run detector for known failure shapes. v2.3.1 (H3):
    // gate on non-zero exit code (or executor-synthesized timeout marker). A
    // successful claude response can legitimately mention "rate limit reached"
    // in prose; running the permissive substring detector on success-shaped
    // output would throw away valid responses.
    const isTimeout = result.exitCode === 124 && /\[timeout after \d+ms\]/.test(result.stderr);
    if (result.exitCode !== 0 || isTimeout) {
      const err = detectClaudeError(
        {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        },
        resolved.model
      );
      if (err) throw err;
    }

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

/**
 * v2.6.0 — serialize a Subagent to the inline JSON shape consumed by
 * `claude --agents '<json>'`. Format per `claude --help`:
 *
 *   '{"<name>": {"description": "...", "prompt": "...", "tools": [...], "model": "..."}}'
 *
 * Fields are optional except prompt; tools and model are omitted when
 * unset on the subagent.
 */
function renderAgentsJson(subagent: Subagent): string {
  const def: Record<string, unknown> = {
    description: subagent.description,
    prompt: subagent.prompt,
  };
  if (subagent.tools && subagent.tools.length > 0) {
    def.tools = subagent.tools;
  }
  if (subagent.model) {
    def.model = subagent.model;
  }
  return JSON.stringify({ [subagent.id]: def });
}
