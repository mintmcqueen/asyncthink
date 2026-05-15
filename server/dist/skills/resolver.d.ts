/**
 * Skill resolution helpers.
 *
 * Tool handlers call resolveSkillInto* to apply a skill's frontmatter
 * defaults onto a delegate or fork request. The skill's promptBody becomes
 * the system prefix; caller's prompt is appended below.
 *
 * Adapter override: a skill's frontmatter `adapter` always wins. If the
 * caller passes a different adapter explicitly, we error — overriding a
 * skill's adapter would defeat its purpose. Models and timeouts can be
 * overridden by the caller.
 *
 * v2.2 — when a skill pins a raw `model:` and that id is not in the
 * adapter's current tier map, we apply R6b-D.2 successor substitution at
 * resolution time: the skill's `model` is rewritten to the adapter's
 * defaultTier model and a `model.substitute` audit event is recorded. The
 * substitution is opt-in (driven by the resolver caller passing in a
 * manifest registry) so unit tests of the resolver remain independent of
 * the manifest system.
 */
import type { AuditLog } from '../core/auditLog.js';
import type { IntelligenceTier, ManifestRegistry } from '../core/manifests.js';
import type { Skill, SkillRegistry } from '../core/skillRegistry.js';
export interface ResolvedSkill {
    adapter: string;
    prompt: string;
    intelligence?: IntelligenceTier;
    model?: string;
    timeoutMs?: number;
    filesGlob?: string;
    /** v2.2 — credential profile from skill frontmatter (R-CRED-D.1 wire-only). */
    credentials?: string;
    /** v2.2 — substituted-from id (R6b-D.2) when skill-pin substitution kicked in. */
    substitutedFrom?: string;
    /** v2.3 — additive MCP-server allowlist from skill frontmatter (F3-D.2). */
    mcpServers?: string[];
    /** v2.3 — auth pre-flight opt-in from skill frontmatter (R-DIAG-D.4). */
    preflight?: 'auth' | 'none';
}
export interface SkillResolutionInput {
    skill: string;
    callerPrompt: string;
    /** Optional adapter the caller specified; must match the skill's adapter. */
    callerAdapter?: string;
    /** Caller's intelligence tier (wins over skill default). */
    callerIntelligence?: IntelligenceTier;
    /** Caller's raw model override (wins over everything). */
    callerModel?: string;
    /** Caller's timeout override (wins). */
    callerTimeoutMs?: number;
    /** Caller's credentials override (wins over skill's). */
    callerCredentials?: string;
}
export interface SkillResolutionContext {
    /** When provided, skill-pinned models that are out-of-tier are substituted (R6b-D.2). */
    manifests?: ManifestRegistry;
    auditLog?: AuditLog;
    /** stderr writer for warnings. */
    stderr?: (s: string) => void;
}
export declare class SkillNotFoundError extends Error {
    constructor(name: string);
}
export declare class SkillAdapterMismatchError extends Error {
    constructor(skill: Skill, caller: string);
}
export declare function resolveSkill(registry: SkillRegistry, input: SkillResolutionInput, ctx?: SkillResolutionContext): Promise<ResolvedSkill>;
