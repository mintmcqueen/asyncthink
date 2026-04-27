/**
 * Council fork prompt utilities.
 *
 * v2 council does not bake worker-type branches into the server. The caller
 * (or a registered skill in Phase 4) supplies the per-fork prompt directly.
 * This module keeps a lightweight `wrapWithCouncilContext` helper for adding
 * a uniform header that orients the subordinate to its role in a council.
 */
export interface CouncilContext {
    /** The thought number that spawned this fork. */
    thoughtNumber: number;
    /** Hint about the surrounding deliberation, optional. */
    surroundingThought?: string;
}
export declare function wrapWithCouncilContext(prompt: string, ctx: CouncilContext): string;
