/**
 * v2.6.0 — FsSettingsStore: TOML + YAML-frontmatter backed settings layer.
 *
 * User scope:    ~/.config/asyncthink/settings.toml          (TOML, full file)
 * Project scope: <cwd-or-ancestor>/.claude/asyncthink.local.md
 *                  (YAML frontmatter only; markdown body is ignored)
 *
 * Why two formats:
 *   - User scope mirrors codex (~/.codex/config.toml) and AWS (~/.aws/config)
 *     conventions — TOML is the right idiom for "user config file you might
 *     hand-edit."
 *   - Project scope mirrors Claude Code's plugin-name.local.md pattern that
 *     skill-files already follow; YAML frontmatter is what we already parse
 *     in stores/skillRegistry.ts.
 *
 * Zero parser deps — we ship a minimal TOML + YAML reader/emitter for
 * exactly the shape we accept (defaults.adapter, defaults.subagent). If we
 * later expand the schema, this gets factored, not third-party-replaced.
 *
 * Atomic write: write-to-temp + rename. Cache invalidates on every set/unset.
 */
import type { EffectiveSettings, SettingsStore, SettingsValues } from '../core/settings.js';
export interface FsSettingsStoreOptions {
    /** Override user-settings path (for tests). Defaults to ~/.config/asyncthink/settings.toml. */
    userSettingsPath?: string;
    /** Override starting cwd for project-settings walk (for tests). Defaults to process.cwd(). */
    cwd?: string;
}
export declare class FsSettingsStore implements SettingsStore {
    private readonly userPath;
    private readonly cwd;
    private cache;
    constructor(opts?: FsSettingsStoreOptions);
    get(): Promise<EffectiveSettings>;
    set(key: string, value: unknown, scope: 'user' | 'project'): Promise<EffectiveSettings>;
    unset(key: string, scope: 'user' | 'project'): Promise<EffectiveSettings>;
    private load;
    private readUser;
    private writeUser;
    private readProjectFile;
    private writeProject;
    /**
     * Walk up from cwd looking for a `.claude/asyncthink.local.md`. Stops at
     * the first match or the filesystem root. Returns the absolute path of
     * the file (whether it exists yet or not, when createIfMissing).
     */
    private locateProjectPath;
}
export declare function parseToml(text: string): SettingsValues;
export declare function emitToml(values: SettingsValues): string;
export declare function parseYamlFrontmatter(text: string): SettingsValues;
export declare function emitYamlFrontmatter(values: SettingsValues): string;
