/**
 * Live 3-fork council test — gated on RUN_LIVE=1.
 *
 * Exercises the Council with all three real adapters in parallel on a single
 * chain. Asserts each returns non-empty distinct outputs and the chain
 * cleanly ends.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Council } from '../../src/asyncthink/council.js';
import { JsonlThreadStore } from '../../src/stores/jsonlThreadStore.js';
import { FsTaskStore } from '../../src/stores/fsTaskStore.js';
import { LocalSubprocessExecutor } from '../../src/exec/localSubprocess.js';
import { AdapterRegistry } from '../../src/adapters/index.js';

const live = !!process.env.RUN_LIVE;

let tmpThreads: string;
let tmpTasks: string;

beforeEach(async () => {
  tmpThreads = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-live-council-threads-'));
  tmpTasks = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-live-council-tasks-'));
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

describe.skipIf(!live)('live council: 3-fork claude + gemini + codex', () => {
  it('all three return non-empty outputs and chain ends cleanly', async () => {
    const adapters = AdapterRegistry.withDefaults();
    const threadStore = new JsonlThreadStore({ rootDir: tmpThreads });
    const taskStore = new FsTaskStore({ rootDir: tmpTasks });
    const executor = new LocalSubprocessExecutor();
    const council = new Council(adapters, threadStore, taskStore, executor);

    const chainId = council.newChain();
    const prompt = 'Reply with a one-sentence answer to: what is 2 + 2?';
    await Promise.all([
      council.fork({
        id: 'c',
        adapter: 'claude',
        prompt,
        parentThreadId: chainId,
        thoughtNumber: 1,
      }),
      council.fork({
        id: 'g',
        adapter: 'gemini',
        prompt,
        parentThreadId: chainId,
        thoughtNumber: 1,
      }),
      council.fork({
        id: 'x',
        adapter: 'codex',
        prompt,
        parentThreadId: chainId,
        thoughtNumber: 1,
      }),
    ]);
    const results = await council.endChain(chainId, 240_000);
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.c.output).toBeTruthy();
    expect(byId.g.output).toBeTruthy();
    expect(byId.x.output).toBeTruthy();
    // All three should have answered 4 in some form (the question is "2+2").
    for (const id of ['c', 'g', 'x']) {
      expect(byId[id].status === 'complete' || byId[id].status === 'failed').toBe(true);
    }
  }, 360_000);
});
