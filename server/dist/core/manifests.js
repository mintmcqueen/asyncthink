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
export {};
