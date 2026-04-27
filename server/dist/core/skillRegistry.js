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
export {};
