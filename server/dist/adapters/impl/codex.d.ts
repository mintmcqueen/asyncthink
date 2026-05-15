/**
 * OpenAI Codex CLI adapter.
 *
 * Targets codex v0.47.x (current at time of writing).
 *
 * Argv shape (first turn):
 *   codex exec --sandbox read-only --json --skip-git-repo-check --color never
 *              --output-last-message <tmp> --model <model> --cd <cwd>
 *              <prompt>
 *
 * Argv shape (resume):
 *   codex exec resume <threadId> --sandbox read-only --json --skip-git-repo-check
 *              --color never --output-last-message <tmp> --model <model>
 *              --cd <cwd> <prompt>
 *
 * Read-only: --sandbox read-only is the enforcement primitive. Earlier docs
 * referenced --ask-for-approval; that flag was removed in v0.47 — sandbox
 * mode now governs both access and approval flow. Read-only sandboxing means
 * the subordinate can analyze the codebase but cannot edit, exec, or hit the
 * network outside its model API connection.
 *
 * Session resume: native, via the 'resume' subcommand. The first turn reads
 * the thread id out of the {"type":"thread.started"} event in --json stdout
 * and echoes it back via AdapterResult.sessionId; the orchestrator passes
 * that id on the next call.
 *
 * Files: Codex has no --include-dirs equivalent. Files are inlined into the
 * prompt as XML-fenced sections at the top so the subordinate sees them as
 * context. --cd points Codex at the project root for any additional reads.
 *
 * Auth: requires `codex login` or OPENAI_API_KEY in env; failures surface as
 * "Failed to refresh token: 401 Unauthorized" in stderr/stdout.
 */
import type { Adapter, AdapterInvocation, AdapterResult } from '../../core/adapter.js';
import type { Executor } from '../../core/executor.js';
import type { IntelligenceTier } from '../../core/manifests.js';
import type { AuditLog } from '../../core/auditLog.js';
export declare class CodexAdapter implements Adapter {
    readonly id: "codex";
    readonly readOnly: true;
    readonly resumeStrategy: "native";
    private readonly defaultTimeoutMs;
    private readonly tiers;
    private readonly defaultTier;
    private readonly auditLog?;
    constructor(opts?: {
        defaultTimeoutMs?: number;
        tiers?: Record<IntelligenceTier, string>;
        defaultTier?: IntelligenceTier;
        /** v2.5.0 — receives `codex.overlay.materialize` audit events. */
        auditLog?: AuditLog;
    });
    invoke(inv: AdapterInvocation, exec: Executor): Promise<AdapterResult>;
}
