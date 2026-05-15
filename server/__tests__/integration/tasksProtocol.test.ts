/**
 * End-to-end integration test for the v2.2 Tasks tool surface.
 *
 * Builds a fresh LocalInProcessTaskExecutor over tmp dirs and exercises the
 * lifecycle through the same handler bodies that tasks.tool.ts wires:
 *   - tasks_get   → executor.get()
 *   - tasks_list  → executor.list() with cursor + limit
 *   - tasks_cancel → executor.cancel()
 *   - tasks_result → executor.result()
 *
 * This is the contract for the MCP Tasks RPC verbs as exposed via tools.
 * Booting the McpServer + StdioTransport adds nothing testable here — the
 * SDK just routes the JSONRPC into the same handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalInProcessTaskExecutor } from '../../src/exec/localInProcessTaskExecutor.js';
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
  constructor(
    public readonly id: string,
    private readonly responder: (inv: AdapterInvocation) => Promise<AdapterResult> | AdapterResult
  ) {}
  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    return this.responder(inv);
  }
}

const noopExec: Executor = {
  async run() {
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
  },
};

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-tasksproto-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function build(opts?: { responder?: (inv: AdapterInvocation) => Promise<AdapterResult> | AdapterResult }) {
  const responder = opts?.responder ??
    (async () => ({ text: 'OK', sessionId: 's', raw: null, exitCode: 0, durationMs: 1 }));
  const fake = new FakeAdapter('fake', responder);
  const lookup = {
    get: (id: string) => (id === 'fake' ? fake : undefined),
    list: () => [fake],
  };
  const taskStore = new FsTaskStore({ rootDir: tmp });
  const exec = new LocalInProcessTaskExecutor({
    adapters: lookup,
    executor: noopExec,
    taskStore,
  });
  return { exec, taskStore };
}

describe('Tasks tool surface end-to-end', () => {
  it('full lifecycle: start → get(working) → result(completed)', async () => {
    let resolveAdapter: (r: AdapterResult) => void = () => {};
    const { exec } = build({
      responder: () => new Promise<AdapterResult>((res) => (resolveAdapter = res)),
    });
    const created = await exec.start({ adapter: 'fake', prompt: 'p' });
    expect(created.status).toBe('working');

    const polled = await exec.get(created.taskId);
    expect(polled.status).toBe('working');

    resolveAdapter({ text: 'V2.2', sessionId: 's', raw: null, exitCode: 0, durationMs: 5 });
    const final = await exec.result(created.taskId);
    expect(final.status).toBe('completed');
    expect(final.result?.text).toBe('V2.2');
  });

  it('list paginates with cursor', async () => {
    const { exec } = build();
    for (let i = 0; i < 6; i++) {
      await exec.start({ adapter: 'fake', prompt: `p${i}` });
    }
    await new Promise((res) => setTimeout(res, 30));
    const p1 = await exec.list({ limit: 4 });
    expect(p1.tasks.length).toBe(4);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await exec.list({ limit: 4, cursor: p1.nextCursor });
    expect(p2.tasks.length).toBe(2);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('cancel flips state immediately and tasks_result returns cancelled', async () => {
    const { exec } = build({
      responder: () => new Promise<AdapterResult>(() => {}),
    });
    const created = await exec.start({ adapter: 'fake', prompt: 'p' });
    const cancelled = await exec.cancel(created.taskId);
    expect(cancelled.status).toBe('cancelled');
    const final = await exec.result(created.taskId);
    expect(final.status).toBe('cancelled');
  });

  it('list filters by principal', async () => {
    const { exec } = build();
    await exec.start({ adapter: 'fake', prompt: 'a' });
    await exec.start({ adapter: 'fake', prompt: 'b' });
    await new Promise((res) => setTimeout(res, 20));
    const noneList = await exec.list({ principal: 'no-one' });
    expect(noneList.tasks.length).toBe(0);
    const localList = await exec.list({ principal: null });
    expect(localList.tasks.length).toBe(2);
  });
});
