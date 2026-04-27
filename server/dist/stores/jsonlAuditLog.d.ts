/**
 * JsonlAuditLog — append-only audit log of every adapter invocation, thread-
 * lifecycle event, task-lifecycle event, and model-substitution event.
 *
 * v2.2: 90-day rolling window with daily rotation (R1-D.1). On startup and
 * once per 24h we check the active log file's first-entry timestamp; if the
 * oldest entry is more than one day old we rotate to
 * `audit.jsonl.YYYY-MM-DD` and start fresh. Archives older than 90 days are
 * pruned.
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
    /** Override clock (tests). */
    now?: () => Date;
    /** Override retention window (tests). */
    retentionMs?: number;
    /** Override rotation span (tests). */
    rotationSpanMs?: number;
    /** Disable rotation entirely (legacy v1 behavior; tests). */
    rotateOnStart?: boolean;
}
export declare class JsonlAuditLog implements AuditLog {
    private readonly path;
    private readonly now;
    private readonly retentionMs;
    private readonly rotationSpanMs;
    private lastRotationCheck;
    constructor(opts?: JsonlAuditLogOptions);
    record(event: AuditEvent): Promise<void>;
    /**
     * Rotate if the oldest entry in the active log is older than rotationSpanMs.
     * Prune archives older than retentionMs. Public for tests / CLI.
     */
    maybeRotate(): void;
    private rotateIfStale;
    private pruneArchives;
}
