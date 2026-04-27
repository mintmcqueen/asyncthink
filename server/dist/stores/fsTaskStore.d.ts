/**
 * FsTaskStore — filesystem-backed in-flight worker state.
 *
 * Replaces v1 ledger.json. Tracks one record per fork: id, adapter, status,
 * result, error, timestamps. In-memory primary; mirrored to one JSON file
 * per task at ~/.local/share/asyncthink/tasks/<id>.json so a debug session
 * can see the state of recent forks.
 *
 * Unlike v1, v2 forks are in-process Promises (not detached subprocesses),
 * so there is no PID-based stale recovery — if the server dies mid-fork,
 * the in-flight invocation dies with it. The disk mirror is observability
 * only.
 */
import type { TaskState, TaskStatus, TaskStore } from '../core/taskStore.js';
export interface FsTaskStoreOptions {
    /** Directory; defaults to ~/.local/share/asyncthink/tasks/. */
    rootDir?: string;
}
export declare class FsTaskStore implements TaskStore {
    private readonly rootDir;
    private readonly mem;
    constructor(opts?: FsTaskStoreOptions);
    create(id: string, topic: string): Promise<string>;
    update(id: string, patch: Partial<TaskState>): Promise<void>;
    get(id: string): Promise<TaskState | undefined>;
    byStatus(status: TaskStatus): Promise<TaskState[]>;
    delete(id: string): Promise<void>;
    /**
     * In v2 there are no detached PIDs to reap. cleanupStale exists to honor
     * the interface; it returns ids of any tasks stuck in 'pending' or
     * 'running' from a prior process invocation (caller can re-load and call
     * this on startup if desired). Here we just no-op since the in-memory map
     * is empty on a fresh constructor.
     */
    cleanupStale(): Promise<string[]>;
    /**
     * Optional helper for tests / debugging: reload all tasks from disk into
     * memory. Used to recover state when reattaching to an existing dir.
     */
    reloadFromDisk(): void;
    private path;
    private persist;
}
