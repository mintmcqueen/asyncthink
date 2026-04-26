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
import type {
  ThreadStore,
  ThreadSummary,
  ThreadTurn,
} from '../core/threadStore.js';

interface MetaLine {
  kind: 'meta';
  threadId: string;
  adapter: string;
  openedAt: string;
}

interface TurnLine extends ThreadTurn {
  kind: 'turn';
}

type Line = MetaLine | TurnLine;

export interface JsonlThreadStoreOptions {
  /** Directory to use; defaults to ~/.local/share/asyncthink/threads/ */
  rootDir?: string;
}

export class JsonlThreadStore implements ThreadStore {
  private readonly rootDir: string;
  private readonly closedDir: string;

  constructor(opts: JsonlThreadStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultRootDir();
    this.closedDir = join(this.rootDir, 'closed');
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.closedDir, { recursive: true });
  }

  async open(threadId: string, adapter: string): Promise<void> {
    validateId(threadId);
    const path = this.openPath(threadId);
    if (existsSync(path)) return; // idempotent
    const meta: MetaLine = {
      kind: 'meta',
      threadId,
      adapter,
      openedAt: new Date().toISOString(),
    };
    appendFileSync(path, JSON.stringify(meta) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  async append(threadId: string, turn: ThreadTurn): Promise<void> {
    validateId(threadId);
    const path = this.openPath(threadId);
    if (!existsSync(path)) {
      throw new Error(`Thread "${threadId}" is not open`);
    }
    const line: TurnLine = { kind: 'turn', ...turn };
    appendFileSync(path, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  async read(threadId: string): Promise<ThreadTurn[]> {
    validateId(threadId);
    const path = this.findPath(threadId);
    if (!path) return [];
    const raw = await fsp.readFile(path, 'utf8');
    const out: ThreadTurn[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as Line;
        if ((parsed as TurnLine).kind === 'turn') {
          // Strip the kind discriminator before returning.
          const { kind: _kind, ...turn } = parsed as TurnLine;
          out.push(turn);
        }
      } catch {
        // Tolerate corrupted/truncated lines; skip.
      }
    }
    return out;
  }

  async list(): Promise<ThreadSummary[]> {
    const out: ThreadSummary[] = [];
    const now = Date.now();
    for (const name of safeReaddir(this.rootDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(this.rootDir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
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

  async close(threadId: string): Promise<void> {
    validateId(threadId);
    const path = this.openPath(threadId);
    if (!existsSync(path)) return; // idempotent
    const dest = join(this.closedDir, `${threadId}.jsonl`);
    renameSync(path, dest);
  }

  async closeAll(): Promise<string[]> {
    const summaries = await this.list();
    const ids: string[] = [];
    for (const s of summaries) {
      await this.close(s.threadId);
      ids.push(s.threadId);
    }
    return ids;
  }

  async sweepIdle(maxIdleMs: number): Promise<string[]> {
    const summaries = await this.list();
    const ids: string[] = [];
    for (const s of summaries) {
      if (s.idleMs >= maxIdleMs) {
        await this.close(s.threadId);
        ids.push(s.threadId);
      }
    }
    return ids;
  }

  private openPath(threadId: string): string {
    return join(this.rootDir, `${threadId}.jsonl`);
  }

  private findPath(threadId: string): string | undefined {
    const open = this.openPath(threadId);
    if (existsSync(open)) return open;
    const closed = join(this.closedDir, `${threadId}.jsonl`);
    if (existsSync(closed)) return closed;
    return undefined;
  }

  private async readMeta(path: string): Promise<MetaLine | undefined> {
    try {
      const raw = await fsp.readFile(path, 'utf8');
      const firstLine = raw.split('\n', 1)[0];
      if (!firstLine) return undefined;
      const parsed = JSON.parse(firstLine) as Line;
      if ((parsed as MetaLine).kind === 'meta') return parsed as MetaLine;
    } catch {
      /* swallow */
    }
    return undefined;
  }
}

function validateId(id: string): void {
  if (!id || /[\/\\]/.test(id) || id === '.' || id === '..') {
    throw new Error(`Invalid thread id "${id}"`);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultRootDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ?? join(home, '.local', 'share');
  return join(base, 'asyncthink', 'threads');
}
