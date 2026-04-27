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
 */
import type { IntelligenceTier } from '../core/manifests.js';
import type { Skill, SkillRegistry } from '../core/skillRegistry.js';
export interface ResolvedSkill {
    adapter: string;
    prompt: string;
    intelligence?: IntelligenceTier;
    model?: string;
    timeoutMs?: number;
    filesGlob?: string;
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
}
export declare class SkillNotFoundError extends Error {
    constructor(name: string);
}
export declare class SkillAdapterMismatchError extends Error {
    constructor(skill: Skill, caller: string);
}
export declare function resolveSkill(registry: SkillRegistry, input: SkillResolutionInput): Promise<ResolvedSkill>;
