/**
 * v2.6.0 — FsSubagentRegistry CRUD + bootstrap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FsSubagentRegistry } from '../../src/stores/fsSubagentRegistry.js';
import {
  BUILTIN_SUBAGENTS,
  CODE_REVIEW_PANEL_IDS,
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

  // v2.7.0 — code-review panel built-ins.
  it('BUILTIN_SUBAGENTS bootstraps all 5 personas (delegate + 4 review panel)', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.bootstrapBuiltins(BUILTIN_SUBAGENTS);
    const ids = (await r.list()).map((s) => s.id);
    expect(ids).toContain('asyncthink-delegate');
    expect(ids).toContain('security-review');
    expect(ids).toContain('simplify-review');
    expect(ids).toContain('test-coverage-review');
    expect(ids).toContain('correctness-review');
  });

  it('all panel subagents marked isBuiltIn=true', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.bootstrapBuiltins(BUILTIN_SUBAGENTS);
    for (const id of CODE_REVIEW_PANEL_IDS) {
      const sa = await r.get(id);
      expect(sa?.isBuiltIn).toBe(true);
    }
  });

  it('each panel subagent has a non-trivial system prompt + read-only tools', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.bootstrapBuiltins(BUILTIN_SUBAGENTS);
    for (const id of CODE_REVIEW_PANEL_IDS) {
      const sa = await r.get(id);
      expect(sa).toBeTruthy();
      expect(sa!.prompt.length).toBeGreaterThan(200); // not a stub
      expect(sa!.tools).toBeTruthy();
      // None of the panel reviewers should have Bash, Edit, Write, etc.
      const forbidden = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);
      for (const t of sa!.tools ?? []) {
        expect(forbidden.has(t)).toBe(false);
      }
    }
  });
});

/**
 * v2.8.1 — path-traversal regression. Caught by the security-review
 * subagent panel run on 2026-05-25 against the v2.8.0 diff. Without
 * isValidSubagentId() at the pathFor() entry point, `inv.subagent =
 * "../../../etc/passwd"` would be normalized by path.join and read
 * arbitrary JSON files. The defense rejects any id that doesn't match
 * slugifyName output.
 */
describe('FsSubagentRegistry — v2.8.1 path-traversal defense', () => {
  it('get(traversal-id) returns undefined, does NOT touch filesystem outside storageDir', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    // Seed a legitimate subagent alongside an attacker target on disk.
    await r.create({ name: 'Real', description: 'd', prompt: 'p' });
    const attackTarget = join(storageDir, '..', 'attack-payload.json');
    writeFileSync(
      attackTarget,
      JSON.stringify({ id: 'pwned', name: 'pwned', description: 'd', prompt: 'p', schemaVersion: 1 })
    );
    try {
      // Attack: caller passes "../attack-payload" as the subagent id.
      // path.join would normalize this to attack-payload.json above storageDir.
      const result = await r.get('../attack-payload');
      expect(result).toBeUndefined();
    } finally {
      // Cleanup the attack-payload outside the test's beforeEach-scoped storageDir.
      try {
        await fsp.unlink(attackTarget);
      } catch {
        /* may already be gone */
      }
    }
  });

  it('get with absolute path returns undefined', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    expect(await r.get('/etc/passwd')).toBeUndefined();
  });

  it('get with leading-dash id returns undefined', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    expect(await r.get('-malformed')).toBeUndefined();
  });

  it('get with uppercase id returns undefined (slugifyName lowercases)', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    // Even if a "SECURITY-REVIEW.json" file existed (e.g. case-insensitive FS
    // on macOS), passing the uppercase id is rejected because slugifyName
    // would lowercase it.
    expect(await r.get('SECURITY-REVIEW')).toBeUndefined();
  });

  it('delete with traversal id is a no-op (returns deleted:false)', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    expect(await r.delete('../../etc/passwd')).toEqual({ deleted: false });
  });

  it('delete with valid id still works (path-traversal defense doesn\'t break normal use)', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    const sa = await r.create({ name: 'Real', description: 'd', prompt: 'p' });
    expect(await r.delete(sa.id)).toEqual({ deleted: true });
  });

  it('valid ids continue to work (delegate, security-review, etc.)', async () => {
    const r = new FsSubagentRegistry({ storageDir });
    await r.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE]);
    expect(await r.get('asyncthink-delegate')).toBeTruthy();
  });
});

/**
 * v2.8.1 — pure unit tests for isValidSubagentId.
 */
import { isValidSubagentId } from '../../src/core/subagent.js';

describe('isValidSubagentId', () => {
  it.each([
    ['asyncthink-delegate', true],
    ['security-review', true],
    ['a', true],
    ['a1', true],
    ['my-code-reviewer', true],
    ['a-b-c-d-e', true],
    [`${'a'.repeat(64)}`, true],
  ])('accepts %p → %p', (id, expected) => {
    expect(isValidSubagentId(id as string)).toBe(expected);
  });

  it.each([
    ['', false], // empty
    [`${'a'.repeat(65)}`, false], // too long
    ['-leading', false],
    ['trailing-', false],
    ['UPPERCASE', false],
    ['has space', false],
    ['../../../etc/passwd', false],
    ['/etc/passwd', false],
    ['.', false],
    ['..', false],
    ['my..name', false],
    ['my--name', false], // slugify collapses runs; double-dash is rejected
    ['with.dot', false],
    ['with_underscore', false], // slugifyName uses dashes, not underscores
    ['with/slash', false],
    ['with\\backslash', false],
  ])('rejects %p → %p', (id, expected) => {
    expect(isValidSubagentId(id as string)).toBe(expected);
  });
});
