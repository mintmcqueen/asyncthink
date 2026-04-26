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

export interface Skill {
  /** Stable id used in delegate({skill: "..."}) and asyncthink fork.skill. */
  name: string;
  /** Adapter id that this skill dispatches to. */
  adapter: string;
  /** Optional adapter-specific model override. */
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
}

export interface SkillRegistry {
  /** All skills, with user overriding plugin on id collision. */
  list(): Promise<Skill[]>;
  /** Resolve a skill by id, or undefined if absent. */
  get(name: string): Promise<Skill | undefined>;
  /** Re-scan both source dirs. Idempotent. */
  reload(): Promise<void>;
}
