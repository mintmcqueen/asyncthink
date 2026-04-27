/**
 * Unit tests for LocalInProcessTaskExecutor (v2.2 R3-D.1, R-DUR-D.*, R-CRED-D.2,
 * R6a-D.2).
 *
 * Tests cover lifecycle, idempotency, cancel, TTL, principal binding, cred-stub,
 * and pre-flight context check. Skill-pin substitution is tested separately in
 * skillResolver.test.ts.
 *
 * All tests are idempotent — each spawns its own fresh stores under tmpdir() and
 * tears down via afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FsTaskStore } from '../../src/stores/fsTaskStore.js';
import { LocalInProcessTaskExecutor } from '../../src/exec/localInProcessTaskExecutor.js';
import {
  CredentialsNotSupportedError,
  ContextLimitExceededError,
  TaskNotFoundError,
  TaskOwnerMismatchError,
} from '../../src/core/taskExecutor.js';
import type {
  Adapter,
  AdapterInvocation,
  AdapterResult,
  ResumeStrategy,
} from '../../src/core/adapter.js';
import type { Executor } from '../../src/core/executor.js';
import type {
  AdapterManifest,
  ManifestRegistry,
} from '../../src/core/manifests.js';

class FakeAdapter implements Adapter {
  readonly readOnly = true as const;
  readonly resumeStrategy: ResumeStrategy = 'replay';
  constructor(
    public readonly id: string,
    public readonly responder: (inv: AdapterInvocation) => Promise<AdapterResult> | AdapterResult
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

class StaticManifestRegistry implements ManifestRegistry {
  constructor(private readonly all: AdapterManifest[]) {}
  async loadAll(): Promise<AdapterManifest[]> {
    return this.all;
  }
  async get(id: string): Promise<AdapterManifest | undefined> {
    return this.all.find((m) => m.id === id);
  }
}

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-taskexec-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function buildExecutor(opts?: {
  adapters?: Adapter[];
  manifests?: ManifestRegistry;
  responder?: (inv: AdapterInvocation) => Promise<AdapterResult> | AdapterResult;
}) {
  const responder =
    opts?.responder ??
    (async (inv) => ({
      text: `reply:${inv.prompt}`,
      sessionId: inv.sessionId ?? 's',
      raw: null,
      exitCode: 0,
      durationMs: 1,
    }));
  const adapter = new FakeAdapter('claude', responder);
  const adapters = opts?.adapters ?? [adapter];
  const lookup = {
    get: (id: string) => adapters.find((a) => a.id === id),
    list: () => [...adapters],
  };
  const taskStore = new FsTaskStore({ rootDir: tmp });
  const exec = new LocalInProcessTaskExecutor({
    adapters: lookup,
    executor: noopExec,
    taskStore,
    manifests: opts?.manifests,
  });
  return { exec, taskStore, adapters };
}

describe('LocalInProcessTaskExecutor — start/get/result', () => {
  it('start returns a working state immediately and transitions to completed', async () => {
    let resolveAdapter: (r: AdapterResult) => void = () => {};
    const slow = new FakeAdapter(
      'claude',
      () => new Promise<AdapterResult>((res) => (resolveAdapter = res))
    );
    const { exec } = buildExecutor({ adapters: [slow] });
    const initial = await exec.start({ adapter: 'claude', prompt: 'hello' });
    expect(initial.status).toBe('working');
    expect(typeof initial.taskId).toBe('string');

    // Mid-flight get: still working.
    const mid = await exec.get(initial.taskId);
    expect(mid.status).toBe('working');

    // Resolve and verify terminal state.
    resolveAdapter({
      text: 'OK',
      sessionId: 's',
      raw: null,
      exitCode: 0,
      durationMs: 5,
    });
    const final = await exec.result(initial.taskId);
    expect(final.status).toBe('completed');
    expect(final.result?.text).toBe('OK');
  });

  it('result blocks until task is terminal', async () => {
    let resolveAdapter: (r: AdapterResult) => void = () => {};
    const slow = new FakeAdapter(
      'claude',
      () => new Promise<AdapterResult>((res) => (resolveAdapter = res))
    );
    const { exec } = buildExecutor({ adapters: [slow] });
    const s = await exec.start({ adapter: 'claude', prompt: 'p' });
    const resultPromise = exec.result(s.taskId);
    setTimeout(() => {
      resolveAdapter({ text: 'done', sessionId: 's', raw: null, exitCode: 0, durationMs: 1 });
    }, 25);
    const final = await resultPromise;
    expect(final.status).toBe('completed');
  });

  it('failed adapter invocations end up status=failed with error populated', async () => {
    const broken = new FakeAdapter('claude', () => {
      throw new Error('upstream blew up');
    });
    const { exec } = buildExecutor({ adapters: [broken] });
    const s = await exec.start({ adapter: 'claude', prompt: 'p' });
    const final = await exec.result(s.taskId);
    expect(final.status).toBe('failed');
    expect(final.error).toContain('upstream blew up');
  });
});

describe('LocalInProcessTaskExecutor — cancel', () => {
  it('cancel flips state to cancelled and returns immediately', async () => {
    const slow = new FakeAdapter(
      'claude',
      () => new Promise<AdapterResult>(() => {})
    );
    const { exec } = buildExecutor({ adapters: [slow] });
    const s = await exec.start({ adapter: 'claude', prompt: 'p' });
    expect(s.status).toBe('working');
    const cancelled = await exec.cancel(s.taskId);
    expect(cancelled.status).toBe('cancelled');
    const after = await exec.get(s.taskId);
    expect(after.status).toBe('cancelled');
  });

  it('cancel on a terminal task is a no-op', async () => {
    const { exec } = buildExecutor();
    const s = await exec.start({ adapter: 'claude', prompt: 'p' });
    const final = await exec.result(s.taskId);
    expect(final.status).toBe('completed');
    const r = await exec.cancel(s.taskId);
    expect(r.status).toBe('completed');
  });

  it('cancel on unknown task throws TaskNotFoundError', async () => {
    const { exec } = buildExecutor();
    await expect(exec.cancel('nope')).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe('LocalInProcessTaskExecutor — idempotency', () => {
  it('repeat start with same idempotencyKey returns the same in-flight task', async () => {
    let resolveAdapter: (r: AdapterResult) => void = () => {};
    const slow = new FakeAdapter(
      'claude',
      () => new Promise<AdapterResult>((res) => (resolveAdapter = res))
    );
    const { exec } = buildExecutor({ adapters: [slow] });
    const a = await exec.start({
      adapter: 'claude',
      prompt: 'p',
      idempotencyKey: 'KEY-A',
    });
    const b = await exec.start({
      adapter: 'claude',
      prompt: 'p',
      idempotencyKey: 'KEY-A',
    });
    expect(b.taskId).toBe(a.taskId);
    resolveAdapter({ text: 'X', sessionId: 's', raw: null, exitCode: 0, durationMs: 1 });
    await exec.result(a.taskId);
  });

  it('after terminal, same idempotencyKey spawns a fresh task', async () => {
    const { exec } = buildExecutor();
    const a = await exec.start({
      adapter: 'claude',
      prompt: 'p',
      idempotencyKey: 'KEY-B',
    });
    await exec.result(a.taskId);
    const b = await exec.start({
      adapter: 'claude',
      prompt: 'p',
      idempotencyKey: 'KEY-B',
    });
    expect(b.taskId).not.toBe(a.taskId);
  });

  it('different principals partition idempotency keys', async () => {
    let resolveA: (r: AdapterResult) => void = () => {};
    let resolveB: (r: AdapterResult) => void = () => {};
    let n = 0;
    const slow = new FakeAdapter(
      'claude',
      () =>
        new Promise<AdapterResult>((res) => {
          n++;
          if (n === 1) resolveA = res;
          else resolveB = res;
        })
    );
    const { exec } = buildExecutor({ adapters: [slow] });
    const a = await exec.start({
      adapter: 'claude',
      prompt: 'p',
      idempotencyKey: 'X',
      principal: 'alice',
    });
    const b = await exec.start({
      adapter: 'claude',
      prompt: 'p',
      idempotencyKey: 'X',
      principal: 'bob',
    });
    expect(a.taskId).not.toBe(b.taskId);
    resolveA({ text: 'A', sessionId: 's', raw: null, exitCode: 0, durationMs: 1 });
    resolveB({ text: 'B', sessionId: 's', raw: null, exitCode: 0, durationMs: 1 });
    await Promise.all([exec.result(a.taskId, 'alice'), exec.result(b.taskId, 'bob')]);
  });
});

describe('LocalInProcessTaskExecutor — credentials stub (R-CRED-D.2)', () => {
  it('rejects any non-default credentials profile', async () => {
    const { exec } = buildExecutor();
    await expect(
      exec.start({ adapter: 'claude', prompt: 'p', credentials: 'staging' })
    ).rejects.toBeInstanceOf(CredentialsNotSupportedError);
  });

  it('accepts the literal "default" profile', async () => {
    const { exec } = buildExecutor();
    const s = await exec.start({ adapter: 'claude', prompt: 'p', credentials: 'default' });
    expect(s.status).toBe('working');
    await exec.result(s.taskId);
  });

  it('accepts an empty/undefined credentials field', async () => {
    const { exec } = buildExecutor();
    const s = await exec.start({ adapter: 'claude', prompt: 'p' });
    expect(s.status).toBe('working');
    await exec.result(s.taskId);
  });
});

describe('LocalInProcessTaskExecutor — pre-flight context check (R6a-D.2)', () => {
  it('rejects oversized prompts when manifest tier maxContext is set', async () => {
    const manifest: AdapterManifest = {
      id: 'claude',
      displayName: 'Claude',
      binary: 'claude',
      tiers: { high: 'h', med: 'm', low: 'l' },
      defaultTier: 'med',
      requiredEnv: [],
      defaultTimeoutMs: 1000,
      tierLimits: {
        high: { maxContext: 1000 },
        med: { maxContext: 1000 },
        low: { maxContext: 1000 },
      },
    };
    const reg = new StaticManifestRegistry([manifest]);
    const { exec } = buildExecutor({ manifests: reg });
    // 4 chars/token → 5000 chars ≈ 1250 tokens, exceeds 1000.
    const huge = 'x'.repeat(5000);
    await expect(
      exec.start({ adapter: 'claude', prompt: huge, intelligence: 'med' })
    ).rejects.toBeInstanceOf(ContextLimitExceededError);
  });

  it('passes when prompt is well under the limit', async () => {
    const manifest: AdapterManifest = {
      id: 'claude',
      displayName: 'Claude',
      binary: 'claude',
      tiers: { high: 'h', med: 'm', low: 'l' },
      defaultTier: 'med',
      requiredEnv: [],
      defaultTimeoutMs: 1000,
      tierLimits: { med: { maxContext: 100_000 } },
    };
    const reg = new StaticManifestRegistry([manifest]);
    const { exec } = buildExecutor({ manifests: reg });
    const s = await exec.start({ adapter: 'claude', prompt: 'hi', intelligence: 'med' });
    expect(s.status).toBe('working');
    await exec.result(s.taskId);
  });

  it('skips check when manifest provides no tierLimits', async () => {
    const manifest: AdapterManifest = {
      id: 'claude',
      displayName: 'Claude',
      binary: 'claude',
      tiers: { high: 'h', med: 'm', low: 'l' },
      defaultTier: 'med',
      requiredEnv: [],
      defaultTimeoutMs: 1000,
    };
    const reg = new StaticManifestRegistry([manifest]);
    const { exec } = buildExecutor({ manifests: reg });
    const huge = 'x'.repeat(5000);
    const s = await exec.start({ adapter: 'claude', prompt: huge });
    expect(s.status).toBe('working');
    await exec.result(s.taskId);
  });
});

describe('LocalInProcessTaskExecutor — principal binding (R-DUR-D.2)', () => {
  it('rejects cross-principal get/result/cancel', async () => {
    const { exec } = buildExecutor();
    const s = await exec.start({ adapter: 'claude', prompt: 'p', principal: 'alice' });
    await expect(exec.get(s.taskId, 'bob')).rejects.toBeInstanceOf(TaskOwnerMismatchError);
    await expect(exec.result(s.taskId, 'bob')).rejects.toBeInstanceOf(TaskOwnerMismatchError);
    await expect(exec.cancel(s.taskId, 'bob')).rejects.toBeInstanceOf(TaskOwnerMismatchError);
    await exec.result(s.taskId, 'alice');
  });

  it('null principal acts as v2.2 single-tenant local', async () => {
    const { exec } = buildExecutor();
    const s = await exec.start({ adapter: 'claude', prompt: 'p' });
    const got = await exec.get(s.taskId, null);
    expect(got.taskId).toBe(s.taskId);
    await exec.result(s.taskId);
  });
});

describe('LocalInProcessTaskExecutor — list', () => {
  it('lists tasks; cursor pagination yields nextCursor when over limit', async () => {
    const { exec } = buildExecutor();
    for (let i = 0; i < 5; i++) {
      await exec.start({ adapter: 'claude', prompt: `p${i}` });
    }
    // Wait briefly for tasks to settle (fake adapter resolves immediately).
    await new Promise((res) => setTimeout(res, 20));
    const page1 = await exec.list({ limit: 2 });
    expect(page1.tasks.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await exec.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.tasks.length).toBe(2);
  });

  it('list is principal-bound: tasks owned by other principals are filtered out', async () => {
    const { exec } = buildExecutor();
    await exec.start({ adapter: 'claude', prompt: 'a', principal: 'alice' });
    await exec.start({ adapter: 'claude', prompt: 'b', principal: 'bob' });
    await new Promise((res) => setTimeout(res, 20));
    const aliceList = await exec.list({ principal: 'alice' });
    expect(aliceList.tasks.every((t) => t.principal === 'alice')).toBe(true);
    expect(aliceList.tasks.length).toBe(1);
  });
});

describe('LocalInProcessTaskExecutor — TTL sweep (R-DUR-D.4)', () => {
  it('sweepIdle reaps tasks whose lastUpdatedAt exceeds the category TTL', async () => {
    // Use a controlled clock by writing into the fsTaskStore directly so we can simulate aged tasks.
    const taskStore = new FsTaskStore({
      rootDir: tmp,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await taskStore.create('taskA', 'old completed');
    await taskStore.update('taskA', { status: 'completed' });
    // Bump the clock 2 hours forward and call cleanupStale. Completed TTL is 60m.
    const future = new Date('2026-01-01T02:00:00Z');
    Object.defineProperty(taskStore, 'now', { value: () => future });
    const reaped = await taskStore.cleanupStale();
    expect(reaped).toContain('taskA');
  });

  it('failed tasks reaped after 10m, cancelled after 5m', async () => {
    const taskStore = new FsTaskStore({
      rootDir: tmp,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await taskStore.create('failTask', 'fail');
    await taskStore.update('failTask', { status: 'failed' });
    await taskStore.create('cancelTask', 'cancel');
    await taskStore.update('cancelTask', { status: 'cancelled' });

    // 6 minutes later: cancelled (5m TTL) should be reaped; failed (10m) not yet.
    Object.defineProperty(taskStore, 'now', {
      value: () => new Date('2026-01-01T00:06:00Z'),
    });
    const r1 = await taskStore.cleanupStale();
    expect(r1).toContain('cancelTask');
    expect(r1).not.toContain('failTask');

    // 11 minutes later: failed should be reaped too.
    Object.defineProperty(taskStore, 'now', {
      value: () => new Date('2026-01-01T00:11:00Z'),
    });
    const r2 = await taskStore.cleanupStale();
    expect(r2).toContain('failTask');
  });

  it('working tasks survive past short ages but reap at 60m', async () => {
    const taskStore = new FsTaskStore({
      rootDir: tmp,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await taskStore.create('workTask', 'work');
    await taskStore.update('workTask', { status: 'working' });
    Object.defineProperty(taskStore, 'now', {
      value: () => new Date('2026-01-01T00:30:00Z'),
    });
    const r1 = await taskStore.cleanupStale();
    expect(r1).not.toContain('workTask');
    Object.defineProperty(taskStore, 'now', {
      value: () => new Date('2026-01-01T01:01:00Z'),
    });
    const r2 = await taskStore.cleanupStale();
    expect(r2).toContain('workTask');
  });
});
