/**
 * v2.6.0 (updated v2.8.0) — claude adapter subagent injection.
 *
 * v2.8.0 redesign: injection is now driven by `defaults.injectSubagent`
 * (default `true`), NOT auth-path detection. The previous "subscription
 * only" heuristic was fragile — users with `ANTHROPIC_API_KEY` set as a
 * fallback silently got no injection. The new design: inject everywhere
 * by default; users explicitly opt out via `set_setting injectSubagent=false`.
 *
 * Verifies:
 *   - Injection happens with --agents + --agent flags regardless of auth
 *     path, populated from settings.defaults.subagent + the registry.
 *   - `defaults.injectSubagent=false` disables injection globally.
 *   - claude.subagent.spawn audit event fires whenever injection happens,
 *     with the detected authPath surfaced for diagnostic clarity.
 *   - If subagent registry can't find the id, spawn proceeds without
 *     subagent (failure-isolated).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClaudeAdapter } from '../../src/adapters/impl/claude.js';
import { FsSettingsStore } from '../../src/stores/fsSettingsStore.js';
import { FsSubagentRegistry } from '../../src/stores/fsSubagentRegistry.js';
import { DEFAULT_ASYNCTHINK_DELEGATE } from '../../src/core/subagent.js';
import type { Executor, ExecResult } from '../../src/core/executor.js';
import type { AuditLog } from '../../src/core/auditLog.js';

let tmp: string;
let userPath: string;
let cwd: string;
let storageDir: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-claude-sa-'));
  userPath = join(tmp, 'settings.toml');
  cwd = join(tmp, 'project');
  storageDir = join(tmp, 'subagents');
  await fsp.mkdir(cwd, { recursive: true });
  await fsp.mkdir(storageDir, { recursive: true });
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

class RecordingExecutor implements Executor {
  public lastArgv: string[] = [];
  public lastEnv: Record<string, string> = {};
  async run(req: { bin: string; argv: string[]; env: Record<string, string> }): Promise<ExecResult> {
    this.lastArgv = req.argv;
    this.lastEnv = req.env;
    return {
      stdout: 'mock-response',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    };
  }
}

class RecordingAuditLog implements AuditLog {
  public events: { kind: string; [k: string]: unknown }[] = [];
  async record(event: { kind: string; [k: string]: unknown }): Promise<void> {
    this.events.push(event);
  }
}

async function buildAdapter() {
  const settingsStore = new FsSettingsStore({ userSettingsPath: userPath, cwd });
  const subagentRegistry = new FsSubagentRegistry({ storageDir });
  await subagentRegistry.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE]);
  const auditLog = new RecordingAuditLog();
  const adapter = new ClaudeAdapter({
    settingsStore,
    subagentRegistry,
    auditLog,
  });
  return { adapter, auditLog, settingsStore };
}

describe('ClaudeAdapter — subagent injection', () => {
  it('injects --agents + --agent on subscription auth path', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { adapter, auditLog } = await buildAdapter();
      const exec = new RecordingExecutor();
      await adapter.invoke(
        { prompt: 'test', intelligence: 'med' },
        exec
      );
      expect(exec.lastArgv).toContain('--agents');
      expect(exec.lastArgv).toContain('--agent');
      expect(exec.lastArgv).toContain('asyncthink-delegate');
      const agentsIdx = exec.lastArgv.indexOf('--agents');
      const agentsJson = exec.lastArgv[agentsIdx + 1];
      const parsed = JSON.parse(agentsJson);
      expect(parsed['asyncthink-delegate']).toBeTruthy();
      expect(parsed['asyncthink-delegate'].prompt).toContain('AsyncThink delegate worker');
      expect(parsed['asyncthink-delegate'].tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(auditLog.events).toContainEqual(
        expect.objectContaining({
          kind: 'claude.subagent.spawn',
          subagentId: 'asyncthink-delegate',
          authPath: 'subscription',
        })
      );
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  // v2.8.0 — injection now happens on api path too (was: skipped).
  it('injects subagent on api auth path (ANTHROPIC_API_KEY set) — v2.8 design', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const { adapter, auditLog } = await buildAdapter();
      const exec = new RecordingExecutor();
      await adapter.invoke(
        { prompt: 'test', intelligence: 'med' },
        exec
      );
      expect(exec.lastArgv).toContain('--agents');
      expect(exec.lastArgv).toContain('--agent');
      expect(exec.lastArgv).toContain('asyncthink-delegate');
      const spawnEvents = auditLog.events.filter(
        (e) => e.kind === 'claude.subagent.spawn'
      );
      expect(spawnEvents).toHaveLength(1);
      // The detected authPath is surfaced in the audit event for diagnostics,
      // even though it no longer gates the decision.
      expect(spawnEvents[0]).toMatchObject({
        kind: 'claude.subagent.spawn',
        authPath: 'api',
      });
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // v2.8.0 — explicit opt-out via settings.
  it('skips injection when defaults.injectSubagent=false (explicit opt-out)', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { adapter, settingsStore, auditLog } = await buildAdapter();
      await settingsStore.set('defaults.injectSubagent', false, 'user');
      const exec = new RecordingExecutor();
      await adapter.invoke(
        { prompt: 'test', intelligence: 'med' },
        exec
      );
      expect(exec.lastArgv).not.toContain('--agents');
      expect(exec.lastArgv).not.toContain('--agent');
      expect(auditLog.events.filter((e) => e.kind === 'claude.subagent.spawn')).toHaveLength(0);
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  it('falls back gracefully when configured subagent id is missing', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { adapter, settingsStore, auditLog } = await buildAdapter();
      // Point defaults.subagent at a non-existent id.
      await settingsStore.set('defaults.subagent', 'nonexistent-subagent', 'user');
      const exec = new RecordingExecutor();
      await adapter.invoke({ prompt: 'test', intelligence: 'med' }, exec);
      // Spawn proceeds without --agents, no audit event emitted.
      expect(exec.lastArgv).not.toContain('--agents');
      expect(auditLog.events.filter((e) => e.kind === 'claude.subagent.spawn')).toHaveLength(0);
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  it('user-customized subagent overrides built-in prompt', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { adapter, settingsStore } = await buildAdapter();
      // Create a new subagent and point settings at it.
      const subagentRegistry = new FsSubagentRegistry({ storageDir });
      await subagentRegistry.create({
        name: 'Security Review Local',
        description: 'Security-focused code review',
        prompt: 'You are a security reviewer. Focus on injection vectors.',
        tools: ['Read', 'Grep'],
      });
      await settingsStore.set('defaults.subagent', 'security-review-local', 'user');
      const exec = new RecordingExecutor();
      await adapter.invoke({ prompt: 'test', intelligence: 'med' }, exec);
      const agentsIdx = exec.lastArgv.indexOf('--agents');
      const agentsJson = exec.lastArgv[agentsIdx + 1];
      const parsed = JSON.parse(agentsJson);
      expect(parsed['security-review-local']).toBeTruthy();
      expect(parsed['security-review-local'].prompt).toContain('security reviewer');
      expect(exec.lastArgv).toContain('security-review-local');
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  // v2.7.0 — per-call subagent override.
  it('per-call inv.subagent wins over settings default', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { adapter, settingsStore } = await buildAdapter();
      const subagentRegistry = new FsSubagentRegistry({ storageDir });
      // Settings default = security-review (one of the v2.7 builtins).
      await subagentRegistry.create({
        name: 'Security Review Inline',
        description: 'security',
        prompt: 'You are a security reviewer.',
      });
      await settingsStore.set('defaults.subagent', 'security-review-inline', 'user');
      // Bootstrap a different built-in.
      await subagentRegistry.create({
        name: 'Simplify Review Inline',
        description: 'simplify',
        prompt: 'You are a simplicity reviewer.',
      });
      const exec = new RecordingExecutor();
      // Caller asks specifically for simplify; should override the default.
      await adapter.invoke(
        { prompt: 'test', intelligence: 'med', subagent: 'simplify-review-inline' },
        exec
      );
      expect(exec.lastArgv).toContain('simplify-review-inline');
      expect(exec.lastArgv).not.toContain('security-review-inline');
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  it('per-call inv.subagent that does not exist falls back to NO spawn (not to settings default)', async () => {
    // Design choice: if the caller EXPLICITLY asked for a subagent that
    // doesn't exist, that's a caller bug; we should not silently route to
    // some other persona. We fall back to no-subagent spawn.
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { adapter, settingsStore, auditLog } = await buildAdapter();
      await settingsStore.set('defaults.subagent', 'asyncthink-delegate', 'user');
      const exec = new RecordingExecutor();
      await adapter.invoke(
        { prompt: 'test', intelligence: 'med', subagent: 'totally-made-up' },
        exec
      );
      expect(exec.lastArgv).not.toContain('--agents');
      expect(exec.lastArgv).not.toContain('totally-made-up');
      expect(exec.lastArgv).not.toContain('asyncthink-delegate');
      expect(auditLog.events.filter((e) => e.kind === 'claude.subagent.spawn')).toHaveLength(0);
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });
});
