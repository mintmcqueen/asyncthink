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

export interface AdapterManifest {
  /** Must match the adapter impl's id. */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Path-resolved CLI binary. */
  binary: string;
  /** Default model id used when an invocation does not specify one. */
  defaultModel: string;
  /** Env-var names that must be set for the adapter to be usable. */
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
