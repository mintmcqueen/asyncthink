/**
 * JsonlAuditLog — append-only audit log of every adapter invocation, thread-
 * lifecycle event, task-lifecycle event, and model-substitution event.
 *
 * v2.2: 90-day rolling window with daily rotation (R1-D.1). On startup and
 * once per 24h we check the active log file's first-entry timestamp; if the
 * oldest entry is more than one day old we rotate to
 * `audit.jsonl.YYYY-MM-DD` and start fresh. Archives older than 90 days are
 * pruned.
 *
 * v1: writes to ~/.local/share/asyncthink/audit.jsonl with O_APPEND atomic
 * per-line writes. v3 swap point: Cloud Logging.
 *
 * Failure isolation: record() never throws. Audit-log failures must not
 * break a tool call. Internal write errors are logged to stderr and the
 * caller proceeds.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, } from 'fs';
import { join, dirname, basename } from 'path';
const ROTATION_SPAN_MS = 24 * 60 * 60_000; // rotate when oldest entry > 24h old
const RETENTION_MS = 90 * 24 * 60 * 60_000; // 90 days
const ROTATION_CHECK_INTERVAL_MS = 24 * 60 * 60_000; // check once per 24h
export class JsonlAuditLog {
    path;
    now;
    retentionMs;
    rotationSpanMs;
    lastRotationCheck = 0;
    constructor(opts = {}) {
        this.path = opts.path ?? defaultPath();
        this.now = opts.now ?? (() => new Date());
        this.retentionMs = opts.retentionMs ?? RETENTION_MS;
        this.rotationSpanMs = opts.rotationSpanMs ?? ROTATION_SPAN_MS;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
        }
        catch {
            // Directory may already exist or path may be unwritable; record()
            // will surface that.
        }
        if (opts.rotateOnStart ?? true) {
            this.maybeRotate();
        }
    }
    async record(event) {
        this.maybeRotate();
        const line = {
            ts: this.now().toISOString(),
            pid: process.pid,
            event,
        };
        try {
            appendFileSync(this.path, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
        }
        catch (err) {
            console.error(`[AuditLog] write failed: ${err.message}`);
        }
    }
    /**
     * Rotate if the oldest entry in the active log is older than rotationSpanMs.
     * Prune archives older than retentionMs. Public for tests / CLI.
     */
    maybeRotate() {
        const nowMs = this.now().getTime();
        if (nowMs - this.lastRotationCheck < ROTATION_CHECK_INTERVAL_MS)
            return;
        this.lastRotationCheck = nowMs;
        try {
            this.rotateIfStale(nowMs);
        }
        catch (err) {
            console.error(`[AuditLog] rotation failed: ${err.message}`);
        }
        try {
            this.pruneArchives(nowMs);
        }
        catch (err) {
            console.error(`[AuditLog] prune failed: ${err.message}`);
        }
    }
    rotateIfStale(nowMs) {
        if (!existsSync(this.path))
            return;
        const oldestTs = readOldestTimestamp(this.path);
        if (oldestTs === null)
            return; // empty/corrupted; leave alone
        if (nowMs - oldestTs.getTime() < this.rotationSpanMs)
            return;
        const stamp = oldestTs.toISOString().slice(0, 10); // YYYY-MM-DD
        const archive = `${this.path}.${stamp}`;
        let target = archive;
        let n = 1;
        while (existsSync(target)) {
            target = `${archive}.${n++}`;
        }
        renameSync(this.path, target);
    }
    pruneArchives(nowMs) {
        const dir = dirname(this.path);
        const baseName = basename(this.path);
        if (!existsSync(dir))
            return;
        for (const entry of readdirSync(dir)) {
            if (!entry.startsWith(`${baseName}.`))
                continue;
            const m = /\.(\d{4}-\d{2}-\d{2})/.exec(entry);
            if (!m)
                continue;
            const archiveDate = new Date(m[1]);
            if (Number.isNaN(archiveDate.getTime()))
                continue;
            if (nowMs - archiveDate.getTime() <= this.retentionMs)
                continue;
            try {
                unlinkSync(join(dir, entry));
            }
            catch {
                /* ignore */
            }
        }
    }
}
function readOldestTimestamp(path) {
    try {
        // Read first non-empty line; that's the oldest entry (append-only).
        const raw = readFileSync(path, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.ts && typeof parsed.ts === 'string') {
                    const d = new Date(parsed.ts);
                    if (!Number.isNaN(d.getTime()))
                        return d;
                }
            }
            catch {
                continue;
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
function defaultPath() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg ?? join(home, '.local', 'share');
    return join(base, 'asyncthink', 'audit.jsonl');
}
