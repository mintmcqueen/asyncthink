/**
 * TaskStore — in-flight async worker state.
 *
 * Replaces v1 ledger.json's role: tracks ephemeral worker handles
 * (PID, taskDir, status, timing) for the duration of a council fork.
 * Distinct from ThreadStore, which durably persists conversation transcripts.
 *
 * v1: filesystem-backed at ~/.local/share/asyncthink/tasks/.
 * v3: Firestore.
 */
export {};
