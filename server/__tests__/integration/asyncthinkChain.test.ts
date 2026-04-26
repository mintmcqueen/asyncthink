/**
 * End-to-end asyncthink chain integration test.
 *
 * Drives the Council + AsyncThinkingServer through a 4-thought scripted
 * session that mirrors what the MCP tool handler does (without booting the
 * MCP server). This is the acceptance spec for the asyncthink chain
 * lifecycle: open chain on first thought, spawn forks, collect on later
 * thought, auto-end on the final thought.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Council, type AdapterLookup } from '../../src/asyncthink/council.js';
import { AsyncThinkingServer } from '../../src/asyncthink/thinking.js';
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

let tmpThreads: string;
let tmpTasks: string;

beforeEach(async () => {
  tmpThreads = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-chain-threads-'));
  tmpTasks = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-chain-tasks-'));
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

describe('asyncthink chain lifecycle', () => {
  it('runs a 4-thought session: spawn at t2, collect at t3, end at t4', async () => {
    const claude = new FakeAdapter('claude', () => okResult('CLAUDE-VIEW'));
    const gemini = new FakeAdapter('gemini', () => okResult('GEMINI-VIEW'));
    const lookup: AdapterLookup = {
      get: (id) => (id === 'claude' ? claude : id === 'gemini' ? gemini : undefined),
      list: () => [claude, gemini],
    };
    const threadStore = new JsonlThreadStore({ rootDir: tmpThreads });
    const taskStore = new FsTaskStore({ rootDir: tmpTasks });
    const council = new Council(lookup, threadStore, taskStore, noopExec);
    const thinking = new AsyncThinkingServer();

    const chainId = council.newChain();

    // Thought 1: just thinking, no forks.
    thinking.processThought({
      thought: 'Begin reasoning about the problem.',
      thoughtNumber: 1,
      totalThoughts: 4,
      nextThoughtNeeded: true,
    });

    // Thought 2: spawn two forks.
    thinking.processThought({
      thought: 'Need second opinions; spawning council.',
      thoughtNumber: 2,
      totalThoughts: 4,
      nextThoughtNeeded: true,
    });
    await council.fork({
      id: 'claude-take',
      adapter: 'claude',
      prompt: 'What is your view?',
      parentThreadId: chainId,
      thoughtNumber: 2,
    });
    await council.fork({
      id: 'gemini-take',
      adapter: 'gemini',
      prompt: 'What is your view?',
      parentThreadId: chainId,
      thoughtNumber: 2,
    });
    // Synchronously-resolving fake adapters complete before this check, so
    // assert both forks are accounted for somewhere (pending or complete),
    // not specifically pending.
    const stat2 = await council.chainStatus(chainId);
    const allKnown2 = [...stat2.pending, ...stat2.complete, ...stat2.failed].sort();
    expect(allKnown2).toEqual(['claude-take', 'gemini-take']);

    // Thought 3: wait for forks, read results.
    thinking.processThought({
      thought: 'Collecting council responses.',
      thoughtNumber: 3,
      totalThoughts: 4,
      nextThoughtNeeded: true,
    });
    await council.waitFor(['claude-take', 'gemini-take'], chainId, 5_000);
    const r1 = await council.getResult('claude-take', chainId);
    const r2 = await council.getResult('gemini-take', chainId);
    expect(r1?.output).toBe('CLAUDE-VIEW');
    expect(r1?.adapter).toBe('claude');
    expect(r2?.output).toBe('GEMINI-VIEW');
    expect(r2?.adapter).toBe('gemini');

    // Thought 4: final, end chain.
    thinking.processThought({
      thought: 'Synthesis. Done.',
      thoughtNumber: 4,
      totalThoughts: 4,
      nextThoughtNeeded: false,
    });
    const endResults = await council.endChain(chainId, 5_000);
    expect(endResults.map((r) => r.id).sort()).toEqual(['claude-take', 'gemini-take']);
    // All child threads closed.
    const open = (await threadStore.list()).filter((t) =>
      t.threadId.startsWith(`${chainId}::`)
    );
    expect(open).toHaveLength(0);
    // Tasks pruned.
    expect(await taskStore.get(`${chainId}::claude-take`)).toBeUndefined();
  });

  it('captures fork failures into the chain status', async () => {
    const broken = new FakeAdapter('claude', async () => {
      throw new Error('upstream blew up');
    });
    const lookup: AdapterLookup = {
      get: () => broken,
      list: () => [broken],
    };
    const council = new Council(
      lookup,
      new JsonlThreadStore({ rootDir: tmpThreads }),
      new FsTaskStore({ rootDir: tmpTasks }),
      noopExec
    );
    const chainId = council.newChain();
    await council.fork({
      id: 'doomed',
      adapter: 'claude',
      prompt: 'p',
      parentThreadId: chainId,
      thoughtNumber: 1,
    });
    await council.waitFor(['doomed'], chainId, 5_000);
    const status = await council.chainStatus(chainId);
    expect(status.failed).toEqual(['doomed']);
    const r = await council.getResult('doomed', chainId);
    expect(r?.status).toBe('failed');
    expect(r?.error).toContain('upstream blew up');
  });

  it('endChain drains forks that are still in-flight at the time of the final thought', async () => {
    let resolveFork: ((r: AdapterResult) => void) | undefined;
    const slow = new FakeAdapter(
      'claude',
      () => new Promise<AdapterResult>((res) => (resolveFork = res))
    );
    const lookup: AdapterLookup = {
      get: () => slow,
      list: () => [slow],
    };
    const council = new Council(
      lookup,
      new JsonlThreadStore({ rootDir: tmpThreads }),
      new FsTaskStore({ rootDir: tmpTasks }),
      noopExec
    );
    const chainId = council.newChain();
    await council.fork({
      id: 'slowpoke',
      adapter: 'claude',
      prompt: 'p',
      parentThreadId: chainId,
      thoughtNumber: 1,
    });

    // Kick endChain in parallel; it should block until the fork resolves.
    const endPromise = council.endChain(chainId, 2_000);
    setTimeout(() => {
      resolveFork!({
        text: 'finally',
        sessionId: 's',
        raw: null,
        exitCode: 0,
        durationMs: 1,
      });
    }, 30);
    const results = await endPromise;
    expect(results.map((r) => r.id)).toEqual(['slowpoke']);
    expect(results[0].output).toBe('finally');
  });
});

function okResult(text: string): AdapterResult {
  return { text, sessionId: 's', raw: null, exitCode: 0, durationMs: 1 };
}
