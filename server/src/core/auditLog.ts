/**
 * AuditLog — record of every adapter invocation and thread lifecycle event.
 *
 * Built from day 1 even though v1 isn't SOC2-attested — capturing logs early
 * means real audit data is available when v3 pursues SOC2 Type 1.
 *
 * v1: append-only JSONL at ~/.local/share/asyncthink/audit.jsonl.
 * v3: Cloud Logging.
 */

export type AuditEvent =
  | {
      kind: 'invoke';
      adapter: string;
      durationMs: number;
      tokensIn?: number;
      tokensOut?: number;
      threadId?: string;
      error?: string;
    }
  | {
      kind: 'thread.open' | 'thread.close';
      threadId: string;
      adapter: string;
    };

export interface AuditLog {
  /** Record an event. Should never throw to the caller; log internally on failure. */
  record(event: AuditEvent): Promise<void>;
}
