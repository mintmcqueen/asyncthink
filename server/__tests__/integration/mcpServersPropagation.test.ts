/**
 * v2.3.1 (B1) regression test — assert that `mcpServers` (and `mcp_servers`
 * from skill frontmatter) propagates from EVERY caller path into the
 * `adapter.invoke({mcpServers})` call site.
 *
 * Four invocation paths:
 *   1. Sync delegate  (Delegate.run)
 *   2. Async delegate (Delegate.runAsync → TaskExecutor.start → runTask)
 *   3. Sync fork      (Council.fork → Council.runFork)
 *   4. Async fork     (asyncthink.tool detached path → TaskExecutor.start → runTask)
 *
 * The bug being regressed: v2.3.0 only wired path #3. Paths #1, #2, #4 silently
 * dropped the field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { Council, type AdapterLookup } from '../../src/asyncthink/council.js';
import { Delegate } from '../../src/delegate/delegate.js';
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

class CaptureAdapter implements Adapter {
  readonly id = 'fake' as const;
  readonly readOnly = true as const;
  readonly resumeStrategy: ResumeStrategy = 'replay';
  readonly invocations: AdapterInvocation[] = [];
  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    this.invocations.push(inv);
    return { text: 'ok', sessionId: inv.sessionId ?? 's', raw: null, exitCode: 0, durationMs: 1 };
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
  tmpThreads = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-mcpprop-threads-'));
  tmpTasks = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-mcpprop-tasks-'));
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

function buildStack() {
  const adapter = new CaptureAdapter();
  const lookup: AdapterLookup = {
    get: (id) => (id === adapter.id ? adapter : undefined),
    list: () => [adapter],
  };
  const threadStore = new JsonlThreadStore({ rootDir: tmpThreads });
  const taskStore = new FsTaskStore({ rootDir: tmpTasks });
  const taskExecutor = new LocalInProcessTaskExecutor({
    adapters: lookup,
    executor: noopExec,
    taskStore,
    threadStore,
  });
  const delegate = new Delegate(lookup, threadStore, noopExec, undefined, taskExecutor);
  const council = new Council(lookup, threadStore, taskStore, noopExec);
  return { adapter, lookup, taskExecutor, delegate, council };
}

describe('v2.3.1 B1 — mcpServers propagates from every invocation path to adapter.invoke', () => {
  it('sync delegate forwards mcpServers', async () => {
    const { adapter, delegate } = buildStack();
    await delegate.run({
      adapter: 'fake',
      prompt: 'sync delegate',
      mcpServers: ['repo-rag', 'arxiv'],
    });
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].mcpServers).toEqual(['repo-rag', 'arxiv']);
  });

  it('async delegate forwards mcpServers', async () => {
    const { adapter, delegate, taskExecutor } = buildStack();
    const r = await delegate.runAsync({
      adapter: 'fake',
      prompt: 'async delegate',
      mcpServers: ['repo-rag'],
    });
    await taskExecutor.result(r.taskId);
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].mcpServers).toEqual(['repo-rag']);
  });

  it('sync council fork forwards mcpServers', async () => {
    const { adapter, council } = buildStack();
    const chainId = council.newChain();
    await council.fork({
      id: 'f1',
      adapter: 'fake',
      prompt: 'sync fork',
      parentThreadId: chainId,
      thoughtNumber: 1,
      mcpServers: ['repo-rag'],
    });
    await council.waitFor(['f1'], chainId, 5_000);
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].mcpServers).toEqual(['repo-rag']);
  });

  it('async fork via TaskExecutor forwards mcpServers', async () => {
    const { adapter, taskExecutor } = buildStack();
    const state = await taskExecutor.start({
      adapter: 'fake',
      prompt: 'async fork',
      detached: true,
      principal: null,
      mcpServers: ['arxiv'],
    });
    await taskExecutor.result(state.taskId);
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].mcpServers).toEqual(['arxiv']);
  });

  it('missing mcpServers becomes undefined at the adapter (no default fabrication at this layer)', async () => {
    const { adapter, delegate } = buildStack();
    await delegate.run({ adapter: 'fake', prompt: 'no servers' });
    expect(adapter.invocations[0].mcpServers).toBeUndefined();
  });
});
