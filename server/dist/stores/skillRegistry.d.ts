/**
 * FsSkillRegistry — markdown-frontmatter skill loader.
 *
 * Reads skills from two locations:
 *   - <plugin-root>/skills/<name>/SKILL.md       (built-ins)
 *   - ~/.config/asyncthink/skills/<name>.md      (user)
 *
 * User skills override plugin skills with the same id.
 *
 * Frontmatter format is a small subset of YAML — line-oriented `key: value`
 * pairs only, no nested objects, no flow style. Scalars are parsed as:
 *   - integer if matches /^-?\d+$/
 *   - boolean for "true"/"false"
 *   - string otherwise (quotes optional)
 *
 * Anything between the first `---` and the next `---` is the frontmatter;
 * content after the closing `---` is the prompt body.
 */
import type { Skill, SkillRegistry } from '../core/skillRegistry.js';
export interface FsSkillRegistryOptions {
    pluginSkillsDir?: string;
    userSkillsDir?: string;
}
export declare class FsSkillRegistry implements SkillRegistry {
    private cache;
    private readonly pluginSkillsDir;
    private readonly userSkillsDir;
    constructor(opts?: FsSkillRegistryOptions);
    list(): Promise<Skill[]>;
    get(name: string): Promise<Skill | undefined>;
    reload(): Promise<void>;
    private scan;
}
interface ParsedDocument {
    frontmatter: Record<string, unknown>;
    body: string;
}
export declare function parseFrontmatter(raw: string): ParsedDocument | undefined;
export {};
