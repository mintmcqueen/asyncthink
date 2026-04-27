/**
 * AuditLog — record of every adapter invocation and thread lifecycle event.
 *
 * Built from day 1 even though v1 isn't SOC2-attested — capturing logs early
 * means real audit data is available when v3 pursues SOC2 Type 1.
 *
 * v1: append-only JSONL at ~/.local/share/asyncthink/audit.jsonl.
 * v3: Cloud Logging.
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
};
export interface AuditLog {
    /** Record an event. Should never throw to the caller; log internally on failure. */
    record(event: AuditEvent): Promise<void>;
}
