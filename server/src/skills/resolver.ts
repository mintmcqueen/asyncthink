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

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`Skill "${name}" not registered. Run asyncthink_config({action:"list_skills"}) to see available skills.`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillAdapterMismatchError extends Error {
  constructor(skill: Skill, caller: string) {
    super(
      `Skill "${skill.name}" requires adapter "${skill.adapter}", but caller specified "${caller}". ` +
        'Drop the adapter argument or pick a different skill.'
    );
    this.name = 'SkillAdapterMismatchError';
  }
}

export async function resolveSkill(
  registry: SkillRegistry,
  input: SkillResolutionInput
): Promise<ResolvedSkill> {
  const skill = await registry.get(input.skill);
  if (!skill) throw new SkillNotFoundError(input.skill);
  if (input.callerAdapter && input.callerAdapter !== skill.adapter) {
    throw new SkillAdapterMismatchError(skill, input.callerAdapter);
  }
  return {
    adapter: skill.adapter,
    prompt: composePrompt(skill.promptBody, input.callerPrompt),
    intelligence: input.callerIntelligence ?? skill.intelligence,
    model: input.callerModel ?? skill.model,
    timeoutMs: input.callerTimeoutMs ?? skill.timeoutMs,
    filesGlob: skill.filesGlob,
  };
}

function composePrompt(promptBody: string, callerPrompt: string): string {
  const trimmedBody = promptBody.trim();
  const trimmedCaller = callerPrompt.trim();
  if (!trimmedBody) return trimmedCaller;
  if (!trimmedCaller) return trimmedBody;
  return `${trimmedBody}\n\n---\n\n${trimmedCaller}`;
}
