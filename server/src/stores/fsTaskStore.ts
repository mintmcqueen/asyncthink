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
 *
 * v2.2 additions:
 *   - `findByIdempotencyKey(key, principal)`: scans non-terminal tasks for
 *     dedup match (R-DUR-D.3).
 *   - `cleanupStale()` reaps tasks whose `lastUpdatedAt` exceeds the
 *     category TTL (R-DUR-D.4): WORKING 60m, COMPLETED 60m, FAILED 10m,
 *     CANCELLED 5m. Returns reaped ids.
 *   - `list()` enumerates every task.
 *   - Atomic disk-mirror updates via write-temp + rename.
 */

import {
  promises as fsp,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import {
  isTerminal,
  type TaskState,
  type TaskStatus,
  type TaskStore,
} from '../core/taskStore.js';

export interface FsTaskStoreOptions {
  /** Directory; defaults to ~/.local/share/asyncthink/tasks/. */
  rootDir?: string;
  /** Override clock for tests. */
  now?: () => Date;
}

/** Category-wise sweep TTLs (R-DUR-D.4). All ms. */
export const SWEEP_TTL_MS: Record<string, number> = {
  // Non-terminal
  pending: 60 * 60_000,
  running: 60 * 60_000,
  working: 60 * 60_000,
  input_required: 60 * 60_000,
  // Terminal
  completed: 60 * 60_000,
  complete: 60 * 60_000,
  failed: 10 * 60_000,
  cancelled: 5 * 60_000,
};

/**
 * v2.3 (R5-D.4): hard ceiling on the "skip while subprocess is cancelling"
 * protection. Past this age, the sweeper force-deletes the cancelled task
 * even if its subprocess hasn't confirmed exit (and the executor will emit
 * `task.terminated` with `signal: 'orphaned'`).
 */
export const CANCELLING_HARD_CEILING_MS = 30 * 60_000;

export class FsTaskStore implements TaskStore {
  private readonly rootDir: string;
  private readonly mem = new Map<string, TaskState>();
  private readonly now: () => Date;

  constructor(opts: FsTaskStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultRootDir();
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.rootDir, { recursive: true });
  }

  async create(id: string, topic: string): Promise<string> {
    if (this.mem.has(id)) {
      throw new Error(`Task "${id}" already exists`);
    }
    const taskDir = join(this.rootDir, sanitizeId(id));
    mkdirSync(taskDir, { recursive: true });
    const startTime = this.now().toISOString();
    const state: TaskState = {
      id,
      topic,
      status: 'pending',
      taskDir,
      startTime,
      lastUpdatedAt: startTime,
    };
    this.mem.set(id, state);
    this.persist(state);
    return taskDir;
  }

  async update(id: string, patch: Partial<TaskState>): Promise<void> {
    const cur = this.mem.get(id);
    if (!cur) throw new Error(`Task "${id}" not found`);
    const next: TaskState = { ...cur, ...patch, id: cur.id };
    if (
      patch.status &&
      isTerminal(patch.status) &&
      !next.completeTime
    ) {
      next.completeTime = this.now().toISOString();
    }
    next.lastUpdatedAt = this.now().toISOString();
    this.mem.set(id, next);
    this.persist(next);
  }

  async get(id: string): Promise<TaskState | undefined> {
    return this.mem.get(id);
  }

  async byStatus(status: TaskStatus): Promise<TaskState[]> {
    return [...this.mem.values()].filter((t) => t.status === status);
  }

  async list(): Promise<TaskState[]> {
    return [...this.mem.values()];
  }

  async delete(id: string): Promise<void> {
    this.mem.delete(id);
    const dir = join(this.rootDir, sanitizeId(id));
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  async findByIdempotencyKey(
    key: string,
    principal: string | null
  ): Promise<TaskState | undefined> {
    for (const t of this.mem.values()) {
      if (t.idempotencyKey !== key) continue;
      if ((t.principal ?? null) !== principal) continue;
      if (isTerminal(t.status)) continue;
      return t;
    }
    return undefined;
  }

  /**
   * Reap tasks whose `lastUpdatedAt` (or `startTime` fallback) exceeds the
   * per-category TTL. Removes from memory and disk. Returns reaped ids.
   *
   * v2.3 (R5-D.3): `opts.skip` protects in-flight-cancelling tasks from
   * deletion while their subprocess hasn't confirmed exit. Skipped tasks are
   * still subject to the hard ceiling (R5-D.4) — past 30 minutes in the
   * skip set, the sweeper force-deletes anyway.
   */
  async cleanupStale(opts: { skip?: Set<string> } = {}): Promise<string[]> {
    const now = this.now().getTime();
    const skip = opts.skip;
    const reaped: string[] = [];
    for (const t of [...this.mem.values()]) {
      const ttl = SWEEP_TTL_MS[t.status] ?? SWEEP_TTL_MS.completed;
      const ts = t.lastUpdatedAt ?? t.startTime;
      if (!ts) continue;
      const age = now - new Date(ts).getTime();
      if (age < ttl) continue;
      if (skip?.has(t.id)) {
        // Honor the skip UNLESS we've hit the hard ceiling.
        if (age < CANCELLING_HARD_CEILING_MS) continue;
        // Past the ceiling: force-delete. Caller (executor) will see the id in
        // the return list and emit `task.terminated` with signal: 'orphaned'.
      }
      await this.delete(t.id);
      reaped.push(t.id);
    }
    return reaped;
  }

  /**
   * Optional helper for tests / debugging: reload all tasks from disk into
   * memory. Used to recover state when reattaching to an existing dir.
   */
  reloadFromDisk(): void {
    if (!existsSync(this.rootDir)) return;
    for (const entry of readdirSync(this.rootDir)) {
      const path = join(this.rootDir, entry, 'state.json');
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path, 'utf8');
        const state = JSON.parse(raw) as TaskState;
        this.mem.set(state.id, state);
      } catch {
        /* corrupted; skip */
      }
    }
  }

  private path(id: string): string {
    return join(this.rootDir, sanitizeId(id), 'state.json');
  }

  private persist(state: TaskState): void {
    try {
      writeFileSync(this.path(state.id), JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {
      // Persistence failures must not break a fork; mem is the source of truth.
    }
  }
}

function sanitizeId(id: string): string {
  // Allow only path-safe chars; replace others with _.
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function defaultRootDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ?? join(home, '.local', 'share');
  return join(base, 'asyncthink', 'tasks');
}
