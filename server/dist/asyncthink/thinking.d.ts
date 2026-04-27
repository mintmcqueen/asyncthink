/**
 * AsyncThink sequential thinking core.
 *
 * Ported verbatim from server/src.v1/lib/thinking.ts. The thinking engine
 * itself is unchanged in v2 — what changes is how forks dispatch to
 * subordinate adapters (see ./council.ts).
 */
/**
 * Input for a single thought step.
 */
export interface ThoughtInput {
    thought: string;
    thoughtNumber: number;
    totalThoughts: number;
    nextThoughtNeeded: boolean;
    isRevision?: boolean;
    revisesThought?: number;
    branchFromThought?: number;
    branchId?: string;
    needsMoreThoughts?: boolean;
}
export declare class AsyncThinkingServer {
    private thoughtHistory;
    private branches;
    private disableThoughtLogging;
    constructor();
    private formatThought;
    processThought(input: ThoughtInput): {
        content: Array<{
            type: 'text';
            text: string;
        }>;
        isError?: boolean;
    };
}
