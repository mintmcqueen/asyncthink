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
  /** v2.3.3 — auth-path override from skill frontmatter. */
  authPath?: string;
  /** v2.3.3 — opt-out of rate-limit refuse from skill frontmatter. */
  bypassRateLimit?: boolean;
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
  input: SkillResolutionInput,
  ctx: SkillResolutionContext = {}
): Promise<ResolvedSkill> {
  const skill = await registry.get(input.skill);
  if (!skill) throw new SkillNotFoundError(input.skill);
  if (input.callerAdapter && input.callerAdapter !== skill.adapter) {
    throw new SkillAdapterMismatchError(skill, input.callerAdapter);
  }

  let model = input.callerModel ?? skill.model;
  let substitutedFrom: string | undefined;
  // Skill-pinning policy (R6b-D.2) — only applies when the model came from
  // skill frontmatter (not from caller override) and we have manifests.
  if (
    !input.callerModel &&
    skill.model &&
    skill.model.length > 0 &&
    ctx.manifests
  ) {
    const manifest = await ctx.manifests.get(skill.adapter);
    if (manifest) {
      const tierIds = new Set(Object.values(manifest.tiers));
      if (!tierIds.has(skill.model)) {
        const substitute = manifest.tiers[manifest.defaultTier];
        const warn =
          ctx.stderr ?? ((s: string) => console.error(s));
        warn(
          `[Skill:${skill.name}] Pinned model "${skill.model}" is not in current adapter "${skill.adapter}" tier map; ` +
            `substituting defaultTier "${manifest.defaultTier}" → "${substitute}". (R6b-D.2)`
        );
        if (ctx.auditLog) {
          void ctx.auditLog
            .record({
              kind: 'model.substitute',
              adapter: skill.adapter,
              from: skill.model,
              to: substitute,
              tier: manifest.defaultTier,
              reason: `skill-pin-stale (skill="${skill.name}")`,
            })
            .catch(() => {
              /* never throw to caller */
            });
        }
        substitutedFrom = skill.model;
        model = substitute;
      }
    }
  }

  return {
    adapter: skill.adapter,
    prompt: composePrompt(skill.promptBody, input.callerPrompt),
    intelligence: input.callerIntelligence ?? skill.intelligence,
    model,
    timeoutMs: input.callerTimeoutMs ?? skill.timeoutMs,
    filesGlob: skill.filesGlob,
    credentials: input.callerCredentials ?? skill.credentials,
    substitutedFrom,
    mcpServers: skill.mcpServers,
    preflight: skill.preflight,
    authPath: skill.authPath,
    bypassRateLimit: skill.bypassRateLimit,
  };
}

function composePrompt(promptBody: string, callerPrompt: string): string {
  const trimmedBody = promptBody.trim();
  const trimmedCaller = callerPrompt.trim();
  if (!trimmedBody) return trimmedCaller;
  if (!trimmedCaller) return trimmedBody;
  return `${trimmedBody}\n\n---\n\n${trimmedCaller}`;
}
