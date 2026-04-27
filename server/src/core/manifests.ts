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
 */

export type IntelligenceTier = 'high' | 'med' | 'low';

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
}

export interface ManifestRegistry {
  /** Load all manifests from the bundled adapters/manifests/ dir. */
  loadAll(): Promise<AdapterManifest[]>;
  /** Resolve a manifest by adapter id. */
  get(id: string): Promise<AdapterManifest | undefined>;
}
