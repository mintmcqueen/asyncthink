/**
 * v2.6.0 — FsSubagentRegistry: JSON-per-file at
 *   ~/.local/share/asyncthink/subagents/<sanitized-id>.json
 *
 * Mirrors the existing AsyncThink storage pattern (ThreadStore + TaskStore
 * are both filesystem-backed JSONL/JSON; no SQLite dep).
 *
 * Atomic writes via tmp+rename. List walks the directory; reads parse each
 * file independently (one corrupt file doesn't break list).
 *
 * Built-in bootstrap: on first server boot, missing built-ins are written.
 * User-created subagents shadow built-ins by id.
 */
import type { BuiltinSubagent, Subagent, SubagentCreateInput, SubagentRegistry, SubagentUpdateInput } from '../core/subagent.js';
export interface FsSubagentRegistryOptions {
    /** Override storage dir (for tests). Defaults to ~/.local/share/asyncthink/subagents. */
    storageDir?: string;
    /** Clock for createdAt/lastUsedAt stamps. */
    now?: () => Date;
}
export declare class FsSubagentRegistry implements SubagentRegistry {
    private readonly storageDir;
    private readonly now;
    constructor(opts?: FsSubagentRegistryOptions);
    list(): Promise<Subagent[]>;
    get(id: string): Promise<Subagent | undefined>;
    create(input: SubagentCreateInput): Promise<Subagent>;
    update(id: string, patch: SubagentUpdateInput): Promise<Subagent>;
    delete(id: string): Promise<{
        deleted: boolean;
    }>;
    /**
     * Touch lastUsedAt — called by the claude adapter on successful spawn.
     * Not part of the SubagentRegistry public interface (it's a side-effect
     * the adapter performs), but exposed here for completeness.
     */
    markUsed(id: string): Promise<void>;
    bootstrapBuiltins(builtins: BuiltinSubagent[]): Promise<void>;
    /**
     * v2.8.1 — gate every filesystem path construction on the id-validity
     * check. This is defense-in-depth: even if a caller forgets to validate
     * before reaching this method, traversal sequences (`../`, absolute
     * paths, dotfiles, etc.) are rejected at the source.
     *
     * Throws `SubagentIdInvalidError` rather than returning undefined,
     * because reaching pathFor() means a caller intended a real filesystem
     * operation; returning undefined would hide bugs.
     */
    private pathFor;
    private write;
}
/**
 * v2.8.1 — thrown when a method is called with an id that doesn't match
 * the slugified form. Surfaces caller bugs instead of silently no-op'ing.
 */
export declare class SubagentIdInvalidError extends Error {
    constructor(id: string);
}
declare function defaultStorageDir(): string;
export declare const __testing: {
    defaultStorageDir: typeof defaultStorageDir;
};
export {};
