/**
 * TaskStore — in-flight async worker state.
 *
 * Replaces v1 ledger.json's role: tracks ephemeral worker handles
 * (PID, taskDir, status, timing) for the duration of a council fork.
 * Distinct from ThreadStore, which durably persists conversation transcripts.
 *
 * v1: filesystem-backed at ~/.local/share/asyncthink/tasks/.
 * v3: Firestore.
 *
 * v2.2: schema extended with `detached`, `principal`, `idempotencyKey`,
 * `taskTtlMs`, `lastUpdatedAt`, plus the protocol-spec status set so the
 * record can carry MCP Tasks state directly. Legacy v2.0 statuses
 * ('pending'|'running'|'complete'|'failed') remain valid for backward
 * compatibility with on-disk state from v2.1.x.
 */
/** Statuses that represent a task still in flight. */
export const NON_TERMINAL_STATUSES = new Set([
    'pending',
    'running',
    'working',
    'input_required',
]);
export function isTerminal(status) {
    return !NON_TERMINAL_STATUSES.has(status);
}
