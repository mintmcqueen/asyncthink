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
import { promises as fsp, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'fs';
import { join, basename } from 'path';
export class JsonlThreadStore {
    rootDir;
    closedDir;
    constructor(opts = {}) {
        this.rootDir = opts.rootDir ?? defaultRootDir();
        this.closedDir = join(this.rootDir, 'closed');
        mkdirSync(this.rootDir, { recursive: true });
        mkdirSync(this.closedDir, { recursive: true });
    }
    async open(threadId, adapter) {
        validateId(threadId);
        const path = this.openPath(threadId);
        if (existsSync(path))
            return; // idempotent
        const meta = {
            kind: 'meta',
            threadId,
            adapter,
            openedAt: new Date().toISOString(),
        };
        appendFileSync(path, JSON.stringify(meta) + '\n', { encoding: 'utf8', mode: 0o600 });
    }
    async append(threadId, turn) {
        validateId(threadId);
        const path = this.openPath(threadId);
        if (!existsSync(path)) {
            throw new Error(`Thread "${threadId}" is not open`);
        }
        const line = { kind: 'turn', ...turn };
        appendFileSync(path, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
    }
    async read(threadId) {
        validateId(threadId);
        const path = this.findPath(threadId);
        if (!path)
            return [];
        const raw = await fsp.readFile(path, 'utf8');
        const out = [];
        for (const line of raw.split('\n')) {
            const t = line.trim();
            if (!t)
                continue;
            try {
                const parsed = JSON.parse(t);
                if (parsed.kind === 'turn') {
                    // Strip the kind discriminator before returning.
                    const { kind: _kind, ...turn } = parsed;
                    out.push(turn);
                }
            }
            catch {
                // Tolerate corrupted/truncated lines; skip.
            }
        }
        return out;
    }
    async list() {
        const out = [];
        const now = Date.now();
        for (const name of safeReaddir(this.rootDir)) {
            if (!name.endsWith('.jsonl'))
                continue;
            const path = join(this.rootDir, name);
            let st;
            try {
                st = statSync(path);
            }
            catch {
                continue;
            }
            if (!st.isFile())
                continue;
            const threadId = basename(name, '.jsonl');
            const meta = await this.readMeta(path);
            out.push({
                threadId,
                lastTs: new Date(st.mtimeMs).toISOString(),
                adapter: meta?.adapter ?? 'unknown',
                idleMs: Math.max(0, now - st.mtimeMs),
            });
        }
        return out;
    }
    async close(threadId) {
        validateId(threadId);
        const path = this.openPath(threadId);
        if (!existsSync(path))
            return; // idempotent
        const dest = join(this.closedDir, `${threadId}.jsonl`);
        renameSync(path, dest);
    }
    async closeAll() {
        const summaries = await this.list();
        const ids = [];
        for (const s of summaries) {
            await this.close(s.threadId);
            ids.push(s.threadId);
        }
        return ids;
    }
    async sweepIdle(maxIdleMs) {
        const summaries = await this.list();
        const ids = [];
        for (const s of summaries) {
            if (s.idleMs >= maxIdleMs) {
                await this.close(s.threadId);
                ids.push(s.threadId);
            }
        }
        return ids;
    }
    openPath(threadId) {
        return join(this.rootDir, `${threadId}.jsonl`);
    }
    findPath(threadId) {
        const open = this.openPath(threadId);
        if (existsSync(open))
            return open;
        const closed = join(this.closedDir, `${threadId}.jsonl`);
        if (existsSync(closed))
            return closed;
        return undefined;
    }
    async readMeta(path) {
        try {
            const raw = await fsp.readFile(path, 'utf8');
            const firstLine = raw.split('\n', 1)[0];
            if (!firstLine)
                return undefined;
            const parsed = JSON.parse(firstLine);
            if (parsed.kind === 'meta')
                return parsed;
        }
        catch {
            /* swallow */
        }
        return undefined;
    }
}
function validateId(id) {
    if (!id || /[\/\\]/.test(id) || id === '.' || id === '..') {
        throw new Error(`Invalid thread id "${id}"`);
    }
}
function safeReaddir(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
function defaultRootDir() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg ?? join(home, '.local', 'share');
    return join(base, 'asyncthink', 'threads');
}
