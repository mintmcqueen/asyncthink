import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FsTaskStore } from '../../src/stores/fsTaskStore.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-tasks-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('FsTaskStore', () => {
  it('creates a task with status pending and returns its dir', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    const dir = await s.create('t1', 'analyze repo');
    expect(dir.startsWith(tmp)).toBe(true);
    const state = await s.get('t1');
    expect(state?.status).toBe('pending');
    expect(state?.topic).toBe('analyze repo');
    expect(state?.startTime).toBeTruthy();
  });

  it('rejects duplicate ids on create', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    await s.create('t1', 'topic');
    await expect(s.create('t1', 'topic')).rejects.toThrow(/already exists/);
  });

  it('updates fields and stamps completeTime on terminal states', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    await s.create('t', 'x');
    await s.update('t', { status: 'running' });
    let state = await s.get('t');
    expect(state?.status).toBe('running');
    expect(state?.completeTime).toBeUndefined();
    await s.update('t', { status: 'complete', result: 'done' });
    state = await s.get('t');
    expect(state?.completeTime).toBeTruthy();
    expect(state?.result).toBe('done');
  });

  it('byStatus filters', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    await s.create('a', '1');
    await s.create('b', '2');
    await s.create('c', '3');
    await s.update('b', { status: 'running' });
    await s.update('c', { status: 'complete' });
    expect((await s.byStatus('pending')).map((t) => t.id)).toEqual(['a']);
    expect((await s.byStatus('running')).map((t) => t.id)).toEqual(['b']);
    expect((await s.byStatus('complete')).map((t) => t.id)).toEqual(['c']);
  });

  it('delete is idempotent and removes from disk', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    await s.create('t', 'x');
    await s.delete('t');
    expect(await s.get('t')).toBeUndefined();
    await s.delete('t'); // second delete is no-op
  });

  it('persists state to disk and reloads it on a fresh instance', async () => {
    const s1 = new FsTaskStore({ rootDir: tmp });
    await s1.create('t', 'topic');
    await s1.update('t', { status: 'complete', result: 'answer' });
    const s2 = new FsTaskStore({ rootDir: tmp });
    expect(await s2.get('t')).toBeUndefined(); // mem starts empty
    s2.reloadFromDisk();
    const state = await s2.get('t');
    expect(state?.status).toBe('complete');
    expect(state?.result).toBe('answer');
  });

  it('handles unsafe ids by sanitizing the on-disk path', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    const dir = await s.create('sess::weird/id', 'topic');
    expect(dir).not.toContain('/sess::');
    expect(await s.get('sess::weird/id')).toBeTruthy();
  });

  it('cleanupStale returns empty when nothing exceeds category TTL', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    await s.create('fresh', 'topic');
    expect(await s.cleanupStale()).toEqual([]);
  });

  // v2.2 — idempotency-key index (R-DUR-D.3)
  describe('findByIdempotencyKey', () => {
    it('returns matching non-terminal task by (key, principal)', async () => {
      const s = new FsTaskStore({ rootDir: tmp });
      await s.create('a', 'topic');
      await s.update('a', {
        status: 'working',
        idempotencyKey: 'IDK',
        principal: null,
      });
      const found = await s.findByIdempotencyKey('IDK', null);
      expect(found?.id).toBe('a');
    });

    it('returns undefined for terminal tasks', async () => {
      const s = new FsTaskStore({ rootDir: tmp });
      await s.create('done', 'topic');
      await s.update('done', { status: 'completed', idempotencyKey: 'IDK' });
      expect(await s.findByIdempotencyKey('IDK', null)).toBeUndefined();
    });

    it('partitions by principal', async () => {
      const s = new FsTaskStore({ rootDir: tmp });
      await s.create('a', 'topic');
      await s.update('a', {
        status: 'working',
        idempotencyKey: 'X',
        principal: 'alice',
      });
      const bob = await s.findByIdempotencyKey('X', 'bob');
      expect(bob).toBeUndefined();
      const alice = await s.findByIdempotencyKey('X', 'alice');
      expect(alice?.id).toBe('a');
    });
  });

  // v2.2 — category-wise TTL sweep (R-DUR-D.4)
  describe('cleanupStale (category TTL)', () => {
    it('working tasks reaped after 60m', async () => {
      const s = new FsTaskStore({
        rootDir: tmp,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      await s.create('w', 'work');
      await s.update('w', { status: 'working' });
      Object.defineProperty(s, 'now', {
        value: () => new Date('2026-01-01T01:01:00Z'),
      });
      const reaped = await s.cleanupStale();
      expect(reaped).toContain('w');
    });

    it('completed tasks reaped after 60m', async () => {
      const s = new FsTaskStore({
        rootDir: tmp,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      await s.create('c', 'work');
      await s.update('c', { status: 'completed' });
      Object.defineProperty(s, 'now', {
        value: () => new Date('2026-01-01T01:01:00Z'),
      });
      const reaped = await s.cleanupStale();
      expect(reaped).toContain('c');
    });

    it('failed tasks reaped after 10m', async () => {
      const s = new FsTaskStore({
        rootDir: tmp,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      await s.create('f', 'work');
      await s.update('f', { status: 'failed' });
      Object.defineProperty(s, 'now', {
        value: () => new Date('2026-01-01T00:11:00Z'),
      });
      const reaped = await s.cleanupStale();
      expect(reaped).toContain('f');
    });

    // v2.3 (R5-D.3, R5-D.4)
    it('skip filter protects in-flight cancelling tasks from deletion', async () => {
      const s = new FsTaskStore({
        rootDir: tmp,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      await s.create('cancellingTask', 'work');
      await s.update('cancellingTask', { status: 'cancelled' });
      Object.defineProperty(s, 'now', {
        value: () => new Date('2026-01-01T00:06:00Z'),
      });
      // Without skip: would reap (past 5m TTL).
      // With skip: protected.
      const reaped = await s.cleanupStale({ skip: new Set(['cancellingTask']) });
      expect(reaped).not.toContain('cancellingTask');
      expect(await s.get('cancellingTask')).toBeTruthy();
    });

    it('hard ceiling (30m) force-deletes even if in skip set', async () => {
      const s = new FsTaskStore({
        rootDir: tmp,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      await s.create('orphanTask', 'work');
      await s.update('orphanTask', { status: 'cancelled' });
      Object.defineProperty(s, 'now', {
        value: () => new Date('2026-01-01T00:31:00Z'),
      });
      const reaped = await s.cleanupStale({ skip: new Set(['orphanTask']) });
      expect(reaped).toContain('orphanTask');
    });

    it('cancelled tasks reaped after 5m', async () => {
      const s = new FsTaskStore({
        rootDir: tmp,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      await s.create('x', 'work');
      await s.update('x', { status: 'cancelled' });
      Object.defineProperty(s, 'now', {
        value: () => new Date('2026-01-01T00:06:00Z'),
      });
      const reaped = await s.cleanupStale();
      expect(reaped).toContain('x');
    });
  });
});
