/**
 * ThreadStore — durable conversation transcripts.
 *
 * Each thread is an append-only sequence of turns. Used by both
 * the asyncthink chain auto-thread and the delegate-tool threads.
 *
 * v1: JSONL files under ~/.local/share/asyncthink/threads/<threadId>.jsonl.
 * v3: Firestore.
 */
export interface ThreadTurn {
    /** ISO 8601 timestamp. */
    ts: string;
    role: 'user' | 'assistant';
    /** Adapter id that produced this turn. */
    adapter: string;
    /** Adapter's continuation token at this turn (for native session resume). */
    sessionId?: string;
    /** Free-text content. */
    content: string;
    /** Audit metadata (token counts, durations, model used, etc). */
    meta?: Record<string, unknown>;
}
export interface ThreadSummary {
    threadId: string;
    lastTs: string;
    adapter: string;
    /** Milliseconds since last turn. */
    idleMs: number;
}
export interface ThreadStore {
    /** Open a new thread. Idempotent if already open. */
    open(threadId: string, adapter: string): Promise<void>;
    /** Append a turn. Concurrent-safe for parallel writes to different threads. */
    append(threadId: string, turn: ThreadTurn): Promise<void>;
    /** Read all turns in chronological order. */
    read(threadId: string): Promise<ThreadTurn[]>;
    /** List all open threads. */
    list(): Promise<ThreadSummary[]>;
    /** Close a single thread. Idempotent. */
    close(threadId: string): Promise<void>;
    /** Close all open threads. Returns the ids that were closed. */
    closeAll(): Promise<string[]>;
    /** Close all threads idle longer than maxIdleMs. Returns the ids that were closed. */
    sweepIdle(maxIdleMs: number): Promise<string[]>;
}
