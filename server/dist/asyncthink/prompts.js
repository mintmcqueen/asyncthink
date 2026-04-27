/**
 * Council fork prompt utilities.
 *
 * v2 council does not bake worker-type branches into the server. The caller
 * (or a registered skill in Phase 4) supplies the per-fork prompt directly.
 * This module keeps a lightweight `wrapWithCouncilContext` helper for adding
 * a uniform header that orients the subordinate to its role in a council.
 */
export function wrapWithCouncilContext(prompt, ctx) {
    const header = [
        'You are one voice in a council of independent reasoners advising a central orchestrator.',
        `This council was convened during thought ${ctx.thoughtNumber} of a sequential reasoning chain.`,
    ];
    if (ctx.surroundingThought) {
        header.push(`Surrounding deliberation:\n${ctx.surroundingThought}`);
    }
    header.push('Other council members may be reasoning on the same problem from different vantage points; you do not see their responses. Be focused, calibrated, and forthright. The orchestrator will reconcile competing views.', '');
    return header.join('\n') + '\n' + prompt;
}
