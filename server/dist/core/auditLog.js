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
export {};
