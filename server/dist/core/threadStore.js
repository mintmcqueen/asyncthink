/**
 * ThreadStore — durable conversation transcripts.
 *
 * Each thread is an append-only sequence of turns. Used by both
 * the asyncthink chain auto-thread and the delegate-tool threads.
 *
 * v1: JSONL files under ~/.local/share/asyncthink/threads/<threadId>.jsonl.
 * v3: Firestore.
 */
export {};
