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
  readonly readOnly = true as const;
  readonly invocations: AdapterInvocation[] = [];
  private turn = 0;

  constructor(
    public readonly id: string,
    public readonly resumeStrategy: ResumeStrategy,
    private readonly responses: string[] = ['REPLY-1', 'REPLY-2', 'REPLY-3']
  ) {}

  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    this.invocations.push(inv);
    const text = this.responses[this.turn] ?? `REPLY-${this.turn + 1}`;
    this.turn += 1;
    return {
      text,
      sessionId: inv.sessionId ?? `${this.id}-session-${this.turn}`,
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

function lookupOf(...adapters: Adapter[]): AdapterLookup {
  const m = new Map(adapters.map((a) => [a.id, a]));
  return {
    get: (id) => m.get(id),
    list: () => [...m.values()],
  };
}

let tmp: string;
let store: JsonlThreadStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-delegate-'));
  store = new JsonlThreadStore({ rootDir: tmp });
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('Delegate', () => {
  it('opens a thread and returns the new threadId on first call', async () => {
    const a = new FakeAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    const r = await d.run({ adapter: 'claude', prompt: 'hi' });
    expect(r.threadId).toMatch(/^t-/);
    expect(r.adapter).toBe('claude');
    expect(r.output).toBe('REPLY-1');
    expect(r.closed).toBe(false);
    expect(r.turn).toBe(1);
    expect(r.reminder).toMatch(/Thread is open/);
  });

  it('persists user + assistant turns to the thread store', async () => {
    const a = new FakeAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    const r = await d.run({ adapter: 'claude', prompt: 'hello' });
    const turns = await store.read(r.threadId);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('hello');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('REPLY-1');
    expect(turns[1].sessionId).toBeTruthy();
  });

  it('continues an existing thread when threadId is provided', async () => {
    const a = new FakeAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    const r1 = await d.run({ adapter: 'claude', prompt: 'first' });
    const r2 = await d.run({ adapter: 'claude', prompt: 'second', threadId: r1.threadId });
    expect(r2.threadId).toBe(r1.threadId);
    expect(r2.turn).toBe(2);
    const turns = await store.read(r1.threadId);
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('replay-strategy adapters get history serialized into the prompt', async () => {
    const a = new FakeAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    const r1 = await d.run({ adapter: 'claude', prompt: 'first message' });
    await d.run({ adapter: 'claude', prompt: 'second message', threadId: r1.threadId });
    expect(a.invocations[1].prompt).toContain('<conversation>');
    expect(a.invocations[1].prompt).toContain('first message');
    expect(a.invocations[1].prompt).toContain('REPLY-1');
    expect(a.invocations[1].prompt).toContain('second message');
    expect(a.invocations[1].sessionId).toBeUndefined();
  });

  it('native-strategy adapters get sessionId, no history rendering', async () => {
    const a = new FakeAdapter('codex', 'native');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    const r1 = await d.run({ adapter: 'codex', prompt: 'first' });
    const r2 = await d.run({ adapter: 'codex', prompt: 'second', threadId: r1.threadId });
    expect(a.invocations[1].sessionId).toBe(r1.sessionId);
    expect(a.invocations[1].prompt).toBe('second');
    expect(a.invocations[1].prompt).not.toContain('<conversation>');
    expect(r2.sessionId).toBeTruthy();
  });

  it('close: true closes the thread immediately and surfaces it in the response', async () => {
    const a = new FakeAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    const r = await d.run({ adapter: 'claude', prompt: 'one shot', close: true });
    expect(r.closed).toBe(true);
    expect(r.reminder).toBe('Thread closed.');
    expect(await store.list()).toHaveLength(0);
  });

  it('throws on unknown adapter with helpful message', async () => {
    const a = new FakeAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    await expect(
      d.run({ adapter: 'gemini', prompt: 'x' })
    ).rejects.toThrow(/Unknown adapter "gemini".*claude/);
  });

  it('forwards files, cwd, model, timeoutMs to the adapter', async () => {
    const a = new FakeAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    await d.run({
      adapter: 'claude',
      prompt: 'p',
      files: ['/a', '/b'],
      cwd: '/proj',
      model: 'claude-test',
      timeoutMs: 5_000,
    });
    expect(a.invocations[0].files).toEqual(['/a', '/b']);
    expect(a.invocations[0].cwd).toBe('/proj');
    expect(a.invocations[0].model).toBe('claude-test');
    expect(a.invocations[0].timeoutMs).toBe(5_000);
  });

  it('surfaces durationMs and exitCode from the adapter result', async () => {
    class TimingAdapter extends FakeAdapter {
      async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
        const r = await super.invoke(inv);
        return { ...r, durationMs: 123, exitCode: 0 };
      }
    }
    const a = new TimingAdapter('claude', 'replay');
    const d = new Delegate(lookupOf(a), store, noopExecutor);
    const r = await d.run({ adapter: 'claude', prompt: 'x' });
    expect(r.durationMs).toBe(123);
    expect(r.exitCode).toBe(0);
  });
});
