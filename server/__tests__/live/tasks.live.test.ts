/**
 * Live tasks lifecycle test (RUN_LIVE=1 only).
 *
 * Spawns a real claude PONG via the LocalInProcessTaskExecutor and verifies
 * the task transitions through working → completed end-to-end against the
 * actual binary. Skipped by default; enable via RUN_LIVE=1.
 */

import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalInProcessTaskExecutor } from '../../src/exec/localInProcessTaskExecutor.js';
import { LocalSubprocessExecutor } from '../../src/exec/localSubprocess.js';
import { FsTaskStore } from '../../src/stores/fsTaskStore.js';
import { JsonlThreadStore } from '../../src/stores/jsonlThreadStore.js';
import { ClaudeAdapter } from '../../src/adapters/impl/claude.js';

const RUN_LIVE = process.env.RUN_LIVE === '1';

describe.skipIf(!RUN_LIVE)('tasks live (RUN_LIVE=1)', () => {
  it('claude task: start → poll → result', async () => {
    const tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-tasks-live-'));
    try {
      const claude = new ClaudeAdapter();
      const lookup = {
        get: (id: string) => (id === 'claude' ? claude : undefined),
        list: () => [claude as never],
      };
      const subExec = new LocalSubprocessExecutor();
      const taskStore = new FsTaskStore({ rootDir: tmp });
      const threadStore = new JsonlThreadStore({ rootDir: tmp });
      const exec = new LocalInProcessTaskExecutor({
        adapters: lookup,
        executor: subExec,
        taskStore,
        threadStore,
      });

      const created = await exec.start({
        adapter: 'claude',
        prompt: 'PING — reply with the single word PONG.',
        timeoutMs: 60_000,
      });
      expect(created.status).toBe('working');

      const final = await exec.result(created.taskId);
      expect(final.status).toBe('completed');
      expect(final.result?.text.toLowerCase()).toContain('pong');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 90_000);
});
