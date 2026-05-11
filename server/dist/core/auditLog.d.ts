/**
 * AuditLog — record of every adapter invocation and thread lifecycle event.
 *
 * Built from day 1 even though v1 isn't SOC2-attested — capturing logs early
 * means real audit data is available when v3 pursues SOC2 Type 1.
 *
 * v1: append-only JSONL at ~/.local/share/asyncthink/audit.jsonl.
 * v3: Cloud Logging.
 *
 * v2.3: new `task.terminated` event (R5-D.5) paired 1:1 with `task.cancel` to
 * confirm subprocess exit. Reserves `signal: 'orphaned'` for v3 watchdog.
 */
export type AuditEvent = {
    kind: 'invoke';
    adapter: string;
    durationMs: number;
    tokensIn?: number;
    tokensOut?: number;
    threadId?: string;
    error?: string;
} | {
    kind: 'thread.open' | 'thread.close';
    threadId: string;
    adapter: string;
} | {
    kind: 'task.create';
    taskId: string;
    adapter: string;
    detached: boolean;
    principal: string | null;
    idempotencyKey?: string;
} | {
    kind: 'task.complete' | 'task.fail';
    taskId: string;
    adapter: string;
    durationMs: number;
    error?: string;
} | {
    kind: 'task.cancel' | 'task.expire';
    taskId: string;
    adapter: string;
    reason?: string;
} | {
    kind: 'model.substitute';
    adapter: string;
    from: string;
    to: string;
    tier: 'high' | 'med' | 'low';
    reason: string;
} | {
    kind: 'task.terminated';
    taskId: string;
    adapter: string;
    /** ISODate of the subprocess close event (or now() if no subprocess existed). */
    terminatedAt: string;
    /** OS signal reported by ChildProcess.on('close'), or 'orphaned' for v3 watchdog deadline. */
    signal?: NodeJS.Signals | 'orphaned';
    /** Exit code reported by ChildProcess.on('close'), if any. */
    exitCode?: number;
};
export interface AuditLog {
    /** Record an event. Should never throw to the caller; log internally on failure. */
    record(event: AuditEvent): Promise<void>;
}
