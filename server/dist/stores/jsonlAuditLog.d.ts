/**
 * JsonlAuditLog — append-only audit log of every adapter invocation and
 * thread-lifecycle event.
 *
 * v1: writes to ~/.local/share/asyncthink/audit.jsonl with O_APPEND atomic
 * per-line writes. v3 swap point: Cloud Logging.
 *
 * Failure isolation: record() never throws. Audit-log failures must not
 * break a tool call. Internal write errors are logged to stderr and the
 * caller proceeds.
 */
import type { AuditEvent, AuditLog } from '../core/auditLog.js';
export interface JsonlAuditLogOptions {
    /** File path; defaults to ~/.local/share/asyncthink/audit.jsonl */
    path?: string;
}
export declare class JsonlAuditLog implements AuditLog {
    private readonly path;
    constructor(opts?: JsonlAuditLogOptions);
    record(event: AuditEvent): Promise<void>;
}
