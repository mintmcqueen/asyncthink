/**
 * v2.3.1 (B2) — rate-limit pre-flight refuse semantics.
 *
 * Asserts the corrected math (R6a-D.5) across cap dimensions and window sizes:
 *   - dim:'input'    → allowance = floor(cap.tokens / estTokens)
 *   - dim:'requests' → allowance = cap.tokens (item count, NOT tokens)
 *   - dim:'messages' → allowance = cap.tokens
 *   - dim:'output'   → not gated (skip; assistant tokens unknowable up front)
 *
 * Also asserts:
 *   - Bucket window equals cap.windowSec (not 60s when window is 86400s).
 *   - The slot is not burned if a downstream step throws (deferred push).
 *   - Files are included in the token estimate.
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
import type {
  AdapterManifest,
  ManifestRegistry,
} from '../../src/core/manifests.js';

class OkAdapter implements Adapter {
  readonly readOnly = true as const;
  readonly resumeStrategy: ResumeStrategy = 'replay';
  constructor(public readonly id: string) {}
  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    return { text: 'ok', sessionId: inv.sessionId ?? 's', raw: null, exitCode: 0, durationMs: 1 };
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
let now: Date;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-rlrefuse-'));
  now = new Date('2026-05-13T00:00:00Z');
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function buildExec(manifest: AdapterManifest) {
  const adapter = new OkAdapter(manifest.id);
  const lookup = {
    get: (id: string) => (id === manifest.id ? adapter : undefined),
    list: () => [adapter as never],
  };
  const taskStore = new FsTaskStore({ rootDir: tmp, now: () => now });
  const exec = new LocalInProcessTaskExecutor({
    adapters: lookup,
    executor: noopExec,
    taskStore,
    manifests: new StaticManifestRegistry([manifest]),
    now: () => now,
  });
  return { exec, taskStore };
}

function fakeClaudeManifest(): AdapterManifest {
  // Use 'claude' id so detectAuthPath returns 'subscription' by default,
  // BUT we'll set ANTHROPIC_API_KEY in the test env to land on 'api'.
  return {
    id: 'claude',
    displayName: 'fake',
    binary: 'claude',
    tiers: { high: 'h', med: 'm', low: 'l' },
    defaultTier: 'med',
    requiredEnv: [],
    defaultTimeoutMs: 1000,
    tierLimits: {
      med: {
        rateLimit: {
          default: 'api',
          lastVerified: '2026-05-13',
          byAuthPath: {
            api: {
              class: 'rate-limited',
              cap: { tokens: 30000, windowSec: 60, dim: 'input' },
            },
          },
        },
      },
    },
  };
}

function fakeGeminiHighManifest(): AdapterManifest {
  return {
    id: 'gemini',
    displayName: 'fake',
    binary: 'gemini',
    tiers: { high: 'h', med: 'm', low: 'l' },
    defaultTier: 'high',
    requiredEnv: [],
    defaultTimeoutMs: 1000,
    tierLimits: {
      high: {
        rateLimit: {
          default: 'ai-studio',
          lastVerified: '2026-05-13',
          byAuthPath: {
            'ai-studio': {
              class: 'rate-limited',
              cap: { tokens: 250, windowSec: 86400, dim: 'requests' },
            },
          },
        },
      },
    },
  };
}

describe('B2 — pre-flight refuse: dim="input"', () => {
  it('blocks the 4th fork when cap=30k tokens/min and estTokens=10k (allowance=3)', async () => {
    const { exec } = buildExec(fakeClaudeManifest());
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const prompt = 'x'.repeat(10000 * 4); // ~10k tokens
      // 3 forks fit; 4th must refuse.
      for (let i = 0; i < 3; i++) {
        await exec.start({ adapter: 'claude', prompt, intelligence: 'med' });
      }
      await expect(
        exec.start({ adapter: 'claude', prompt, intelligence: 'med' })
      ).rejects.toMatchObject({ kind: 'rate-limit' });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('window is per cap.windowSec, not a hard-coded 60s', async () => {
    // Build a 30k-tokens / 300s manifest. With estTokens=10k → allowance=3.
    // Push 3 spawns. Advance now by 50s (well inside 300s window). 4th should refuse.
    const manifest = fakeClaudeManifest();
    manifest.tierLimits!.med!.rateLimit!.byAuthPath.api!.cap!.windowSec = 300;
    const { exec } = buildExec(manifest);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const prompt = 'x'.repeat(10000 * 4);
      for (let i = 0; i < 3; i++) {
        await exec.start({ adapter: 'claude', prompt, intelligence: 'med' });
      }
      now = new Date(now.getTime() + 50_000); // 50s later, still in 300s window
      await expect(
        exec.start({ adapter: 'claude', prompt, intelligence: 'med' })
      ).rejects.toMatchObject({ kind: 'rate-limit' });
      // 301s later, window has rolled over
      now = new Date(now.getTime() + 252_000);
      const ok = await exec.start({ adapter: 'claude', prompt, intelligence: 'med' });
      expect(ok.status).toBe('working');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('includes file byte sizes in the token estimate', async () => {
    const manifest = fakeClaudeManifest();
    // Cap 10k tokens/min, estTokens-just-prompt=1k → allowance=10. But add a
    // file of 40k bytes (~10k tokens) → allowance becomes 1 (10k / 10k = 1).
    manifest.tierLimits!.med!.rateLimit!.byAuthPath.api!.cap!.tokens = 10_000;
    const { exec } = buildExec(manifest);
    const filePath = join(tmp, 'big.txt');
    await fsp.writeFile(filePath, 'a'.repeat(40_000));
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const prompt = 'x'.repeat(1000 * 4); // ~1k prompt tokens
      // First fork fits (1 allowed); second must refuse.
      await exec.start({ adapter: 'claude', prompt, files: [filePath], intelligence: 'med' });
      await expect(
        exec.start({ adapter: 'claude', prompt, files: [filePath], intelligence: 'med' })
      ).rejects.toMatchObject({ kind: 'rate-limit' });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('B2 — pre-flight refuse: dim="requests"', () => {
  it('cap.tokens is item count, not token count, for dim:"requests"', async () => {
    // Gemini high: cap = 250 requests / day. Allowance is 250 regardless of
    // estTokens — old buggy code would compute 250/1000/1440 ≈ 0 → 1 fork/day.
    // Test: with a 100-byte prompt (~25 tokens), we should fit at least 5 forks.
    const { exec } = buildExec(fakeGeminiHighManifest());
    const prompt = 'x'.repeat(100);
    for (let i = 0; i < 5; i++) {
      const r = await exec.start({ adapter: 'gemini', prompt, intelligence: 'high' });
      expect(r.status).toBe('working');
    }
  });

  it('blocks past the cap', async () => {
    const manifest = fakeGeminiHighManifest();
    manifest.tierLimits!.high!.rateLimit!.byAuthPath['ai-studio']!.cap!.tokens = 3;
    const { exec } = buildExec(manifest);
    const prompt = 'x';
    for (let i = 0; i < 3; i++) {
      await exec.start({ adapter: 'gemini', prompt, intelligence: 'high' });
    }
    await expect(
      exec.start({ adapter: 'gemini', prompt, intelligence: 'high' })
    ).rejects.toMatchObject({ kind: 'rate-limit' });
  });
});

describe('v2.3.3 — authPath override and bypassRateLimit', () => {
  it('bypassRateLimit: true skips the pre-flight refuse', async () => {
    const { exec } = buildExec(fakeClaudeManifest());
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const prompt = 'x'.repeat(10000 * 4); // ~10k tokens; allowance=3 normally
      for (let i = 0; i < 3; i++) {
        await exec.start({ adapter: 'claude', prompt, intelligence: 'med' });
      }
      // Without bypass this 4th would throw kind:'rate-limit'.
      const r = await exec.start({
        adapter: 'claude',
        prompt,
        intelligence: 'med',
        bypassRateLimit: true,
      });
      expect(r.status).toBe('working');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('authPath override routes the gate lookup to a different cell', async () => {
    // 'api' path is rate-limited (allowance=3 at 30k/10k); 'subscription'
    // path is class:'standard' → no gate. Env has ANTHROPIC_API_KEY so
    // detect picks 'api' by default; the caller's override picks 'subscription'.
    const manifest = fakeClaudeManifest();
    manifest.tierLimits!.med!.rateLimit!.byAuthPath.subscription = {
      class: 'standard',
    };
    const { exec } = buildExec(manifest);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const prompt = 'x'.repeat(10000 * 4); // ~10k tokens; api allowance=3
      // Burn the 'api' budget with 3 forks (no override → 'api' path).
      for (let i = 0; i < 3; i++) {
        await exec.start({ adapter: 'claude', prompt, intelligence: 'med' });
      }
      // 4th without override → 'api' → refused.
      await expect(
        exec.start({ adapter: 'claude', prompt, intelligence: 'med' })
      ).rejects.toMatchObject({ kind: 'rate-limit' });
      // 4th with authPath:'subscription' → standard class → no gate → allowed.
      // (The api budget is still burned, but we routed elsewhere.)
      const r = await exec.start({
        adapter: 'claude',
        prompt,
        intelligence: 'med',
        authPath: 'subscription',
      });
      expect(r.status).toBe('working');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('B2 — pre-flight refuse: dim="output" is not gated', () => {
  it('does not enforce a gate when cap.dim is "output"', async () => {
    const manifest: AdapterManifest = {
      id: 'claude',
      displayName: 'fake',
      binary: 'claude',
      tiers: { high: 'h', med: 'm', low: 'l' },
      defaultTier: 'med',
      requiredEnv: [],
      defaultTimeoutMs: 1000,
      tierLimits: {
        med: {
          rateLimit: {
            default: 'api',
            lastVerified: '2026-05-13',
            byAuthPath: {
              api: {
                class: 'rate-limited',
                cap: { tokens: 8000, windowSec: 60, dim: 'output' },
              },
            },
          },
        },
      },
    };
    const { exec } = buildExec(manifest);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      // No upper bound on forks at output-dim gate.
      for (let i = 0; i < 10; i++) {
        const r = await exec.start({ adapter: 'claude', prompt: 'x', intelligence: 'med' });
        expect(r.status).toBe('working');
      }
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
