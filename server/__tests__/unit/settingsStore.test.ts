/**
 * v2.6.0 — FsSettingsStore + settings core helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FsSettingsStore } from '../../src/stores/fsSettingsStore.js';
import {
  mergeLayers,
  setPath,
  unsetPath,
  readPath,
  validateKey,
  BUILTIN_DEFAULTS,
} from '../../src/core/settings.js';

let tmp: string;
let userPath: string;
let cwd: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-settings-'));
  userPath = join(tmp, 'user', 'settings.toml');
  cwd = join(tmp, 'project');
  await fsp.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('core helpers — readPath / setPath / unsetPath', () => {
  it('readPath: returns nested value', () => {
    expect(readPath({ defaults: { adapter: 'gemini' } }, 'defaults.adapter')).toBe('gemini');
  });

  it('readPath: undefined for missing leaf', () => {
    expect(readPath({}, 'defaults.adapter')).toBeUndefined();
  });

  it('setPath: creates nested object', () => {
    const out = setPath({}, 'defaults.adapter', 'gemini');
    expect(out).toEqual({ defaults: { adapter: 'gemini' } });
  });

  it('setPath: overwrites existing value, preserves siblings', () => {
    const out = setPath(
      { defaults: { adapter: 'claude', subagent: 'x' } },
      'defaults.adapter',
      'gemini'
    );
    expect(out).toEqual({ defaults: { adapter: 'gemini', subagent: 'x' } });
  });

  it('unsetPath: removes leaf, preserves siblings', () => {
    const out = unsetPath(
      { defaults: { adapter: 'gemini', subagent: 'x' } },
      'defaults.adapter'
    );
    expect(out).toEqual({ defaults: { subagent: 'x' } });
  });
});

describe('mergeLayers', () => {
  it('higher precedence overrides lower', () => {
    const merged = mergeLayers([
      { defaults: { adapter: 'claude', subagent: 'a' } },
      { defaults: { adapter: 'gemini' } },
    ]);
    expect(merged.defaults?.adapter).toBe('gemini');
    expect(merged.defaults?.subagent).toBe('a');
  });

  it('built-in is the floor', () => {
    const merged = mergeLayers([BUILTIN_DEFAULTS]);
    expect(merged.defaults?.adapter).toBe('claude');
    expect(merged.defaults?.subagent).toBe('asyncthink-delegate');
  });
});

describe('validateKey', () => {
  it('accepts valid adapter', () => {
    expect(validateKey('defaults.adapter', 'gemini')).toEqual({ valid: true });
  });
  it('rejects unknown adapter', () => {
    const r = validateKey('defaults.adapter', 'opus');
    expect(r.valid).toBe(false);
  });
  it('rejects non-string adapter', () => {
    const r = validateKey('defaults.adapter', 42);
    expect(r.valid).toBe(false);
  });
  it('accepts subagent id', () => {
    expect(validateKey('defaults.subagent', 'my-reviewer')).toEqual({ valid: true });
  });
  it('rejects empty subagent id', () => {
    expect(validateKey('defaults.subagent', '').valid).toBe(false);
  });
  it('rejects unknown key', () => {
    const r = validateKey('defaults.unknown', 'x');
    expect(r.valid).toBe(false);
  });
});

describe('FsSettingsStore — get/set/unset', () => {
  it('returns built-in defaults when no files exist', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    const s = await store.get();
    expect(s.effective.defaults?.adapter).toBe('claude');
    expect(s.effective.defaults?.subagent).toBe('asyncthink-delegate');
  });

  it('user file overrides built-in', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await store.set('defaults.adapter', 'gemini', 'user');
    const fresh = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    const s = await fresh.get();
    expect(s.effective.defaults?.adapter).toBe('gemini');
  });

  it('project file overrides user file', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await store.set('defaults.adapter', 'gemini', 'user');
    await store.set('defaults.adapter', 'codex', 'project');
    const fresh = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    const s = await fresh.get();
    expect(s.effective.defaults?.adapter).toBe('codex');
  });

  it('unset reverts to lower layer', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await store.set('defaults.adapter', 'gemini', 'user');
    await store.unset('defaults.adapter', 'user');
    const fresh = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    const s = await fresh.get();
    expect(s.effective.defaults?.adapter).toBe('claude');
  });

  it('per-layer breakdown surfaces in `layers` field', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await store.set('defaults.adapter', 'gemini', 'user');
    const s = await store.get();
    const sources = s.layers.map((l) => l.source);
    expect(sources).toContain('project');
    expect(sources).toContain('user');
    expect(sources).toContain('builtin');
  });

  it('set rejects invalid keys', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await expect(store.set('defaults.adapter', 'opus', 'user')).rejects.toThrow();
    await expect(store.set('defaults.unknown', 'x', 'user')).rejects.toThrow();
  });

  it('user write is TOML', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await store.set('defaults.adapter', 'gemini', 'user');
    const text = readFileSync(userPath, 'utf8');
    expect(text).toContain('[defaults]');
    expect(text).toContain('adapter = "gemini"');
  });

  it('project write is YAML frontmatter at .claude/asyncthink.local.md', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await store.set('defaults.adapter', 'codex', 'project');
    const projectPath = join(cwd, '.claude', 'asyncthink.local.md');
    expect(existsSync(projectPath)).toBe(true);
    const text = readFileSync(projectPath, 'utf8');
    expect(text).toMatch(/^---/);
    expect(text).toContain('defaults:');
    expect(text).toContain('adapter: "codex"');
  });

  it('ancestor-walk: finds .claude/asyncthink.local.md in parent dir', async () => {
    const ancestor = join(tmp, 'project');
    const child = join(ancestor, 'nested', 'deeper');
    await fsp.mkdir(child, { recursive: true });
    await fsp.mkdir(join(ancestor, '.claude'), { recursive: true });
    writeFileSync(
      join(ancestor, '.claude', 'asyncthink.local.md'),
      '---\ndefaults:\n  adapter: "gemini"\n---\n'
    );
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd: child });
    const s = await store.get();
    expect(s.effective.defaults?.adapter).toBe('gemini');
  });
});

describe('FsSettingsStore — TOML round-trip', () => {
  it('writes then reads identical values', async () => {
    const store = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    await store.set('defaults.adapter', 'gemini', 'user');
    await store.set('defaults.subagent', 'my-reviewer', 'user');
    const fresh = new FsSettingsStore({ userSettingsPath: userPath, cwd });
    const s = await fresh.get();
    expect(s.effective.defaults?.adapter).toBe('gemini');
    expect(s.effective.defaults?.subagent).toBe('my-reviewer');
  });
});
