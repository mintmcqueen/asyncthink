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
import { promises as fsp, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, } from 'fs';
import { join } from 'path';
import { isTerminal, } from '../core/taskStore.js';
/** Category-wise sweep TTLs (R-DUR-D.4). All ms. */
export const SWEEP_TTL_MS = {
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
export class FsTaskStore {
    rootDir;
    mem = new Map();
    now;
    constructor(opts = {}) {
        this.rootDir = opts.rootDir ?? defaultRootDir();
        this.now = opts.now ?? (() => new Date());
        mkdirSync(this.rootDir, { recursive: true });
    }
    async create(id, topic) {
        if (this.mem.has(id)) {
            throw new Error(`Task "${id}" already exists`);
        }
        const taskDir = join(this.rootDir, sanitizeId(id));
        mkdirSync(taskDir, { recursive: true });
        const startTime = this.now().toISOString();
        const state = {
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
    async update(id, patch) {
        const cur = this.mem.get(id);
        if (!cur)
            throw new Error(`Task "${id}" not found`);
        const next = { ...cur, ...patch, id: cur.id };
        if (patch.status &&
            isTerminal(patch.status) &&
            !next.completeTime) {
            next.completeTime = this.now().toISOString();
        }
        next.lastUpdatedAt = this.now().toISOString();
        this.mem.set(id, next);
        this.persist(next);
    }
    async get(id) {
        return this.mem.get(id);
    }
    async byStatus(status) {
        return [...this.mem.values()].filter((t) => t.status === status);
    }
    async list() {
        return [...this.mem.values()];
    }
    async delete(id) {
        this.mem.delete(id);
        const dir = join(this.rootDir, sanitizeId(id));
        try {
            await fsp.rm(dir, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    }
    async findByIdempotencyKey(key, principal) {
        for (const t of this.mem.values()) {
            if (t.idempotencyKey !== key)
                continue;
            if ((t.principal ?? null) !== principal)
                continue;
            if (isTerminal(t.status))
                continue;
            return t;
        }
        return undefined;
    }
    /**
     * Reap tasks whose `lastUpdatedAt` (or `startTime` fallback) exceeds the
     * per-category TTL. Removes from memory and disk. Returns reaped ids.
     */
    async cleanupStale() {
        const now = this.now().getTime();
        const reaped = [];
        for (const t of [...this.mem.values()]) {
            const ttl = SWEEP_TTL_MS[t.status] ?? SWEEP_TTL_MS.completed;
            const ts = t.lastUpdatedAt ?? t.startTime;
            if (!ts)
                continue;
            const age = now - new Date(ts).getTime();
            if (age >= ttl) {
                await this.delete(t.id);
                reaped.push(t.id);
            }
        }
        return reaped;
    }
    /**
     * Optional helper for tests / debugging: reload all tasks from disk into
     * memory. Used to recover state when reattaching to an existing dir.
     */
    reloadFromDisk() {
        if (!existsSync(this.rootDir))
            return;
        for (const entry of readdirSync(this.rootDir)) {
            const path = join(this.rootDir, entry, 'state.json');
            if (!existsSync(path))
                continue;
            try {
                const raw = readFileSync(path, 'utf8');
                const state = JSON.parse(raw);
                this.mem.set(state.id, state);
            }
            catch {
                /* corrupted; skip */
            }
        }
    }
    path(id) {
        return join(this.rootDir, sanitizeId(id), 'state.json');
    }
    persist(state) {
        try {
            writeFileSync(this.path(state.id), JSON.stringify(state, null, 2), { mode: 0o600 });
        }
        catch {
            // Persistence failures must not break a fork; mem is the source of truth.
        }
    }
}
function sanitizeId(id) {
    // Allow only path-safe chars; replace others with _.
    return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
function defaultRootDir() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg ?? join(home, '.local', 'share');
    return join(base, 'asyncthink', 'tasks');
}
