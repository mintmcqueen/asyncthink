/**
 * v2.6.0 — FsSubagentRegistry CRUD + bootstrap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FsSubagentRegistry } from '../../src/stores/fsSubagentRegistry.js';
import {
  DEFAULT_ASYNCTHINK_DELEGATE,
  slugifyName,
} from '../../src/core/subagent.js';

let storageDir: string;

beforeEach(async () => {
  storageDir = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-subagent-'));
});

afterEach(async () => {
  try {
    await fsp.rm(storageDir, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('slugifyName', () => {
  it('lowercases', () => {
    expect(slugifyName('My Reviewer')).toBe('my-reviewer');
  });
  it('strips non-alphanumerics', () => {
    expect(slugifyName('My Reviewer!')).toBe('my-reviewer');
  });
  it('collapses runs', () => {
    expect(slugifyName('My   Reviewer')).toBe('my-reviewer');
  });
  it('trims edges', () => {
    expect(slugifyName('  X  ')).toBe('x');
  });
  it('caps at 64 chars', () => {
    expect(slugifyName('a'.repeat(100)).length).toBe(64);
  });
});

describe('FsSubagentRegistry — CRUD', () => {
  it('list returns empty array when storage is empty', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    expect(await r.list()).toEqual([]);
  });

  it('create writes a file, returns the subagent with id + createdAt', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    const sa = await r.create({
      name: 'Code Reviewer',
      description: 'Reviews code for quality',
      prompt: 'You review code.',
    });
    expect(sa.id).toBe('code-reviewer');
    expect(sa.createdAt).toBeTruthy();
    expect(existsSync(join(storageDir, 'code-reviewer.json'))).toBe(true);
  });

  it('create rejects missing required fields', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await expect(
      r.create({ name: 'X', description: '', prompt: 'Y' })
    ).rejects.toThrow();
    await expect(
      r.create({ name: '', description: 'X', prompt: 'Y' })
    ).rejects.toThrow();
    await expect(
      r.create({ name: 'X', description: 'Y', prompt: '' })
    ).rejects.toThrow();
  });

  it('create rejects duplicate id', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.create({ name: 'Reviewer', description: 'D', prompt: 'P' });
    await expect(
      r.create({ name: 'Reviewer', description: 'D2', prompt: 'P2' })
    ).rejects.toThrow();
  });

  it('get returns the subagent', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    const created = await r.create({
      name: 'X',
      description: 'D',
      prompt: 'P',
    });
    const got = await r.get(created.id);
    expect(got).toEqual(created);
  });

  it('get returns undefined for missing id', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    expect(await r.get('nope')).toBeUndefined();
  });

  it('update patches fields, preserves the rest', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    const sa = await r.create({
      name: 'X',
      description: 'old',
      prompt: 'P',
    });
    const updated = await r.update(sa.id, { description: 'new' });
    expect(updated.description).toBe('new');
    expect(updated.prompt).toBe('P');
    expect(updated.createdAt).toBe(sa.createdAt);
  });

  it('update rejects missing subagent', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await expect(r.update('nope', { description: 'x' })).rejects.toThrow();
  });

  it('delete returns deleted:true on hit, deleted:false on miss', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    const sa = await r.create({
      name: 'X',
      description: 'D',
      prompt: 'P',
    });
    expect(await r.delete(sa.id)).toEqual({ deleted: true });
    expect(await r.delete(sa.id)).toEqual({ deleted: false });
  });

  it('list returns multiple subagents sorted by id', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.create({ name: 'B', description: 'D', prompt: 'P' });
    await r.create({ name: 'A', description: 'D', prompt: 'P' });
    const list = await r.list();
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('FsSubagentRegistry — bootstrapBuiltins', () => {
  it('creates default subagent on first boot', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE]);
    const sa = await r.get('asyncthink-delegate');
    expect(sa).toBeTruthy();
    expect(sa?.isBuiltIn).toBe(true);
    expect(sa?.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('user customization wins (idempotent on second boot)', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE]);
    // User edits the prompt.
    await r.update('asyncthink-delegate', { prompt: 'MY CUSTOM PROMPT' });
    // Second bootstrap should NOT overwrite.
    await r.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE]);
    const sa = await r.get('asyncthink-delegate');
    expect(sa?.prompt).toBe('MY CUSTOM PROMPT');
  });

  it('writes file with JSON schemaVersion field', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE]);
    const raw = readFileSync(join(storageDir, 'asyncthink-delegate.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
  });
});
