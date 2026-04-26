/**
 * Live delegate multi-turn tests — gated on RUN_LIVE=1.
 *
 * Exercises end-to-end through the Delegate handler with real CLIs:
 *   - claude:  replay-strategy, multi-turn with prepended history
 *   - codex:   native-strategy, multi-turn via exec resume <thread_id>
 *   - gemini:  replay-strategy (modern gemini-cli versions; older versions
 *              like v0.1.3 will fail — that's environmental)
 *
 * Skipped in CI. Run locally with RUN_LIVE=1 npm test once the relevant
 * CLIs are authenticated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Delegate } from '../../src/delegate/delegate.js';
import { JsonlThreadStore } from '../../src/stores/jsonlThreadStore.js';
import { LocalSubprocessExecutor } from '../../src/exec/localSubprocess.js';
import { AdapterRegistry } from '../../src/adapters/index.js';

const live = !!process.env.RUN_LIVE;

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-live-delegate-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function buildDelegate(): Delegate {
  const adapters = AdapterRegistry.withDefaults();
  const store = new JsonlThreadStore({ rootDir: tmp });
  const executor = new LocalSubprocessExecutor();
  return new Delegate(adapters, store, executor);
}

describe.skipIf(!live)('live delegate: claude (replay)', () => {
  it('multi-turn conversation with replayed history', async () => {
    const d = buildDelegate();
    const r1 = await d.run({
      adapter: 'claude',
      prompt: 'Reply with the literal six-character string PONG. Nothing else.',
      timeoutMs: 90_000,
    });
    expect(r1.exitCode).toBe(0);
    expect(r1.output.toUpperCase()).toContain('PONG');

    const r2 = await d.run({
      adapter: 'claude',
      threadId: r1.threadId,
      prompt: 'What did I just ask you to reply with? Answer in one word.',
      close: true,
      timeoutMs: 90_000,
    });
    expect(r2.exitCode).toBe(0);
    expect(r2.output.toUpperCase()).toContain('PONG');
    expect(r2.closed).toBe(true);
  }, 240_000);
});

describe.skipIf(!live)('live delegate: codex (native resume)', () => {
  it('three-turn conversation via thread.started session id', async () => {
    const d = buildDelegate();
    const r1 = await d.run({
      adapter: 'codex',
      prompt: 'Remember the number 42. Reply with just "ok".',
      timeoutMs: 90_000,
    });
    expect(r1.exitCode).toBe(0);

    const r2 = await d.run({
      adapter: 'codex',
      threadId: r1.threadId,
      prompt: 'Now remember the color blue. Reply with just "ok".',
      timeoutMs: 90_000,
    });
    expect(r2.exitCode).toBe(0);

    const r3 = await d.run({
      adapter: 'codex',
      threadId: r1.threadId,
      prompt: 'What number and color did I tell you to remember?',
      close: true,
      timeoutMs: 90_000,
    });
    expect(r3.exitCode).toBe(0);
    expect(r3.output).toContain('42');
    expect(r3.output.toLowerCase()).toContain('blue');
    expect(r3.closed).toBe(true);
  }, 360_000);
});

describe.skipIf(!live)('live delegate: gemini (replay)', () => {
  it('multi-turn conversation with replayed history', async () => {
    const d = buildDelegate();
    const r1 = await d.run({
      adapter: 'gemini',
      prompt: 'Reply with the literal six-character string PONG. Nothing else.',
      timeoutMs: 60_000,
    });
    expect(r1.exitCode).toBe(0);
    expect(r1.output.toUpperCase()).toContain('PONG');

    const r2 = await d.run({
      adapter: 'gemini',
      threadId: r1.threadId,
      prompt: 'What did I just ask you to reply with? Answer in one word.',
      close: true,
      timeoutMs: 60_000,
    });
    expect(r2.exitCode).toBe(0);
    expect(r2.output.toUpperCase()).toContain('PONG');
  }, 180_000);
});
