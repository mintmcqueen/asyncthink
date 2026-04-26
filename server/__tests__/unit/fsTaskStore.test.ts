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

  it('cleanupStale returns empty (no PIDs to reap in v2)', async () => {
    const s = new FsTaskStore({ rootDir: tmp });
    expect(await s.cleanupStale()).toEqual([]);
  });
});
