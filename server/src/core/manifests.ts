/**
 * Adapter manifest loader (metadata only).
 *
 * Manifests live at ../adapters/manifests/<id>.json and carry display name,
 * default model, env-var requirements, default timeout, etc. — never argv shape
 * or execution semantics. Execution lives in ../adapters/impl/<id>.ts.
 *
 * Why split: argv shape varies too much across CLIs (Gemini's --include-dirs,
 * Codex's inline-files-in-prompt, native vs replay session resume) for clean
 * JSON templating. Metadata templates well; execution doesn't.
 *
 * v2.3 schema additions:
 *   - `tierLimits.<tier>.rateLimit: { byAuthPath, default, lastVerified }`
 *     replaces v2.2's `rateLimitClass` (R6a-D.4). Legacy `rateLimitClass`
 *     stays during the deprecation window; dropped in v2.4.
 *   - `mcp: { allowlist, catalog }` (F3-D.2) — curated MCP-server set for
 *     adapter spawn.
 */

import type { AuthPath } from '../adapters/authPath.js';

export type IntelligenceTier = 'high' | 'med' | 'low';

/** Rate-limit class advisory for the resolved model (R6a-D.1 + R6a-D.4). */
export type RateLimitClass = 'standard' | 'rate-limited' | 'unlimited';

/** Structured advisory body per auth-path (R6a-D.4). */
export interface RateLimitAdvisory {
  class: RateLimitClass;
  cap?: {
    tokens: number;
    windowSec: number;
    dim: 'input' | 'output' | 'requests' | 'messages';
  };
  evidenceUrl?: string;
  notes?: string;
}

/**
 * Per-tier facts (R6a-D.1, R6a-D.4). All fields optional; missing fields mean
 * "no advisory available" — callers should not assume defaults.
 */
export interface TierLimits {
  /** Approximate maximum input-context tokens for this tier's model. */
  maxContext?: number;
  /**
   * v2.3 — auth-path-aware rate-limit advisory.
   * `byAuthPath`: keyed by auth path string; not every adapter supports every key.
   * `default`: which path to use when env probe is inconclusive.
   * `lastVerified`: ISODate; tripwire for staleness (R6a-D.7).
   */
  rateLimit?: {
    byAuthPath: Partial<Record<AuthPath, RateLimitAdvisory>>;
    default: AuthPath;
    lastVerified: string;
  };
  /** @deprecated v2.2 carry-through; dropped in v2.4. Use rateLimit.byAuthPath instead. */
  rateLimitClass?: RateLimitClass;
  /** Expected p50 latency in milliseconds (informational only). */
  expectedLatencyMsP50?: number;
}

/** Curated MCP-server allowlist + informational catalog (F3-D.2). */
export interface McpManifest {
  /** Server names allowed by default at adapter spawn. */
  allowlist: string[];
  /** Informational list of servers known to compose well with this adapter. */
  catalog?: string[];
}

export interface AdapterManifest {
  /** Must match the adapter impl's id. */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Path-resolved CLI binary. */
  binary: string;
  /**
   * Model id per intelligence tier. Callers select by tier (`intelligence:
   * "high"`); raw model overrides are still allowed as an escape hatch.
   * Updating model defaults across the stack means editing this map only.
   */
  tiers: Record<IntelligenceTier, string>;
  /** Tier used when neither `intelligence` nor `model` is specified. */
  defaultTier: IntelligenceTier;
  /**
   * Env-var names; at least one must be set (OR semantics) for the adapter to
   * be usable. Empty array means no env requirement (e.g. Claude using
   * subscription auth via the local CLI).
   */
  requiredEnv: string[];
  /** Default subprocess timeout in milliseconds. */
  defaultTimeoutMs: number;
  /** Free-text human description. */
  description?: string;
  /**
   * v2.2 — per-tier facts (max context, rate-limit class, expected latency).
   * Load-bearing: pre-flight context-size check uses `maxContext` to reject
   * oversized prompts; rate-limit advisory drives pre-flight refuse (R6a-D.5).
   */
  tierLimits?: Partial<Record<IntelligenceTier, TierLimits>>;
  /** v2.3 — curated MCP-server configuration for adapter spawn (F3-D.2). */
  mcp?: McpManifest;
}

export interface ManifestRegistry {
  /** Load all manifests from the bundled adapters/manifests/ dir. */
  loadAll(): Promise<AdapterManifest[]>;
  /** Resolve a manifest by adapter id. */
  get(id: string): Promise<AdapterManifest | undefined>;
}
