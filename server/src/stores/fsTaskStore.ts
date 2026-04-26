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

import { promises as fsp, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { TaskState, TaskStatus, TaskStore } from '../core/taskStore.js';

export interface FsTaskStoreOptions {
  /** Directory; defaults to ~/.local/share/asyncthink/tasks/. */
  rootDir?: string;
}

export class FsTaskStore implements TaskStore {
  private readonly rootDir: string;
  private readonly mem = new Map<string, TaskState>();

  constructor(opts: FsTaskStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultRootDir();
    mkdirSync(this.rootDir, { recursive: true });
  }

  async create(id: string, topic: string): Promise<string> {
    if (this.mem.has(id)) {
      throw new Error(`Task "${id}" already exists`);
    }
    const taskDir = join(this.rootDir, sanitizeId(id));
    mkdirSync(taskDir, { recursive: true });
    const state: TaskState = {
      id,
      topic,
      status: 'pending',
      taskDir,
      startTime: new Date().toISOString(),
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
      (patch.status === 'complete' || patch.status === 'failed') &&
      !next.completeTime
    ) {
      next.completeTime = new Date().toISOString();
    }
    this.mem.set(id, next);
    this.persist(next);
  }

  async get(id: string): Promise<TaskState | undefined> {
    return this.mem.get(id);
  }

  async byStatus(status: TaskStatus): Promise<TaskState[]> {
    return [...this.mem.values()].filter((t) => t.status === status);
  }

  async delete(id: string): Promise<void> {
    this.mem.delete(id);
    const path = this.path(id);
    try {
      await fsp.unlink(path);
    } catch {
      /* ignore */
    }
  }

  /**
   * In v2 there are no detached PIDs to reap. cleanupStale exists to honor
   * the interface; it returns ids of any tasks stuck in 'pending' or
   * 'running' from a prior process invocation (caller can re-load and call
   * this on startup if desired). Here we just no-op since the in-memory map
   * is empty on a fresh constructor.
   */
  async cleanupStale(): Promise<string[]> {
    return [];
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
