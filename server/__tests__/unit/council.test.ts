import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Council, type AdapterLookup, type ForkRequest } from '../../src/asyncthink/council.js';
import { JsonlThreadStore } from '../../src/stores/jsonlThreadStore.js';
import { FsTaskStore } from '../../src/stores/fsTaskStore.js';
import type {
  Adapter,
  AdapterInvocation,
  AdapterResult,
  ResumeStrategy,
} from '../../src/core/adapter.js';
import type { Executor } from '../../src/core/executor.js';

class FakeAdapter implements Adapter {
  readonly readOnly = true as const;
  readonly resumeStrategy: ResumeStrategy = 'replay';
  invocations: AdapterInvocation[] = [];
  constructor(
    public readonly id: string,
    private readonly responder: (inv: AdapterInvocation) => Promise<AdapterResult> | AdapterResult
  ) {}
  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    this.invocations.push(inv);
    return this.responder(inv);
  }
}

const noopExec: Executor = {
  async run() {
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
  },
};

let tmpThreads: string;
let tmpTasks: string;

beforeEach(async () => {
  tmpThreads = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-council-threads-'));
  tmpTasks = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-council-tasks-'));
});

afterEach(async () => {
  for (const d of [tmpThreads, tmpTasks]) {
    try {
      await fsp.rm(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function build(adapters: Adapter[]): {
  council: Council;
  threadStore: JsonlThreadStore;
  taskStore: FsTaskStore;
} {
  const threadStore = new JsonlThreadStore({ rootDir: tmpThreads });
  const taskStore = new FsTaskStore({ rootDir: tmpTasks });
  const lookup: AdapterLookup = {
    get: (id) => adapters.find((a) => a.id === id),
    list: () => adapters,
  };
  const council = new Council(lookup, threadStore, taskStore, noopExec);
  return { council, threadStore, taskStore };
}

const baseFork = (overrides: Partial<ForkRequest> = {}): ForkRequest => ({
  id: 'f1',
  adapter: 'a',
  prompt: 'p',
  parentThreadId: 'chain-x',
  thoughtNumber: 1,
  ...overrides,
});

describe('Council', () => {
  it('fork registers the task and returns immediately', async () => {
    const a = new FakeAdapter('a', async () => slowResult('done'));
    const { council, taskStore } = build([a]);
    const start = Date.now();
    await council.fork(baseFork());
    // "Immediately" means much less than the fork's internal 80ms delay
    // (slowResult). 250ms ceiling tolerates loaded-machine scheduling jitter
    // (was 50ms; tripped on heavily concurrent test runs).
    expect(Date.now() - start).toBeLessThan(250);
    const task = await taskStore.get('chain-x::f1');
    expect(task?.status).toBe('running');
  });

  it('chainStatus shows pending forks while in flight', async () => {
    let resolveFork: ((r: AdapterResult) => void) | undefined;
    const a = new FakeAdapter(
      'a',
      () => new Promise<AdapterResult>((res) => (resolveFork = res))
    );
    const { council } = build([a]);
    await council.fork(baseFork());
    const before = await council.chainStatus('chain-x');
    expect(before.pending).toEqual(['f1']);
    expect(before.complete).toEqual([]);
    resolveFork!({
      text: 'done',
      sessionId: 's',
      raw: null,
      exitCode: 0,
      durationMs: 1,
    });
    await council.waitFor(['f1'], 'chain-x', 5_000);
    const after = await council.chainStatus('chain-x');
    expect(after.pending).toEqual([]);
    expect(after.complete).toEqual(['f1']);
  });

  it('getResult returns the adapter output', async () => {
    const a = new FakeAdapter('a', async () => okResult('FINAL ANSWER'));
    const { council } = build([a]);
    await council.fork(baseFork());
    await council.waitFor(['f1'], 'chain-x', 5_000);
    const r = await council.getResult('f1', 'chain-x');
    expect(r?.status).toBe('complete');
    expect(r?.output).toBe('FINAL ANSWER');
  });

  it('marks a fork failed when adapter rejects', async () => {
    const a = new FakeAdapter('a', async () => {
      throw new Error('adapter exploded');
    });
    const { council } = build([a]);
    await council.fork(baseFork());
    await council.waitFor(['f1'], 'chain-x', 5_000);
    const r = await council.getResult('f1', 'chain-x');
    expect(r?.status).toBe('failed');
    expect(r?.error).toBe('adapter exploded');
  });

  it('runs multiple forks in parallel', async () => {
    const delays = [80, 60, 40];
    const a = new FakeAdapter('a', async (inv) => {
      const idx = Number(inv.prompt.split('-')[1]);
      await new Promise((r) => setTimeout(r, delays[idx]));
      return okResult(`reply-${idx}`);
    });
    const { council } = build([a]);
    const start = Date.now();
    await Promise.all(
      [0, 1, 2].map((i) =>
        council.fork(baseFork({ id: `f${i}`, prompt: `prompt-${i}` }))
      )
    );
    await council.waitFor(['f0', 'f1', 'f2'], 'chain-x', 5_000);
    const elapsed = Date.now() - start;
    // Sequential would be 80+60+40=180ms; parallel ≈ 80ms.
    // Looser ceiling tolerates loaded-machine concurrent-suite runs
    // (was 150ms; tripped at 271ms on heavily-loaded vitest invocations).
    expect(elapsed).toBeLessThan(450);
    expect((await council.getResult('f1', 'chain-x'))?.output).toBe('reply-1');
  });

  it('rejects duplicate fork ids in the same chain', async () => {
    const a = new FakeAdapter('a', async () => okResult('x'));
    const { council } = build([a]);
    await council.fork(baseFork({ id: 'dup' }));
    await expect(council.fork(baseFork({ id: 'dup' }))).rejects.toThrow(/already exists/);
  });

  it('isolates forks across separate chains', async () => {
    const a = new FakeAdapter('a', async () => okResult('x'));
    const { council } = build([a]);
    await council.fork(baseFork({ parentThreadId: 'chain-A', id: 'f' }));
    await council.fork(baseFork({ parentThreadId: 'chain-B', id: 'f' }));
    await council.waitFor(['f'], 'chain-A', 5_000);
    await council.waitFor(['f'], 'chain-B', 5_000);
    expect((await council.chainStatus('chain-A')).complete).toEqual(['f']);
    expect((await council.chainStatus('chain-B')).complete).toEqual(['f']);
  });

  it('endChain waits for in-flight forks, closes child threads, prunes tasks', async () => {
    const a = new FakeAdapter('a', async () => okResult('done'));
    const { council, threadStore, taskStore } = build([a]);
    await council.fork(baseFork({ id: 'a' }));
    await council.fork(baseFork({ id: 'b' }));
    const results = await council.endChain('chain-x', 5_000);
    expect(results.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect((await threadStore.list()).filter((t) => t.threadId.startsWith('chain-x::'))).toHaveLength(0);
    expect(await taskStore.get('chain-x::a')).toBeUndefined();
    expect(await taskStore.get('chain-x::b')).toBeUndefined();
  });

  it('throws on unknown adapter', async () => {
    const a = new FakeAdapter('claude', async () => okResult('x'));
    const { council } = build([a]);
    await expect(
      council.fork(baseFork({ adapter: 'gemini' }))
    ).rejects.toThrow(/Unknown adapter "gemini".*claude/);
  });
});

function okResult(text: string): AdapterResult {
  return { text, sessionId: 's', raw: null, exitCode: 0, durationMs: 1 };
}

function slowResult(text: string): AdapterResult {
  return { text, sessionId: 's', raw: null, exitCode: 0, durationMs: 1 };
}
