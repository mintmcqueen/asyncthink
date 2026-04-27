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
export function findSkillConflicts(skills, manifests) {
    const byId = new Map(manifests.map((m) => [m.id, m]));
    const issues = [];
    for (const s of skills) {
        if (!s.intelligence || !s.model)
            continue;
        const m = byId.get(s.adapter);
        if (!m)
            continue;
        const tierModel = m.tiers[s.intelligence];
        if (tierModel && tierModel !== s.model) {
            issues.push({
                skillName: s.name,
                adapter: s.adapter,
                intelligence: s.intelligence,
                pinnedModel: s.model,
                tierModel,
            });
        }
    }
    return issues;
}
export function formatSkillConflict(c) {
    return (`[SkillRegistry] Skill "${c.skillName}" has conflicting metadata: ` +
        `adapter="${c.adapter}" intelligence="${c.intelligence}" maps to "${c.tierModel}" ` +
        `but model="${c.pinnedModel}" is pinned. The skill will fail at invoke time ` +
        `with TierModelConflictError. Drop one of the fields or align them.`);
}
