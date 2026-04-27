/**
 * Gemini CLI adapter.
 *
 * Argv shape:
 *   gemini -p <prompt> --output-format json --approval-mode plan -m <model>
 *          [--include-directories <dir1,dir2,...>]
 *
 * Read-only: --approval-mode plan puts Gemini in planning mode, which is the
 * read-only navigation/analysis profile.
 *
 * Session resume: Gemini's --resume flag accepts an index/'latest' from its
 * own session list, not an externally-controlled id. v1 uses the replay
 * strategy: orchestrator prepends prior turns to inv.prompt; this adapter
 * echoes inv.sessionId back (or mints a uuid). Native session resume can be
 * adopted later if live testing shows it's reliable across invocations.
 *
 * Files: passed via --include-directories (Gemini works at directory
 * granularity, not file). The adapter dedupes parent directories of the
 * provided file paths.
 */
import type { Adapter, AdapterInvocation, AdapterResult } from '../../core/adapter.js';
import type { Executor } from '../../core/executor.js';
import type { IntelligenceTier } from '../../core/manifests.js';
export declare class GeminiAdapter implements Adapter {
    readonly id: "gemini";
    readonly readOnly: true;
    readonly resumeStrategy: "replay";
    private readonly defaultTimeoutMs;
    private readonly tiers;
    private readonly defaultTier;
    constructor(opts?: {
        defaultTimeoutMs?: number;
        tiers?: Record<IntelligenceTier, string>;
        defaultTier?: IntelligenceTier;
    });
    invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult>;
}
