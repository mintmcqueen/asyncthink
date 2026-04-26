import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, writeFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JsonlThreadStore } from '../../src/stores/jsonlThreadStore.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-threads-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('JsonlThreadStore', () => {
  it('round-trips a multi-turn conversation', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('t1', 'codex');
    await s.append('t1', {
      ts: '2026-01-01T00:00:00.000Z',
      role: 'user',
      adapter: 'codex',
      content: 'hello',
    });
    await s.append('t1', {
      ts: '2026-01-01T00:00:01.000Z',
      role: 'assistant',
      adapter: 'codex',
      sessionId: 's-1',
      content: 'world',
    });
    const turns = await s.read('t1');
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].sessionId).toBe('s-1');
  });

  it('open is idempotent', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('t1', 'codex');
    await s.append('t1', {
      ts: 'x',
      role: 'user',
      adapter: 'codex',
      content: 'first',
    });
    await s.open('t1', 'codex'); // should not clobber
    const turns = await s.read('t1');
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('first');
  });

  it('append on a non-open thread throws', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await expect(
      s.append('missing', {
        ts: 'x',
        role: 'user',
        adapter: 'codex',
        content: 'hi',
      })
    ).rejects.toThrow(/not open/);
  });

  it('list() reports only open threads with adapter and idleMs', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('a', 'gemini');
    await s.open('b', 'codex');
    const summaries = await s.list();
    expect(summaries.map((x) => x.threadId).sort()).toEqual(['a', 'b']);
    expect(summaries.find((x) => x.threadId === 'a')?.adapter).toBe('gemini');
    expect(summaries.find((x) => x.threadId === 'b')?.adapter).toBe('codex');
    for (const s of summaries) expect(s.idleMs).toBeGreaterThanOrEqual(0);
  });

  it('close() moves the thread file to closed/ and removes it from list()', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('t1', 'claude');
    await s.append('t1', {
      ts: 'x',
      role: 'user',
      adapter: 'claude',
      content: 'hello',
    });
    await s.close('t1');
    expect(existsSync(join(tmp, 't1.jsonl'))).toBe(false);
    expect(existsSync(join(tmp, 'closed', 't1.jsonl'))).toBe(true);
    expect(await s.list()).toHaveLength(0);
    // read() still works for closed threads.
    const turns = await s.read('t1');
    expect(turns).toHaveLength(1);
  });

  it('close() is idempotent', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.close('never-existed'); // no-op
    await s.open('t', 'claude');
    await s.close('t');
    await s.close('t'); // second close is also no-op
    expect(existsSync(join(tmp, 'closed', 't.jsonl'))).toBe(true);
  });

  it('closeAll() returns all closed thread ids', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('a', 'claude');
    await s.open('b', 'gemini');
    await s.open('c', 'codex');
    const closed = await s.closeAll();
    expect(closed.sort()).toEqual(['a', 'b', 'c']);
    expect(await s.list()).toHaveLength(0);
  });

  it('sweepIdle(maxIdleMs) closes only stale threads', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('stale', 'claude');
    await s.open('fresh', 'codex');
    // Backdate "stale" file mtime to 24h ago.
    const stalePath = join(tmp, 'stale.jsonl');
    const past = (Date.now() - 24 * 3600 * 1000) / 1000;
    utimesSync(stalePath, past, past);
    const closed = await s.sweepIdle(60 * 60 * 1000); // 1h threshold
    expect(closed).toEqual(['stale']);
    const open = (await s.list()).map((t) => t.threadId);
    expect(open).toEqual(['fresh']);
  });

  it('skips corrupted/truncated lines without losing earlier turns', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('t', 'claude');
    await s.append('t', {
      ts: 'x',
      role: 'user',
      adapter: 'claude',
      content: 'good turn',
    });
    // Append a corrupted line directly to the file.
    const path = join(tmp, 't.jsonl');
    writeFileSync(
      path,
      (await fsp.readFile(path, 'utf8')) + '{"kind":"turn","role":"assist',
      'utf8'
    );
    // Plus another good turn after the corruption.
    await fsp.appendFile(
      path,
      '\n' +
        JSON.stringify({
          kind: 'turn',
          ts: 'y',
          role: 'assistant',
          adapter: 'claude',
          content: 'recovered',
        }) +
        '\n'
    );
    const turns = await s.read('t');
    expect(turns).toHaveLength(2);
    expect(turns[0].content).toBe('good turn');
    expect(turns[1].content).toBe('recovered');
  });

  it('rejects unsafe thread ids', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await expect(s.open('../escape', 'x')).rejects.toThrow(/Invalid thread id/);
    await expect(s.open('a/b', 'x')).rejects.toThrow(/Invalid thread id/);
    await expect(s.open('', 'x')).rejects.toThrow(/Invalid thread id/);
  });

  it('survives a serialized burst of appends', async () => {
    const s = new JsonlThreadStore({ rootDir: tmp });
    await s.open('burst', 'claude');
    const N = 20;
    for (let i = 0; i < N; i++) {
      await s.append('burst', {
        ts: String(i),
        role: i % 2 === 0 ? 'user' : 'assistant',
        adapter: 'claude',
        content: `turn-${i}`,
      });
    }
    const turns = await s.read('burst');
    expect(turns).toHaveLength(N);
    for (let i = 0; i < N; i++) expect(turns[i].content).toBe(`turn-${i}`);
  });
});
