/**
 * Skill ↔ adapter conflict validator (F1 companion).
 *
 * A skill can pin BOTH `intelligence` and `model` in its frontmatter. The
 * tierResolver throws TierModelConflictError at invoke time if those two
 * resolve to different ids. This validator surfaces the same conflict at
 * registry-load time so the operator sees it as a stderr warning before
 * any caller hits it in production.
 *
 * Pure function — no I/O, no globals — so it's trivially unit-testable.
 */
import type { AdapterManifest } from '../core/manifests.js';
import type { Skill } from '../core/skillRegistry.js';
export interface SkillConflict {
    skillName: string;
    adapter: string;
    intelligence: string;
    pinnedModel: string;
    tierModel: string;
}
export declare function findSkillConflicts(skills: Skill[], manifests: AdapterManifest[]): SkillConflict[];
export declare function formatSkillConflict(c: SkillConflict): string;
