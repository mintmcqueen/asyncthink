/**
 * Restart-survival test.
 *
 * Validates that delegate threads persist across server restarts: the
 * JsonlThreadStore writes to disk, and a fresh Delegate instance pointing
 * at the same root dir can continue an existing thread without losing
 * history or session id.
 *
 * Restart is simulated by tearing down the Delegate + ThreadStore instance
 * and constructing a new one over the same on-disk dir. This is the layer
 * that matters — actually re-spawning the MCP server process is just OS
 * machinery and would not exercise anything new.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Delegate, type AdapterLookup } from '../../src/delegate/delegate.js';
import type {
  Adapter,
  AdapterInvocation,
  AdapterResult,
  ResumeStrategy,
} from '../../src/core/adapter.js';
import type { Executor } from '../../src/core/executor.js';
import { JsonlThreadStore } from '../../src/stores/jsonlThreadStore.js';

class FakeAdapter implements Adapter {
  readonly id = 'fake';
  readonly readOnly = true as const;
  constructor(public readonly resumeStrategy: ResumeStrategy = 'replay') {}
  readonly invocations: AdapterInvocation[] = [];
  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    this.invocations.push(inv);
    return {
      text: `reply-${this.invocations.length}`,
      sessionId: inv.sessionId ?? `fake-session-${this.invocations.length}`,
      raw: null,
      exitCode: 0,
      durationMs: 1,
    };
  }
}

const noopExecutor: Executor = {
  async run() {
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
  },
};

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-restart-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function buildDelegate(adapter: Adapter): { d: Delegate; store: JsonlThreadStore } {
  const store = new JsonlThreadStore({ rootDir: tmp });
  const lookup: AdapterLookup = {
    get: (id) => (id === adapter.id ? adapter : undefined),
    list: () => [adapter],
  };
  return { d: new Delegate(lookup, store, noopExecutor), store };
}

describe('restart survival', () => {
  it('replay-strategy thread continues across simulated restart with full history', async () => {
    const adapter1 = new FakeAdapter('replay');
    const { d: pre } = buildDelegate(adapter1);
    const r1 = await pre.run({ adapter: 'fake', prompt: 'first' });

    // "Restart": discard prior Delegate and store, build fresh ones over the
    // same on-disk dir.
    const adapter2 = new FakeAdapter('replay');
    const { d: post, store: postStore } = buildDelegate(adapter2);

    const r2 = await post.run({ adapter: 'fake', prompt: 'second', threadId: r1.threadId });
    expect(r2.threadId).toBe(r1.threadId);
    expect(r2.turn).toBe(2);

    // Adapter on the post-restart Delegate sees prior history serialized in
    // the prompt (replay strategy).
    expect(adapter2.invocations[0].prompt).toContain('first');
    expect(adapter2.invocations[0].prompt).toContain('reply-1');
    expect(adapter2.invocations[0].prompt).toContain('second');

    // Transcript on disk now has all four turns.
    const turns = await postStore.read(r1.threadId);
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('native-strategy thread recovers sessionId across restart', async () => {
    const adapter1 = new FakeAdapter('native');
    const { d: pre } = buildDelegate(adapter1);
    const r1 = await pre.run({ adapter: 'fake', prompt: 'first' });
    const firstSessionId = r1.sessionId;
    expect(firstSessionId).toBeTruthy();

    const adapter2 = new FakeAdapter('native');
    const { d: post } = buildDelegate(adapter2);
    await post.run({ adapter: 'fake', prompt: 'second', threadId: r1.threadId });

    // Adapter on the post-restart Delegate received the prior assistant turn's
    // sessionId — the proof that JSONL persistence captured it.
    expect(adapter2.invocations[0].sessionId).toBe(firstSessionId);
  });

  it('closed threads stay closed across restart', async () => {
    const adapter = new FakeAdapter();
    const { d: pre, store: preStore } = buildDelegate(adapter);
    const r = await pre.run({ adapter: 'fake', prompt: 'one shot', close: true });
    expect(await preStore.list()).toHaveLength(0);

    const adapter2 = new FakeAdapter();
    const { store: postStore } = buildDelegate(adapter2);
    expect(await postStore.list()).toHaveLength(0);

    // The transcript is still readable from the closed dir.
    const turns = await postStore.read(r.threadId);
    expect(turns).toHaveLength(2);
  });
});
