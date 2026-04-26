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

export type TaskStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface TaskState {
  /** Session-scoped id: SESSION_ID::userProvidedId. */
  id: string;
  topic: string;
  status: TaskStatus;
  /** Working directory for this worker's stdout/stderr files. */
  taskDir: string;
  pid?: number;
  startTime?: string;
  completeTime?: string;
  result?: string;
  error?: string;
  /** Thought number that spawned this fork (asyncthink only). */
  forkThought?: number;
  /** Adapter id this fork dispatched to. */
  adapter?: string;
  /** Wall-clock duration of the underlying adapter invocation. */
  durationMs?: number;
}

export interface TaskStore {
  /** Allocate a task and return its working directory. */
  create(id: string, topic: string): Promise<string>;
  /** Patch fields on an existing task. */
  update(id: string, patch: Partial<TaskState>): Promise<void>;
  /** Read current state, or undefined if not present. */
  get(id: string): Promise<TaskState | undefined>;
  /** Filter by status (e.g. all 'running'). */
  byStatus(status: TaskStatus): Promise<TaskState[]>;
  /** Remove a task; safe to call on absent ids. */
  delete(id: string): Promise<void>;
  /** Mark orphaned tasks (PIDs that no longer exist) as 'failed'. Returns ids cleaned. */
  cleanupStale(): Promise<string[]>;
}
