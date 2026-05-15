/**
 * AdapterError — typed failure envelope for adapter calls.
 *
 * Replaces the v2.2 status quo where adapter failures surfaced as opaque
 * `state.error: string` blobs. Per R-DIAG-D.1 / R-DIAG-D.2, every known
 * failure mode now has a `kind`, a one-sentence `actionable` next step,
 * a one-line `summary` (the .message), and the raw subprocess output
 * preserved for debugging.
 *
 * Per-adapter detector functions live alongside the class. Each adapter's
 * `invoke()` calls its own detector on the raw `ExecResult` and throws on a
 * match. The executor's `runTask` catches and persists `errorKind` +
 * `errorActionable` into `TaskState`.
 *
 * v2.2's `ContextLimitExceededError` is kept as a named subclass (R-DIAG-D.6)
 * so existing `instanceof ContextLimitExceededError` checks continue working.
 */

export type AdapterErrorKind =
  | 'auth'             // 401, "Please run /login", "API key not valid", "Not logged in"
  | 'rate-limit'       // 429, "Rate limit reached", RESOURCE_EXHAUSTED
  | 'context'          // pre-flight context overflow (unifies v2.2 ContextLimitExceededError)
  | 'network'          // ECONNRESET, DNS failure, "failed to connect" (no auth context)
  | 'binary-missing'   // ENOENT from spawn
  | 'timeout'          // exit=124 + executor's synthesized stderr
  | 'silent-failure'   // adapter exited 0 but parser yielded empty/known-noise output
  | 'unknown';         // catch-all; raw output preserved

export interface AdapterErrorRaw {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
}

