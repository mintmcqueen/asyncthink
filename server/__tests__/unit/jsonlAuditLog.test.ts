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
});
