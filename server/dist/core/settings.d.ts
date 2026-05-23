/**
 * v2.6.0 — Settings: file-backed durable defaults for AsyncThink.
 *
 * Replaces v2.5.1's `ASYNCTHINK_DEFAULT_ADAPTER` env var with a layered
 * persistence model:
 *
 *   1. Per-call arg               (delegate({adapter: 'gemini'}))
 *   2. Skill frontmatter          (skill pins adapter)
 *   3. Project settings           (.claude/asyncthink.local.md in cwd/ancestors)
 *   4. User settings              (~/.config/asyncthink/settings.toml)
 *   5. Built-in default           (defaults.adapter = "claude")
 *
 * Layer 5 reflects the "running inside Claude Code" framing — claude is
 * the implicit default, and the v2.6.0 claude adapter spawns a dedicated
 * subagent on the subscription auth path to keep the delegate persona
 * distinct from the parent session.
 *
 * The Settings interface is the v3-portable contract; v3 RemoteCompanion
 * substitutes a server-backed store at the same interface.
 */
export type AdapterId = 'claude' | 'gemini' | 'codex';
export interface SettingsValues {
    defaults?: {
        /** Adapter to use when caller omits `adapter` and skill doesn't pin one. */
        adapter?: AdapterId;
        /** Subagent id to bind to claude adapter spawns on subscription auth path. */
        subagent?: string;
    };
}
/**
 * Where a particular setting value came from in the resolution chain. Tool
 * responses surface this so the user can debug "why is delegate picking X?"
 * without spelunking the codebase.
 */
export type SettingsLayerSource = 'builtin' | 'user' | 'project';
export interface SettingsLayer {
    source: SettingsLayerSource;
    /** Absolute path to the file, or undefined for builtin. */
    path?: string;
    /** Whether the file exists on disk (true for builtin always). */
    exists: boolean;
    /** Raw values from this layer (after parsing). */
    values: SettingsValues;
}
export interface EffectiveSettings {
    /** Merged values, top of stack wins. */
    effective: SettingsValues;
    /** Per-layer breakdown for debug + tool response. */
    layers: SettingsLayer[];
}
/**
 * Read-write interface. v2.6 ships FsSettingsStore; v3 substitutes
 * RemoteSettingsStore behind the same shape.
 */
export interface SettingsStore {
    /** Return effective settings + per-layer breakdown. */
    get(): Promise<EffectiveSettings>;
    /** Update one key at the given scope. Atomic write + cache invalidation. */
    set(key: string, value: unknown, scope: 'user' | 'project'): Promise<EffectiveSettings>;
    /** Clear one key from the given scope. */
    unset(key: string, scope: 'user' | 'project'): Promise<EffectiveSettings>;
}
/**
 * Built-in defaults — the lowest-precedence layer. Choices here are
 * intentional and reflect AsyncThink's framing:
 *   - adapter: "claude" because AsyncThink is invoked from inside Claude
 *     Code; claude is the implicit subordinate.
 *   - subagent: "asyncthink-delegate" — the plugin-shipped subagent that
 *     gives the claude-subscription path a distinct persona.
 */
export declare const BUILTIN_DEFAULTS: SettingsValues;
/**
 * Dotted-path lookup: 'defaults.adapter' → values?.defaults?.adapter.
 * Returns undefined for missing paths. Pure function; exported for tests
 * and tool handlers that need to read a single key.
 */
export declare function readPath(values: SettingsValues, key: string): unknown;
/**
 * Dotted-path set: returns a new SettingsValues with key set to value.
 * Pure function; used by FsSettingsStore.set to compute the new on-disk
 * shape before atomic write.
 */
export declare function setPath(values: SettingsValues, key: string, value: unknown): SettingsValues;
export declare function unsetPath(values: SettingsValues, key: string): SettingsValues;
/**
 * Merge layer values bottom-up. Later layers override earlier; objects
 * deep-merge, scalars replace.
 */
export declare function mergeLayers(layers: SettingsValues[]): SettingsValues;
export declare function validateKey(key: string, value: unknown): {
    valid: true;
} | {
    valid: false;
    reason: string;
};
