/**
 * AsyncThink Ledger
 *
 * Robust, fault-proof research task state tracking
 *
 * Features:
 * - In-memory primary (fast)
 * - File backup (XDG compliant)
 * - Write-through on state changes
 * - Recovery on server restart
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { getConfigManager } from './config.js';

// =============================================================================
// Types
// =============================================================================

export type TaskStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface TaskState {
  id: string;
  topic: string;
  status: TaskStatus;
  taskDir: string;
  pid?: number;
  startTime?: string;
  completeTime?: string;
  result?: string;
  error?: string;
  forkThought?: number;
}

export interface LedgerState {
  tasks: Record<string, TaskState>;
  lastUpdated: string;
}

// =============================================================================
// Ledger Class
// =============================================================================

export class Ledger {
  private state: LedgerState;
  private ledgerPath: string;
  private loaded = false;
  private lastFileModTime = 0;

  constructor() {
    this.state = {
      tasks: {},
      lastUpdated: new Date().toISOString(),
    };
    const config = getConfigManager();
    this.ledgerPath = join(config.getDataDir(), 'ledger.json');
  }

  /**
   * Load ledger from disk (only if not loaded or file changed)
   */
  load(): void {
    // Check if file was modified externally
    if (this.loaded && existsSync(this.ledgerPath)) {
      try {
        const stat = statSync(this.ledgerPath);
        const modTime = stat.mtimeMs;

        // If file hasn't changed, use cached state
        if (modTime <= this.lastFileModTime) {
          return;
        }

        // File was modified externally - need to reload
        console.error('[Ledger] Detected external modification, reloading...');
        this.loaded = false;
      } catch {
        // Stat failed, continue with normal load check
      }
    }

    if (this.loaded) return;

    try {
      if (existsSync(this.ledgerPath)) {
        const stat = statSync(this.ledgerPath);
        this.lastFileModTime = stat.mtimeMs;

        const data = readFileSync(this.ledgerPath, 'utf-8');
        this.state = JSON.parse(data);
        console.error(`[Ledger] Loaded ${Object.keys(this.state.tasks).length} tasks`);
      }
    } catch (error: any) {
      console.error(`[Ledger] Error loading: ${error.message}`);
      this.state = { tasks: {}, lastUpdated: new Date().toISOString() };
    }

    this.loaded = true;
  }

  /**
   * Force reload from disk (ignores cached state)
   */
  forceReload(): void {
    this.loaded = false;
    this.load();
  }

  /**
   * Save ledger to disk
   */
  private save(): void {
    try {
      const config = getConfigManager();
      config.ensureDirectories();

      this.state.lastUpdated = new Date().toISOString();
      writeFileSync(this.ledgerPath, JSON.stringify(this.state, null, 2), 'utf-8');

      // Update our tracked mod time so we don't reload our own write
      const stat = statSync(this.ledgerPath);
      this.lastFileModTime = stat.mtimeMs;
    } catch (error: any) {
      console.error(`[Ledger] Error saving: ${error.message}`);
    }
  }

  /**
   * Clean up stale "running" tasks where the process is no longer running.
   * This handles tasks from previous sessions that weren't properly completed.
   */
  cleanupStaleTasks(): number {
    this.load();

    let cleaned = 0;

    for (const task of Object.values(this.state.tasks)) {
      if (task.status !== 'running') continue;
      if (!task.pid) continue;

      // Check if process is still running
      let isRunning = false;
      try {
        process.kill(task.pid, 0);
        isRunning = true;
      } catch {
        isRunning = false;
      }

      if (!isRunning) {
        console.error(`[Ledger] Found stale task: ${task.id} (pid ${task.pid} not running)`);

        // Check if there's output in the task directory
        const stdoutPath = join(task.taskDir, 'stdout');
        let hasOutput = false;
        let output = '';

        try {
          if (existsSync(stdoutPath)) {
            output = readFileSync(stdoutPath, 'utf-8').trim();
            hasOutput = output.length > 0;
          }
        } catch {}

        if (hasOutput) {
          // Worker completed but status wasn't updated - mark as complete
          this.state.tasks[task.id] = {
            ...task,
            status: 'complete',
            result: output,
            completeTime: new Date().toISOString(),
          };
          console.error(`[Ledger] Recovered completed task: ${task.id}`);
        } else {
          // Worker failed without output - mark as failed
          this.state.tasks[task.id] = {
            ...task,
            status: 'failed',
            error: 'Process terminated without output (possibly from previous session)',
            completeTime: new Date().toISOString(),
          };
          console.error(`[Ledger] Marked failed task: ${task.id}`);
        }

        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.save();
      console.error(`[Ledger] Cleaned up ${cleaned} stale tasks`);
    }

    return cleaned;
  }

  /**
   * Create a new task and its directory
   */
  createTask(id: string, topic: string, forkThought?: number): string {
    this.load();

    const config = getConfigManager();
    const taskDir = join(config.getTasksDir(), id);

    // Create task directory
    if (!existsSync(taskDir)) {
      mkdirSync(taskDir, { recursive: true });
    }

    // Create task state
    const task: TaskState = {
      id,
      topic,
      status: 'pending',
      taskDir,
      forkThought,
    };

    this.state.tasks[id] = task;
    this.save();

    console.error(`[Ledger] Created task: ${id}`);
    return taskDir;
  }

  /**
   * Update a task's state
   */
  updateTask(id: string, updates: Partial<TaskState>): void {
    this.load();

    if (!this.state.tasks[id]) {
      console.error(`[Ledger] Task not found: ${id}`);
      return;
    }

    this.state.tasks[id] = {
      ...this.state.tasks[id],
      ...updates,
    };

    this.save();
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): TaskState | null {
    this.load();
    return this.state.tasks[id] || null;
  }

  /**
   * Get all tasks with a specific status
   */
  getTasksByStatus(status: TaskStatus): TaskState[] {
    this.load();
    return Object.values(this.state.tasks).filter((t) => t.status === status);
  }

  /**
   * Get all task IDs with pending status
   */
  getPendingIds(): string[] {
    return this.getTasksByStatus('pending').map((t) => t.id);
  }

  /**
   * Get all task IDs with running status
   */
  getRunningIds(): string[] {
    return this.getTasksByStatus('running').map((t) => t.id);
  }

  /**
   * Get all task IDs with complete status
   */
  getCompletedIds(): string[] {
    return this.getTasksByStatus('complete').map((t) => t.id);
  }

  /**
   * Get all task IDs with failed status
   */
  getFailedIds(): string[] {
    return this.getTasksByStatus('failed').map((t) => t.id);
  }

  /**
   * Get IDs of tasks that are still in progress (pending or running)
   */
  getInProgressIds(): string[] {
    this.load();
    return Object.values(this.state.tasks)
      .filter((t) => t.status === 'pending' || t.status === 'running')
      .map((t) => t.id);
  }

  /**
   * Get IDs of tasks that are done (complete or failed)
   */
  getDoneIds(): string[] {
    this.load();
    return Object.values(this.state.tasks)
      .filter((t) => t.status === 'complete' || t.status === 'failed')
      .map((t) => t.id);
  }

  /**
   * Check if a task exists
   */
  hasTask(id: string): boolean {
    this.load();
    return id in this.state.tasks;
  }

  /**
   * Delete a task and its directory
   */
  deleteTask(id: string): void {
    this.load();

    const task = this.state.tasks[id];
    if (!task) return;

    // Remove task directory
    if (existsSync(task.taskDir)) {
      try {
        rmSync(task.taskDir, { recursive: true });
      } catch (error: any) {
        console.error(`[Ledger] Error removing task dir: ${error.message}`);
      }
    }

    // Remove from state
    delete this.state.tasks[id];
    this.save();

    console.error(`[Ledger] Deleted task: ${id}`);
  }

  /**
   * Clean up old completed/failed tasks
   */
  cleanup(maxAgeMs: number = 3600000): number {
    this.load();

    const now = Date.now();
    let cleaned = 0;

    for (const task of Object.values(this.state.tasks)) {
      if (task.status !== 'complete' && task.status !== 'failed') continue;
      if (!task.completeTime) continue;

      const age = now - new Date(task.completeTime).getTime();
      if (age > maxAgeMs) {
        this.deleteTask(task.id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.error(`[Ledger] Cleaned up ${cleaned} old tasks`);
    }

    return cleaned;
  }

  /**
   * Get research status summary for tool output
   */
  getResearchStatus(): {
    pending: string[];
    completed: string[];
  } {
    this.load();

    const pending: string[] = [];
    const completed: string[] = [];

    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'pending' || task.status === 'running') {
        pending.push(task.id);
      } else if (task.status === 'complete') {
        completed.push(task.id);
      }
      // Failed tasks are not included - they should be read to see the error
    }

    return { pending, completed };
  }

  /**
   * Generate a reminder message about research status
   */
  generateReminder(): string | undefined {
    const status = this.getResearchStatus();

    const parts: string[] = [];

    if (status.completed.length > 0) {
      parts.push(
        `Research completed: ${status.completed.join(', ')}. Use readResearch to see results.`
      );
    }

    if (status.pending.length > 0) {
      parts.push(`Research pending: ${status.pending.join(', ')}`);
    }

    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  /**
   * Get parsed result for a completed task
   */
  getResult(id: string): {
    id: string;
    topic: string;
    workers?: Array<{
      type: string;
      query: string;
      result: string;
    }>;
    synthesis?: string;
    error?: string;
  } | null {
    this.load();

    const task = this.state.tasks[id];
    if (!task) return null;

    const baseResult = {
      id: task.id,
      topic: task.topic,
    };

    if (task.status === 'failed') {
      return {
        ...baseResult,
        error: task.error || 'Unknown error',
      };
    }

    if (task.status !== 'complete' || !task.result) {
      return null;
    }

    try {
      const parsed = JSON.parse(task.result);
      return {
        ...baseResult,
        workers: parsed.subQueries,
        synthesis: parsed.synthesis,
        error: parsed.error,
      };
    } catch {
      return {
        ...baseResult,
        error: 'Failed to parse result',
      };
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let ledgerInstance: Ledger | null = null;

/**
 * Get the singleton Ledger instance
 */
export function getLedger(): Ledger {
  if (!ledgerInstance) {
    ledgerInstance = new Ledger();
  }
  return ledgerInstance;
}

/**
 * Reset the ledger (for testing)
 */
export function resetLedger(): void {
  ledgerInstance = null;
}
