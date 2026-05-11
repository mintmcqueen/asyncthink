/**
 * Auth-path detection (R6a-D.4 supporting).
 *
 * Each adapter has multiple ways it can route to a model provider, with
 * materially different rate-limit / quota semantics:
 *
 *   - claude: subscription (Claude Code CLI session, default), api
 *     (ANTHROPIC_API_KEY → Anthropic Tier-1 API), vertex
 *     (CLAUDE_CODE_USE_VERTEX=1 → Vertex AI per-project quotas), bedrock
 *     (CLAUDE_CODE_USE_BEDROCK=1 → AWS service quotas).
 *
 *   - gemini: ai-studio (GEMINI_API_KEY or GOOGLE_API_KEY → AI Studio Tier-1
 *     paid, default), vertex (GOOGLE_GENAI_USE_VERTEXAI=true +
 *     GOOGLE_CLOUD_PROJECT → Vertex AI per-project quotas).
 *
 *   - codex: subscription (ChatGPT Plus/Pro via `codex login`, default), api
 *     (OPENAI_API_KEY → OpenAI Tier-1 ITPM), azure (Azure OpenAI env config).
 *
 * The rate-limit advisory (`tierLimits.<tier>.rateLimit.byAuthPath`) is keyed
 * on the auth-path string. `detectAuthPath` probes the environment and
 * returns whichever path the adapter would actually use, so the orchestrator
 * picks the correct advisory at fork-spawn time.
 */

export type AdapterId = 'claude' | 'gemini' | 'codex';

export type AuthPath =
  // claude paths
  | 'subscription'
  | 'api'
  | 'vertex'
  | 'bedrock'
  // gemini paths (subscription/api/vertex shared as strings; semantics vary per adapter)
  | 'ai-studio'
  // codex paths (subscription/api shared; azure unique)
  | 'azure';

export interface AuthPathProbeOptions {
  /** Env source; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve which auth path the adapter would use given the current env.
 * Pure function — no side effects, no shell execution. Caller must NOT
 * cache results across env-mutation boundaries (use 60s LRU at the call
 * site if caching is desired).
 */
export function detectAuthPath(
  adapter: AdapterId,
  opts: AuthPathProbeOptions = {}
): AuthPath {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const has = (k: string): boolean => !!env[k] && env[k]!.length > 0;
  const eq = (k: string, v: string): boolean => env[k] === v;

  if (adapter === 'claude') {
    if (eq('CLAUDE_CODE_USE_VERTEX', '1') || eq('CLAUDE_CODE_USE_VERTEX', 'true')) return 'vertex';
    if (eq('CLAUDE_CODE_USE_BEDROCK', '1') || eq('CLAUDE_CODE_USE_BEDROCK', 'true')) return 'bedrock';
    if (has('ANTHROPIC_API_KEY')) return 'api';
    return 'subscription';
  }

  if (adapter === 'gemini') {
    if (
      (eq('GOOGLE_GENAI_USE_VERTEXAI', 'true') || eq('GOOGLE_GENAI_USE_VERTEXAI', '1')) &&
      has('GOOGLE_CLOUD_PROJECT')
    ) {
      return 'vertex';
    }
    return 'ai-studio';
  }

  // codex
  const hasAzure =
    has('AZURE_OPENAI_API_KEY') || has('AZURE_OPENAI_ENDPOINT') || has('AZURE_OPENAI_BASE_URL');
  if (hasAzure && has('OPENAI_API_KEY')) return 'azure';
  if (has('OPENAI_API_KEY')) return 'api';
  return 'subscription';
}

/** All auth paths an adapter MAY use; used by manifest validation. */
export function authPathsFor(adapter: AdapterId): AuthPath[] {
  switch (adapter) {
    case 'claude':
      return ['subscription', 'api', 'vertex', 'bedrock'];
    case 'gemini':
      return ['ai-studio', 'vertex'];
    case 'codex':
      return ['subscription', 'api', 'azure'];
  }
}
