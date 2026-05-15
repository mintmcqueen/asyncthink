/**
 * SkillRegistry — markdown-frontmatter delegation templates.
 *
 * Each skill names an adapter, optional default model + globs + timeout, a
 * description for tool consumers, and a prompt body that becomes the system
 * prefix for the subordinate.
 *
 * Loaded from two locations:
 *   - <plugin-root>/skills/<name>/SKILL.md       (built-ins)
 *   - ~/.config/asyncthink/skills/<name>.md      (user)
 * User skills with the same id override built-ins.
 */
import type { IntelligenceTier } from './manifests.js';
export interface Skill {
    /** Stable id used in delegate({skill: "..."}) and asyncthink fork.skill. */
    name: string;
    /** Adapter id that this skill dispatches to. */
    adapter: string;
    /** Optional intelligence tier; overridden by caller's tier or model. */
    intelligence?: IntelligenceTier;
    /**
     * Optional raw model id override (escape hatch). Prefer `intelligence` so
     * the skill stays stable across model-name churn.
     */
    model?: string;
    /** Optional file glob that resolves at invocation time. */
    filesGlob?: string;
    /** Optional timeout override. */
    timeoutMs?: number;
    /** Short description shown in tool descriptions and listings. */
    description: string;
    /** Markdown body appended as system prefix to the subordinate's prompt. */
    promptBody: string;
    /** Where this skill was loaded from. */
    source: 'plugin' | 'user';
    /**
     * v2.2 — credential profile name. Wire-format only in v2.2 (R-CRED-D.1);
     * any non-default profile is rejected at dispatch time (R-CRED-D.2).
     */
    credentials?: string;
    /**
     * v2.2 — does this skill pin a raw `model:` id in its frontmatter? Surfaces
     * via asyncthink_config.list_skills for operator introspection (R6b-D.3).
     */
    pinsModel?: string | null;
    /**
     * v2.2 — when `pinsModel` is set, is the pinned id still a current tier
     * value in the skill's adapter manifest? Set by SkillRegistry after the
     * adapter manifests are loaded (R6b-D.3).
     */
    pinIsCurrent?: boolean;
    /**
     * v2.3 — additive MCP-server allowlist for adapter spawn (F3-D.2). Merged
     * with `manifest.mcp.allowlist` and caller's `mcpServers` at spawn time;
     * skills CANNOT remove servers from the union.
     */
    mcpServers?: string[];
    /**
     * v2.3 — opt-in auth pre-flight gate (R-DIAG-D.4). When 'auth', the
     * executor runs a local auth-status probe before allocating a task row;
     * fails fast with AdapterError(kind='auth') on probe failure.
     */
    preflight?: 'auth' | 'none';
    /** v2.3.3 — auth-path override for the rate-limit gate. */
    authPath?: string;
    /** v2.3.3 — opt-out of the rate-limit refuse for invocations using this skill. */
    bypassRateLimit?: boolean;
}
export interface SkillRegistry {
    /** All skills, with user overriding plugin on id collision. */
    list(): Promise<Skill[]>;
    /** Resolve a skill by id, or undefined if absent. */
    get(name: string): Promise<Skill | undefined>;
    /** Re-scan both source dirs. Idempotent. */
    reload(): Promise<void>;
}
