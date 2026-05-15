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
export type AuthPath = 'subscription' | 'api' | 'vertex' | 'bedrock' | 'ai-studio' | 'azure';
export interface AuthPathProbeOptions {
    /** Env source; defaults to process.env. */
    env?: Record<string, string | undefined>;
}
/**
 * Resolve which auth path the adapter would use given the current env.
 * Pure function — no side effects, no shell execution. Caller must NOT
 * cache results across env-mutation boundaries (use 60s LRU at the call
 * site if caching is desired).
 *
 * v2.3.1 (B4): exhaustive switch over `AdapterId`. An unknown adapter id
 * throws rather than silently falling through to the codex branch — the
 * manifest registry allows arbitrary adapter ids, so this safety net catches
 * misconfigured manifests instead of producing wrong advisories.
 */
export declare function detectAuthPath(adapter: AdapterId, opts?: AuthPathProbeOptions): AuthPath;
/** All auth paths an adapter MAY use; used by manifest validation. */
export declare function authPathsFor(adapter: AdapterId): AuthPath[];
