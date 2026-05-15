import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JsonlAuditLog } from '../../src/stores/jsonlAuditLog.js';

let tmpDir: string;
let path: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-audit-'));
  path = join(tmpDir, 'audit.jsonl');
});

afterEach(async () => {
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('JsonlAuditLog', () => {
  it('records invoke events as parseable JSON lines with ts and pid', async () => {
    const log = new JsonlAuditLog({ path });
    await log.record({
      kind: 'invoke',
      adapter: 'codex',
      durationMs: 1234,
      tokensIn: 100,
      tokensOut: 50,
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event.kind).toBe('invoke');
    expect(parsed.event.adapter).toBe('codex');
    expect(parsed.event.durationMs).toBe(1234);
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple events without overwriting', async () => {
    const log = new JsonlAuditLog({ path });
    await log.record({ kind: 'thread.open', threadId: 't1', adapter: 'claude' });
    await log.record({ kind: 'thread.close', threadId: 't1', adapter: 'claude' });
    await log.record({ kind: 'invoke', adapter: 'gemini', durationMs: 500 });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events.map((e) => e.kind)).toEqual([
      'thread.open',
      'thread.close',
      'invoke',
    ]);
  });

  it('creates the parent directory if missing', async () => {
    const nested = join(tmpDir, 'nested', 'deeper', 'audit.jsonl');
    const log = new JsonlAuditLog({ path: nested });
    await log.record({ kind: 'invoke', adapter: 'codex', durationMs: 1 });
    expect(existsSync(nested)).toBe(true);
  });

  it('does not throw if write fails (caller continues)', async () => {
    // Use a path that cannot be created (existing file as a parent dir).
    const blockingFile = join(tmpDir, 'blocker');
    await fsp.writeFile(blockingFile, 'x');
    const badPath = join(blockingFile, 'audit.jsonl');
    const log = new JsonlAuditLog({ path: badPath });
    await expect(
      log.record({ kind: 'invoke', adapter: 'codex', durationMs: 1 })
    ).resolves.toBeUndefined();
  });

  // v2.2 — task lifecycle events
  it('records task.create, task.complete, task.fail, task.cancel, task.expire', async () => {
    const log = new JsonlAuditLog({ path });
    await log.record({
      kind: 'task.create',
      taskId: 't1',
      adapter: 'claude',
      detached: false,
      principal: null,
      idempotencyKey: 'K',
    });
    await log.record({ kind: 'task.complete', taskId: 't1', adapter: 'claude', durationMs: 5 });
    await log.record({ kind: 'task.fail', taskId: 't2', adapter: 'codex', durationMs: 1, error: 'oops' });
    await log.record({ kind: 'task.cancel', taskId: 't3', adapter: 'gemini', reason: 'caller' });
    await log.record({ kind: 'task.expire', taskId: 't4', adapter: 'codex', reason: 'ttl' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events.map((e) => e.kind)).toEqual([
      'task.create',
      'task.complete',
      'task.fail',
      'task.cancel',
      'task.expire',
    ]);
  });

  // v2.3.1 (H4) — task.fail variant carries errorKind/errorActionable/errorDetails
  it('records task.fail with errorKind, errorActionable, errorDetails (H4)', async () => {
    const log = new JsonlAuditLog({ path });
    await log.record({
      kind: 'task.fail',
      taskId: 'tsk-h4',
      adapter: 'claude',
      durationMs: 3000,
      error: 'rate-limited',
      errorKind: 'rate-limit',
      errorActionable: 'wait then retry',
      errorDetails: { capTokens: 50000, windowSec: 60, dim: 'input' },
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[0]).event;
    expect(event.kind).toBe('task.fail');
    expect(event.errorKind).toBe('rate-limit');
    expect(event.errorActionable).toBe('wait then retry');
    expect(event.errorDetails).toEqual({ capTokens: 50000, windowSec: 60, dim: 'input' });
  });

  // v2.3 (R5-D.5)
  it('records task.terminated with terminatedAt, signal, exitCode', async () => {
    const log = new JsonlAuditLog({ path });
    await log.record({
      kind: 'task.terminated',
      taskId: 'tsk-1',
      adapter: 'claude',
      terminatedAt: '2026-04-29T00:00:00.000Z',
      signal: 'SIGTERM',
      exitCode: 143,
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[0]).event;
    expect(event.kind).toBe('task.terminated');
    expect(event.terminatedAt).toBe('2026-04-29T00:00:00.000Z');
    expect(event.signal).toBe('SIGTERM');
    expect(event.exitCode).toBe(143);
  });

  it('records task.terminated with signal: "orphaned" for v3 watchdog cases', async () => {
    const log = new JsonlAuditLog({ path });
    await log.record({
      kind: 'task.terminated',
      taskId: 'tsk-2',
      adapter: 'codex',
      terminatedAt: '2026-04-29T00:30:00.000Z',
      signal: 'orphaned',
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[0]).event;
    expect(event.kind).toBe('task.terminated');
    expect(event.signal).toBe('orphaned');
  });

  it('records model.substitute event with from/to/tier/reason', async () => {
    const log = new JsonlAuditLog({ path });
    await log.record({
      kind: 'model.substitute',
      adapter: 'codex',
      from: 'gpt-DEPRECATED',
      to: 'gpt-5-codex',
      tier: 'med',
      reason: 'skill-pin-stale',
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[0]).event;
    expect(event.kind).toBe('model.substitute');
    expect(event.from).toBe('gpt-DEPRECATED');
    expect(event.to).toBe('gpt-5-codex');
  });

  // v2.2 — log rotation (R1-D.1)
  it('rotates the active log when the oldest entry is older than rotationSpan', async () => {
    // Build a log file dated yesterday so the rotation kicks in on next constructor.
    const yesterday = new Date(Date.now() - 25 * 60 * 60_000);
    const old = JSON.stringify({
      ts: yesterday.toISOString(),
      pid: 1,
      event: { kind: 'invoke', adapter: 'a', durationMs: 1 },
    });
    await fsp.writeFile(path, old + '\n', 'utf8');
    // Construct with rotateOnStart=true (default).
    new JsonlAuditLog({ path });
    // Active log should be empty (rotated away).
    const remaining = (await fsp.readFile(path, 'utf8').catch(() => '')).trim();
    expect(remaining).toBe('');
    // An archive should exist.
    const dirEntries = await fsp.readdir(tmpDir);
    expect(dirEntries.some((e) => /audit\.jsonl\.\d{4}-\d{2}-\d{2}/.test(e))).toBe(true);
  });

  it('prunes archives older than retentionMs', async () => {
    const oldStamp = '2024-01-01';
    const archive = join(tmpDir, `audit.jsonl.${oldStamp}`);
    await fsp.writeFile(archive, 'old\n', 'utf8');
    new JsonlAuditLog({ path });
    // After construction, the rotation+prune pass should have removed the old archive.
    const exists = await fsp
      .stat(archive)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});
