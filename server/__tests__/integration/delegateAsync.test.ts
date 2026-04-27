/**
 * Integration test: delegate({async: true}) lifecycle (R4-D).
 *
 * Drives the Delegate + LocalInProcessTaskExecutor through a fire-and-forget
 * flow with a fake adapter (replay strategy) and the in-memory FsTaskStore.
 *
 * - sync path (async: false default) returns DelegateResponse — unchanged.
 * - async path (async: true) returns AsyncDelegateResponse with taskId.
 * - poll via taskExecutor.get; block via taskExecutor.result.
 * - cancel mid-flight on async delegate works.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Delegate } from '../../src/delegate/delegate.js';
import type { AdapterLookup } from '../../src/delegate/delegate.js';
import { LocalInProcessTaskExecutor } from '../../src/exec/localInProcessTaskExecutor.js';
import { FsTaskStore } from '../../src/stores/fsTaskStore.js';
import { JsonlThreadStore } from '../../src/stores/jsonlThreadStore.js';
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
  readonly invocations: AdapterInvocation[] = [];
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
  tmpThreads = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-async-threads-'));
  tmpTasks = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-async-tasks-'));
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

function buildDelegate(adapter: Adapter) {
  const lookup: AdapterLookup = {
    get: (id) => (id === adapter.id ? adapter : undefined),
    list: () => [adapter],
  };
  const taskStore = new FsTaskStore({ rootDir: tmpTasks });
  const threadStore = new JsonlThreadStore({ rootDir: tmpThreads });
  const taskExecutor = new LocalInProcessTaskExecutor({
    adapters: lookup,
    executor: noopExec,
    taskStore,
    threadStore,
  });
  const delegate = new Delegate(lookup, threadStore, noopExec, undefined, taskExecutor);
  return { delegate, taskExecutor, taskStore, threadStore };
}

describe('delegate async mode (v2.2)', () => {
  it('async: true returns {taskId, status: "working"} immediately', async () => {
    let resolveAdapter: (r: AdapterResult) => void = () => {};
    const slow = new FakeAdapter(
      'fake',
      () => new Promise<AdapterResult>((res) => (resolveAdapter = res))
    );
    const { delegate, taskExecutor } = buildDelegate(slow);
    const r = await delegate.runAsync({
      adapter: 'fake',
      prompt: 'do the thing',
    });
    expect(r.taskId).toBeTruthy();
    expect(r.status).toBe('working');
    expect(r.adapter).toBe('fake');

    const polled = await taskExecutor.get(r.taskId);
    expect(polled.status).toBe('working');

    resolveAdapter({
      text: 'all done',
      sessionId: 's',
      raw: null,
      exitCode: 0,
      durationMs: 1,
    });
    const final = await taskExecutor.result(r.taskId);
    expect(final.status).toBe('completed');
    expect(final.result?.text).toBe('all done');
  });

  it('sync path is unchanged (async: false default)', async () => {
    const fake = new FakeAdapter(
      'fake',
      async () => ({ text: 'sync reply', sessionId: 's', raw: null, exitCode: 0, durationMs: 1 })
    );
    const { delegate } = buildDelegate(fake);
    const r = await delegate.run({ adapter: 'fake', prompt: 'sync call' });
    expect(r.output).toBe('sync reply');
    expect(r.threadId).toBeTruthy();
    expect(r.exitCode).toBe(0);
  });

  it('cancel mid-flight on async delegate works', async () => {
    const slow = new FakeAdapter(
      'fake',
      () => new Promise<AdapterResult>(() => {})
    );
    const { delegate, taskExecutor } = buildDelegate(slow);
    const r = await delegate.runAsync({ adapter: 'fake', prompt: 'p' });
    const cancelled = await taskExecutor.cancel(r.taskId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('idempotency: two async calls with the same key return the same taskId mid-flight', async () => {
    let resolveAdapter: (r: AdapterResult) => void = () => {};
    const slow = new FakeAdapter(
      'fake',
      () => new Promise<AdapterResult>((res) => (resolveAdapter = res))
    );
    const { delegate, taskExecutor } = buildDelegate(slow);
    const a = await delegate.runAsync({
      adapter: 'fake',
      prompt: 'p',
      idempotencyKey: 'IDK1',
    });
    const b = await delegate.runAsync({
      adapter: 'fake',
      prompt: 'p',
      idempotencyKey: 'IDK1',
    });
    expect(b.taskId).toBe(a.taskId);
    resolveAdapter({ text: 'X', sessionId: 's', raw: null, exitCode: 0, durationMs: 1 });
    await taskExecutor.result(a.taskId);
  });
});
