/**
 * Sequential thinking core — ported from server/__tests__.v1/lib.test.ts.
 *
 * The engine in server/src/asyncthink/thinking.ts is a verbatim port of the
 * v1 module; these tests ensure the public behavior is unchanged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AsyncThinkingServer, type ThoughtInput } from '../../src/asyncthink/thinking.js';

let server: AsyncThinkingServer;

beforeEach(() => {
  server = new AsyncThinkingServer();
});

const baseThought = (overrides: Partial<ThoughtInput> = {}): ThoughtInput => ({
  thought: 'reasoning step',
  thoughtNumber: 1,
  totalThoughts: 3,
  nextThoughtNeeded: true,
  ...overrides,
});

describe('AsyncThinkingServer.processThought', () => {
  it('accepts a valid thought and returns structured output', () => {
    const r = server.processThought(baseThought());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.thoughtNumber).toBe(1);
    expect(parsed.totalThoughts).toBe(3);
    expect(parsed.nextThoughtNeeded).toBe(true);
    expect(parsed.thoughtHistoryLength).toBe(1);
    expect(parsed.branches).toEqual([]);
  });

  it('grows totalThoughts when thoughtNumber exceeds it', () => {
    const r = server.processThought(baseThought({ thoughtNumber: 5, totalThoughts: 3 }));
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.totalThoughts).toBe(5);
  });

  it('tracks a branch when branchFromThought + branchId are present', () => {
    server.processThought(baseThought({ thoughtNumber: 1 }));
    server.processThought(
      baseThought({
        thoughtNumber: 2,
        branchFromThought: 1,
        branchId: 'alt',
      })
    );
    const r = server.processThought(
      baseThought({
        thoughtNumber: 3,
        branchFromThought: 1,
        branchId: 'alt',
      })
    );
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.branches).toContain('alt');
  });

  it('accumulates thoughtHistory across calls', () => {
    server.processThought(baseThought({ thoughtNumber: 1 }));
    server.processThought(baseThought({ thoughtNumber: 2 }));
    const r = server.processThought(baseThought({ thoughtNumber: 3 }));
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.thoughtHistoryLength).toBe(3);
  });

  it('marks nextThoughtNeeded false on the final thought', () => {
    const r = server.processThought(baseThought({ nextThoughtNeeded: false }));
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.nextThoughtNeeded).toBe(false);
  });

  it('handles long thoughts without crashing', () => {
    const long = 'x'.repeat(2_000);
    const r = server.processThought(baseThought({ thought: long }));
    expect(r.isError).toBeFalsy();
  });

  it('respects DISABLE_THOUGHT_LOGGING=true', () => {
    const original = process.env.DISABLE_THOUGHT_LOGGING;
    process.env.DISABLE_THOUGHT_LOGGING = 'true';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const local = new AsyncThinkingServer();
    local.processThought(baseThought());
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    process.env.DISABLE_THOUGHT_LOGGING = original;
  });

  it('logs the formatted thought to stderr by default', () => {
    const original = process.env.DISABLE_THOUGHT_LOGGING;
    delete process.env.DISABLE_THOUGHT_LOGGING;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const local = new AsyncThinkingServer();
    local.processThought(baseThought());
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    if (original !== undefined) process.env.DISABLE_THOUGHT_LOGGING = original;
  });
});
