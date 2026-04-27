/**
 * Phase 0 stub response helper.
 *
 * Every tool handler returns this until its real implementation lands in a
 * later phase. The message points users at v1.1.9 (the last shipped tag) for
 * stable behavior.
 */
export declare const PHASE_0_NOTICE = "v2 refactor in progress on this branch. Pin to the v1.1.9 git tag for stable behavior.";
export declare function stubResponse(toolName: string): {
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: {
        status: string;
        tool: string;
        notice: string;
    };
};