export interface AdapterErrorOpts {
  kind: AdapterErrorKind;
  adapter: string;
  model?: string;
  actionable: string;
  summary: string;
  raw?: AdapterErrorRaw;
  cause?: unknown;
  /** Optional per-kind metadata (e.g. cap for rate-limit). */
  details?: Record<string, unknown>;
}

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly adapter: string;
  readonly model?: string;
  readonly actionable: string;
  readonly summary: string;
  readonly raw?: AdapterErrorRaw;
  readonly details?: Record<string, unknown>;

  constructor(opts: AdapterErrorOpts) {
    super(opts.summary);
    this.name = 'AdapterError';
    this.kind = opts.kind;
    this.adapter = opts.adapter;
    this.model = opts.model;
    this.actionable = opts.actionable;
    this.summary = opts.summary;
    this.raw = opts.raw;
    this.details = opts.details;
    if (opts.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }

  /**
   * JSON shape for transport. Strips `raw` so audit lines / council outputs
   * stay compact — callers that need raw output read it from TaskState via
   * `tasks_get`.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      adapter: this.adapter,
      ...(this.model !== undefined && { model: this.model }),
      summary: this.summary,
      actionable: this.actionable,
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

/**
 * Context-limit specialization (R-DIAG-D.6). Keeps the v2.2 class name so
 * `instanceof ContextLimitExceededError` checks in existing code keep working.
 */
export class ContextLimitExceededError extends AdapterError {
  readonly approxTokens: number;
  readonly maxTokens: number;
  readonly tier: string;

  constructor(opts: {
    approxTokens: number;
    maxTokens: number;
    tier: string;
    adapter: string;
    model?: string;
  }) {
    super({
      kind: 'context',
      adapter: opts.adapter,
      model: opts.model,
      summary:
        `Estimated context (${opts.approxTokens} tokens) exceeds adapter "${opts.adapter}" tier ` +
        `"${opts.tier}" max (${opts.maxTokens} tokens).`,
      actionable: `Reduce prompt size, switch to a higher tier, or pass fewer files.`,
      details: { approxTokens: opts.approxTokens, maxTokens: opts.maxTokens, tier: opts.tier },
    });
    this.name = 'ContextLimitExceededError';
    this.approxTokens = opts.approxTokens;
    this.maxTokens = opts.maxTokens;
    this.tier = opts.tier;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-adapter detector functions (R-DIAG-D.2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Locate the first balanced JSON object in `s` and parse it. Used by gemini
 * detector to scan stderr (gemini puts error envelopes on stderr) and re-used
 * from `gemini.ts:parseGeminiJson`'s findMatchingBrace logic.
 */
function tryExtractFirstJson(s: string): Record<string, unknown> | null {
  if (!s.trim()) return null;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function detectTimeout(
  raw: AdapterErrorRaw,
  adapter: string,
  model: string | undefined
): AdapterError | null {
  if (raw.exitCode === 124 && /\[timeout after \d+ms\]/.test(raw.stderr)) {
    return new AdapterError({
      kind: 'timeout',
      adapter,
      model,
      summary: `${adapter} timed out after ${raw.durationMs ?? '?'}ms`,
      actionable: `Reduce prompt size, raise timeoutMs, or pin a faster tier (intelligence: 'low').`,
      raw,
    });
  }
  return null;
}

export function detectClaudeError(
  raw: AdapterErrorRaw,
  model: string | undefined
): AdapterError | null {
  const t = detectTimeout(raw, 'claude', model);
  if (t) return t;
  const blob = `${raw.stdout}\n${raw.stderr}`;
  if (/Rate limit reached/i.test(blob)) {
    // Anthropic's rate-limit error includes the cap in one of two shapes:
    //   "...50,000 tokens per minute..."
    //   "...(TPM): Limit 50000..."
    // Order alternatives longest-first to prevent the bare-digit alternative
    // from greedy-matching a prefix of a comma-separated number.
    const tpmMatch =
      blob.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*tokens?\s*per\s*minute/i) ??
      blob.match(/\(TPM\)\s*:\s*Limit\s+(\d{1,3}(?:,\d{3})+|\d+)/i);
    const tpm = tpmMatch ? tpmMatch[1].replace(/,/g, '') : undefined;
    return new AdapterError({
      kind: 'rate-limit',
      adapter: 'claude',
      model,
      summary: `claude rate-limited${tpm ? ` (cap ${tpm} tokens/min)` : ''}`,
      actionable:
        'Wait ~60s and retry, or pin to a different intelligence tier. ' +
        'Check Anthropic dashboard for tier upgrade options.',
      raw,
      details: tpm ? { capTokens: Number(tpm), windowSec: 60, dim: 'input' } : undefined,
    });
  }
  if (/Invalid API key|Please run \/login|Not authenticated/i.test(blob)) {
    return new AdapterError({
      kind: 'auth',
      adapter: 'claude',
      model,
      summary: 'claude is not authenticated',
      actionable: 'Run `claude /login`, or set ANTHROPIC_API_KEY in env.',
      raw,
    });
  }
  return null;
}

export function detectGeminiError(
  raw: AdapterErrorRaw,
  model: string | undefined
): AdapterError | null {
  const t = detectTimeout(raw, 'gemini', model);
  if (t) return t;
  // Gemini's error envelope is on stderr (JSON). Fall back to stdout if stderr is empty.
  const json = tryExtractFirstJson(raw.stderr) ?? tryExtractFirstJson(raw.stdout);
  const err = json?.error as { message?: unknown; code?: unknown } | undefined;
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (msg) {
    if (/GEMINI_API_KEY\s+environment\s+variable/i.test(msg)) {
      return new AdapterError({
        kind: 'auth',
        adapter: 'gemini',
        model,
        summary: 'GEMINI_API_KEY is not set',
        actionable:
          'Set GEMINI_API_KEY or GOOGLE_API_KEY in your environment ' +
          '(AI Studio key works for the paid tier).',
        raw,
      });
    }
    if (/API_KEY_INVALID|API key not valid/i.test(msg)) {
      return new AdapterError({
        kind: 'auth',
        adapter: 'gemini',
        model,
        summary: 'GEMINI_API_KEY rejected (invalid key)',
        actionable:
          'Generate a new key at https://aistudio.google.com/apikey and update GEMINI_API_KEY.',
        raw,
      });
    }
    if (/RESOURCE_EXHAUSTED|Quota exceeded|"code"\s*:\s*429|429/i.test(msg)) {
      return new AdapterError({
        kind: 'rate-limit',
        adapter: 'gemini',
        model,
        summary: 'Gemini quota exceeded',
        actionable:
          'Wait per retryDelay, or upgrade Tier (Tier 1 paid = 300 RPM on flash).',
        raw,
      });
    }
    if (/failed to connect|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      return new AdapterError({
        kind: 'network',
        adapter: 'gemini',
        model,
        summary: 'Gemini network failure',
        actionable: 'Check your internet connection and DNS resolution.',
        raw,
      });
    }
  }
  return null;
}

export function detectCodexError(
  raw: AdapterErrorRaw,
  model: string | undefined
): AdapterError | null {
  const t = detectTimeout(raw, 'codex', model);
  if (t) return t;
  // Codex stdout is NDJSON; scan for terminal turn.failed or error events.
  for (const line of raw.stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj: { type?: string; error?: { message?: string }; message?: string };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    const msg = obj.error?.message ?? obj.message ?? '';
    if (obj.type === 'turn.failed' || obj.type === 'error') {
      if (/401 Unauthorized/i.test(msg) || /Missing bearer/i.test(msg) || /Not logged in/i.test(msg)) {
        return new AdapterError({
          kind: 'auth',
          adapter: 'codex',
          model,
          summary: 'Codex is not authenticated (401 Unauthorized)',
          actionable: 'Run `codex login`, or set a valid OPENAI_API_KEY.',
          raw,
        });
      }
      if (/429/.test(msg) || /Too Many Requests/i.test(msg) || /rate limit/i.test(msg)) {
        return new AdapterError({
          kind: 'rate-limit',
          adapter: 'codex',
          model,
          summary: 'OpenAI rate-limited',
          actionable:
            'Wait per Retry-After header, or pin a different tier (intelligence: high uses gpt-5.5 separate pool).',
          raw,
        });
      }
      if (/failed to connect|ECONNRESET|ENOTFOUND/i.test(msg)) {
        return new AdapterError({
          kind: 'network',
          adapter: 'codex',
          model,
          summary: 'Codex network failure',
          actionable: 'Check internet connection and OpenAI API status.',
          raw,
        });
      }
    }
  }
  return null;
}

/** Detect ENOENT-class errors from a thrown Error (binary not on PATH). */
export function detectBinaryMissing(
  err: unknown,
  adapter: string,
  binary: string
): AdapterError | null {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || /ENOENT/.test(message) || /^spawn \S+ ENOENT/.test(message)) {
    return new AdapterError({
      kind: 'binary-missing',
      adapter,
      summary: `${binary} not found on PATH`,
      actionable: `Install ${binary} (see README for install instructions) and ensure it's on PATH.`,
    });
  }
  return null;
}

// Re-export for the parser to reuse.
export { tryExtractFirstJson };
