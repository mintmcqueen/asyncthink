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
import { AdapterError, detectGeminiError } from '../../core/adapterError.js';
import type { Executor } from '../../core/executor.js';
import type { IntelligenceTier } from '../../core/manifests.js';
import { resolveModel } from '../tierResolver.js';

const GEMINI_TIERS: Record<IntelligenceTier, string> = {
  high: 'gemini-3.1-pro-preview',
  med: 'gemini-2.5-flash',
  low: 'gemini-2.5-flash-lite',
};

/** v2.3 (F3-D.2): default MCP-server allowlist when manifest doesn't specify. */
const DEFAULT_MCP_ALLOWLIST = ['sequentialthinking', 'context7'];

/** v2.3 (F3-D.1): exact-match regex for the gemini-cli operational-noise prefix. */
const NOISE_RESPONSE_RE = /^\s*MCP issues detected\.\s*Run \/mcp list for status\.\s*$/i;

export class GeminiAdapter implements Adapter {
  readonly id = 'gemini' as const;
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
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 180_000;
    this.tiers = opts.tiers ?? GEMINI_TIERS;
    this.defaultTier = opts.defaultTier ?? 'med';
  }

  async invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult> {
    const resolved = resolveModel(inv, this.tiers, this.defaultTier, { adapterId: this.id });
    const mcpAllowlist = resolveMcpAllowlist(inv.mcpServers);
    const argv: string[] = [
      '-p',
      inv.prompt,
      '--output-format',
      'json',
      '--approval-mode',
      'plan',
      // Modern gemini-cli refuses approval-mode overrides outside "trusted"
      // folders. We invoke programmatically from arbitrary cwds; --skip-trust
      // is the documented way to bypass the prompt for headless use. The
      // sandbox is still --approval-mode plan (read-only).
      '--skip-trust',
      '-m',
      resolved.model,
      // v2.3 (F3-D.2): curated MCP-server allowlist. Passing an empty value
      // would disable all servers; we always pass at least the default set so
      // skill authors and callers can extend additively.
      '--allowed-mcp-server-names',
      mcpAllowlist.join(','),
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
    const rawError = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };

    // v2.3 (F3-D.3): silent-failure throw when parser yields empty AND stdout
    // matches the known noise signature exactly. This is the v2.2 playtest's
    // failure mode — gemini-cli emitted only operational feedback with no
    // model response.
    if (
      text === '' &&
      result.exitCode === 0 &&
      NOISE_RESPONSE_RE.test(result.stdout.trim())
    ) {
      throw new AdapterError({
        kind: 'silent-failure',
        adapter: this.id,
        model: resolved.model,
        summary: 'gemini-cli emitted no parseable response (operational noise only)',
        actionable:
          'Check ~/.gemini/settings.json for unhealthy MCP servers, or pin a different intelligence tier. ' +
          'See dev/research/v2-3-R1-gemini-diagnosis.md.',
        raw: rawError,
      });
    }

    // v2.3 (R-DIAG-D.2): on non-zero exit, run the gemini detector. Throw on
    // a known failure shape; otherwise fall through and let the caller see
    // the exit code via AdapterResult.
    if (result.exitCode !== 0) {
      const err = detectGeminiError(rawError, resolved.model);
      if (err) throw err;
    }

    return {
      text,
      sessionId: inv.sessionId ?? randomUUID(),
      raw: { stdout: result.stdout, stderr: result.stderr },
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }
}

/**
 * Merge caller's `mcpServers` (per-invocation override / skill extension) with
 * the gemini default allowlist. Additive only — caller cannot remove a default.
 * (F3-D.2)
 */
function resolveMcpAllowlist(callerServers: string[] | undefined): string[] {
  const set = new Set<string>(DEFAULT_MCP_ALLOWLIST);
  if (callerServers) for (const s of callerServers) if (s.trim()) set.add(s.trim());
  return [...set];
}

function uniqueDirs(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) set.add(dirname(f));
  return [...set].sort();
}

/**
 * Parse gemini-cli's --output-format=json output.
 *
 * Modern gemini-cli prepends operational noise to stdout in some
 * configurations — most commonly "MCP issues detected. Run /mcp list for
 * status." when the user has gemini's own MCP servers configured but
 * misbehaving. This noise can sit BEFORE the actual JSON object.
 *
 * Strategy: locate the first top-level JSON object in the output and parse
 * just that. If that succeeds and yields a `response` field, use it. If the
 * payload yields an `error.message`, surface a structured error string.
 * If we can't find any JSON, return an empty string (NOT the raw stdout —
 * returning the noise as the answer is the bug F2 fixes).
 *
 * The raw stdout/stderr are still returned in AdapterResult.raw so callers
 * who need to debug can see what actually came out.
 */
function parseGeminiJson(stdout: string): string {
  if (!stdout.trim()) return '';
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) return '';
  // Scan for the matching closing brace. Gemini's JSON output is a single
  // top-level object; we need to handle string escapes correctly.
  const braceEnd = findMatchingBrace(stdout, jsonStart);
  if (braceEnd < 0) return '';
  const candidate = stdout.slice(jsonStart, braceEnd + 1);
  try {
    const obj = JSON.parse(candidate) as {
      response?: unknown;
      error?: { message?: unknown };
    };
    if (typeof obj.response === 'string' && obj.response.length > 0) {
      // v2.3 (F3-D.1): if the response literally equals the known operational-noise
      // prefix, drop it. This guards against the v2.2 playtest's silent-failure mode
      // where gemini-cli's UserFeedback subscriber polluted the response stream.
      if (NOISE_RESPONSE_RE.test(obj.response.trim())) {
        console.error(
          '[Adapter:gemini] Discarding response that matched the known operational-noise signature; ' +
            'gemini-cli likely emitted UserFeedback into the response stream. Returning empty.'
        );
        return '';
      }
      return obj.response;
    }
    if (obj.error && typeof obj.error.message === 'string') {
      return `[gemini error] ${obj.error.message}`;
    }
    // JSON parsed but had neither field — surface empty rather than the
    // surrounding noise.
    return '';
  } catch {
    return '';
  }
}

function findMatchingBrace(s: string, openAt: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = openAt; i < s.length; i++) {
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
      if (depth === 0) return i;
    }
  }
  return -1;
}
