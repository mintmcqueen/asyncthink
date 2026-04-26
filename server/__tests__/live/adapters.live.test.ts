/**
 * Live adapter tests — gated on RUN_LIVE=1.
 *
 * Hits real gemini, codex, and claude binaries and asserts they respond. CI
 * skips these by default; developers run them locally and a nightly cron
 * runs them with secrets to catch behavior drift upstream.
 */

import { describe, it, expect } from 'vitest';
import { LocalSubprocessExecutor } from '../../src/exec/localSubprocess.js';
import { ClaudeAdapter } from '../../src/adapters/impl/claude.js';
import { GeminiAdapter } from '../../src/adapters/impl/gemini.js';
import { CodexAdapter } from '../../src/adapters/impl/codex.js';

const live = !!process.env.RUN_LIVE;
const exec = new LocalSubprocessExecutor();

describe.skipIf(!live)('live: claude adapter', () => {
  it('replies to a PING with text including PONG', async () => {
    const a = new ClaudeAdapter({ defaultTimeoutMs: 90_000 });
    const r = await a.invoke(
      { prompt: 'Reply with the literal six-character string: PONG' },
      exec
    );
    expect(r.exitCode).toBe(0);
    expect(r.text.toUpperCase()).toContain('PONG');
  }, 120_000);
});

describe.skipIf(!live)('live: gemini adapter', () => {
  it('replies to a PING with text including PONG', async () => {
    const a = new GeminiAdapter({ defaultTimeoutMs: 60_000 });
    const r = await a.invoke(
      { prompt: 'Reply with the literal six-character string: PONG' },
      exec
    );
    expect(r.exitCode).toBe(0);
    expect(r.text.toUpperCase()).toContain('PONG');
  }, 90_000);
});

describe.skipIf(!live)('live: codex adapter', () => {
  it('replies to a PING with text including PONG', async () => {
    const a = new CodexAdapter({ defaultTimeoutMs: 90_000 });
    const r = await a.invoke(
      { prompt: 'Reply with the literal six-character string: PONG' },
      exec
    );
    expect(r.exitCode).toBe(0);
    expect(r.text.toUpperCase()).toContain('PONG');
    expect(r.sessionId).toBeTruthy();
  }, 120_000);

  it('resumes a session and recalls prior context (highest-risk behavior)', async () => {
    const a = new CodexAdapter({ defaultTimeoutMs: 90_000 });
    const turn1 = await a.invoke(
      {
        prompt:
          'Remember this number for later: 42. Reply with just "stored 42" and nothing else.',
      },
      exec
    );
    expect(turn1.exitCode).toBe(0);
    expect(turn1.sessionId).toBeTruthy();

    const turn2 = await a.invoke(
      {
        prompt: 'What was the number I asked you to remember? Reply with just the number.',
        sessionId: turn1.sessionId,
      },
      exec
    );
    expect(turn2.exitCode).toBe(0);
    expect(turn2.text).toContain('42');
  }, 240_000);
});
