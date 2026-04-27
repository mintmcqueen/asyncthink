/**
 * JsonlAuditLog — append-only audit log of every adapter invocation and
 * thread-lifecycle event.
 *
 * v1: writes to ~/.local/share/asyncthink/audit.jsonl with O_APPEND atomic
 * per-line writes. v3 swap point: Cloud Logging.
 *
 * Failure isolation: record() never throws. Audit-log failures must not
 * break a tool call. Internal write errors are logged to stderr and the
 * caller proceeds.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
export class JsonlAuditLog {
    path;
    constructor(opts = {}) {
        this.path = opts.path ?? defaultPath();
        try {
            mkdirSync(dirname(this.path), { recursive: true });
        }
        catch {
            // Directory may already exist or path may be unwritable; record()
            // will surface that.
        }
    }
    async record(event) {
        const line = {
            ts: new Date().toISOString(),
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
}
function defaultPath() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg ?? join(home, '.local', 'share');
    return join(base, 'asyncthink', 'audit.jsonl');
}
