/**
 * Claude Code adapter.
 *
 * Argv shape: claude --print <prompt>
 *
 * Session resume: Claude Code has no native cross-invocation session id we
 * can address from the outside. Strategy: orchestrator prepends prior-turn
 * history to inv.prompt before calling. This adapter echoes inv.sessionId
 * back unchanged (or mints a uuid if absent) so the caller has a stable
 * thread id.
 *
 * Files: prepended to the prompt as a "Files:" header listing absolute paths.
 * Claude Code resolves the paths relative to inv.cwd at read time.
 *
 * Read-only: Claude Code is invoked without any --allow-tool flags and we
 * never expose write capabilities. The subprocess inherits no edit tools by
 * default in --print mode.
 */
import type { Adapter, AdapterInvocation, AdapterResult } from '../../core/adapter.js';
import type { Executor } from '../../core/executor.js';
import type { IntelligenceTier } from '../../core/manifests.js';
export declare class ClaudeAdapter implements Adapter {
    readonly id: "claude";
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
