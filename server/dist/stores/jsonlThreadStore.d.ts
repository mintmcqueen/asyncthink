/**
 * JsonlThreadStore — append-only JSONL transcripts per thread.
 *
 * Layout:
 *   ~/.local/share/asyncthink/threads/<threadId>.jsonl          (open)
 *   ~/.local/share/asyncthink/threads/closed/<threadId>.jsonl   (closed)
 *
 * Each line is a single JSON object: either a {kind:"meta",...} header
 * written once on open, or a {kind:"turn", ...ThreadTurn} body line.
 *
 * Atomicity: Node's fs.appendFileSync uses O_APPEND so per-line writes are
 * atomic at the OS level for sizes under PIPE_BUF (~4 KiB on macOS/Linux);
 * larger turns may interleave under concurrent multi-process writes (not a
 * concern for the v1 single-process server). Within one process, async
 * appends serialize at the syscall layer.
 *
 * Corruption tolerance: read() skips any line that fails JSON.parse rather
 * than failing the whole transcript. A truncated final line is reported as a
 * skipped line; prior turns remain readable.
 */
import type { ThreadStore, ThreadSummary, ThreadTurn } from '../core/threadStore.js';
export interface JsonlThreadStoreOptions {
    /** Directory to use; defaults to ~/.local/share/asyncthink/threads/ */
    rootDir?: string;
}
export declare class JsonlThreadStore implements ThreadStore {
    private readonly rootDir;
    private readonly closedDir;
    constructor(opts?: JsonlThreadStoreOptions);
    open(threadId: string, adapter: string): Promise<void>;
    append(threadId: string, turn: ThreadTurn): Promise<void>;
    read(threadId: string): Promise<ThreadTurn[]>;
    list(): Promise<ThreadSummary[]>;
    close(threadId: string): Promise<void>;
    closeAll(): Promise<string[]>;
    sweepIdle(maxIdleMs: number): Promise<string[]>;
    private openPath;
    private findPath;
    private readMeta;
}
