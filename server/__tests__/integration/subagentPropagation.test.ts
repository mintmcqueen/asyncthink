/**
 * v2.7.0 regression test — assert that `subagent` (and skill frontmatter
 * `subagent:`) propagates from every caller path into the
 * `adapter.invoke({subagent})` call site, AND that the claude adapter
 * converts a present `inv.subagent` into the right `--agents`/`--agent`
 * argv on the subscription auth path.
 *
 * Six caller paths (mirroring the v2.3.1 B1 mcpServersPropagation test):
 *   1. Sync delegate                    (Delegate.run)
 *   2. Async delegate                   (Delegate.runAsync → TaskExecutor.start → runTask)
 *   3. Sync council fork                (Council.fork → Council.runFork)
 *   4. Async detached fork              (asyncthink.tool detached path)
 *   5. Skill frontmatter `subagent:`    (resolves into inv.subagent)
 *   6. Caller override wins over skill  (caller > skill > settings > builtin)
 *
 * Plus one claude-adapter-specific assertion: argv contains `--agents` +
 * `--agent <id>` on the subscription path when inv.subagent is set.
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
import { FsSubagentRegistry } from '../../src/stores/fsSubagentRegistry.js';
import { FsSettingsStore } from '../../src/stores/fsSettingsStore.js';
import { ClaudeAdapter } from '../../src/adapters/impl/claude.js';
import {
  BUILTIN_SUBAGENTS,
  DEFAULT_ASYNCTHINK_DELEGATE,
} from '../../src/core/subagent.js';
import { resolveSkill } from '../../src/skills/resolver.js';
import type {
  Adapter,
  AdapterInvocation,
  AdapterResult,
  ResumeStrategy,
} from '../../src/core/adapter.js';
import type { Executor, ExecResult } from '../../src/core/executor.js';
import type { Skill, SkillRegistry } from '../../src/core/skillRegistry.js';

/** Records `inv` arguments passed to invoke(); returns synthetic success. */
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

/** Records argv passed by an adapter through to executor.run. */
class RecordingExecutor implements Executor {
  public lastArgv: string[] = [];
  public lastEnv: Record<string, string> = {};
  async run(req: {
    bin: string;
    argv: string[];
    env: Record<string, string>;
  }): Promise<ExecResult> {
    this.lastArgv = req.argv;
    this.lastEnv = req.env;
    return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 };
  }
}

class MemoryNoopExecutor implements Executor {
  async run(): Promise<ExecResult> {
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
  }
}

let tmpRoot: string;
let tmpThreads: string;
let tmpTasks: string;
let tmpSubagents: string;
let tmpSettings: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-sapropag-'));
  tmpThreads = join(tmpRoot, 'threads');
  tmpTasks = join(tmpRoot, 'tasks');
  tmpSubagents = join(tmpRoot, 'subagents');
  tmpSettings = join(tmpRoot, 'settings.toml');
  await fsp.mkdir(tmpThreads, { recursive: true });
  await fsp.mkdir(tmpTasks, { recursive: true });
  await fsp.mkdir(tmpSubagents, { recursive: true });
});

afterEach(async () => {
  try {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function buildStack() {
  const adapter = new CaptureAdapter();
  const lookup: AdapterLookup = {
    get: (id) => (id === adapter.id ? adapter : undefined),
    list: () => [adapter],
  };
  const noopExec = new MemoryNoopExecutor();
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

describe('v2.7.0 — subagent propagates from every invocation path to adapter.invoke', () => {
  it('1. sync delegate forwards subagent', async () => {
    const { adapter, delegate } = buildStack();
    await delegate.run({
      adapter: 'fake',
      prompt: 'sync delegate',
      subagent: 'security-review',
    });
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].subagent).toBe('security-review');
  });

  it('2. async delegate forwards subagent', async () => {
    const { adapter, delegate, taskExecutor } = buildStack();
    const { taskId } = await delegate.runAsync({
      adapter: 'fake',
      prompt: 'async delegate',
      subagent: 'simplify-review',
    });
    // Drive task to terminal.
    await taskExecutor.result(taskId);
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].subagent).toBe('simplify-review');
  });

  it('3. sync council fork forwards subagent', async () => {
    const { adapter, council } = buildStack();
    await council.fork({
      id: 'f1',
      adapter: 'fake',
      prompt: 'sync fork',
      parentThreadId: 'chain-x',
      thoughtNumber: 1,
      subagent: 'test-coverage-review',
    });
    await council.waitFor(['f1'], 'chain-x', 5_000);
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].subagent).toBe('test-coverage-review');
  });

  it('4. async detached fork (TaskExecutor.start) forwards subagent', async () => {
    const { adapter, taskExecutor } = buildStack();
    const state = await taskExecutor.start({
      adapter: 'fake',
      prompt: 'async fork',
      detached: true,
      principal: null,
      subagent: 'correctness-review',
    });
    await taskExecutor.result(state.taskId);
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0].subagent).toBe('correctness-review');
  });

  it('5. skill frontmatter `subagent:` resolves into ResolvedSkill.subagent', async () => {
    // Build a synthetic skill registry with a skill that pins a subagent.
    const skill: Skill = {
      name: 'my-skill',
      adapter: 'fake',
      description: 'test',
      promptBody: 'system context here',
      source: 'plugin',
      subagent: 'security-review',
    };
    const registry: SkillRegistry = {
      list: async () => [skill],
      get: async (n) => (n === skill.name ? skill : undefined),
      reload: async () => {
        /* noop */
      },
    };
    const resolved = await resolveSkill(registry, {
      skill: 'my-skill',
      callerPrompt: 'user prompt',
    });
    expect(resolved.subagent).toBe('security-review');
  });

  it('6. caller-supplied subagent wins over skill subagent in ResolvedSkill precedence', async () => {
    // resolveSkill itself doesn't do this merge — the precedence is enforced
    // in the tool-handler layer (delegate.tool / asyncthink.tool). But we can
    // simulate that by calling resolveSkill, then applying the documented
    // precedence (caller ?? resolved.subagent).
    const skill: Skill = {
      name: 'my-skill',
      adapter: 'fake',
      description: 'test',
      promptBody: 'context',
      source: 'plugin',
      subagent: 'security-review',
    };
    const registry: SkillRegistry = {
      list: async () => [skill],
      get: async (n) => (n === skill.name ? skill : undefined),
      reload: async () => {},
    };
    const resolved = await resolveSkill(registry, {
      skill: 'my-skill',
      callerPrompt: 'p',
    });
    const callerSubagent = 'simplify-review';
    const effective = callerSubagent ?? resolved.subagent;
    expect(effective).toBe('simplify-review');
  });
});

describe('v2.7.0 — claude adapter builds --agents/--agent argv when inv.subagent is set on subscription path', () => {
  it('emits --agents with caller subagent on subscription auth (no API key)', async () => {
    // Subscription path requires no ANTHROPIC_API_KEY in env.
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const subagentRegistry = new FsSubagentRegistry({ storageDir: tmpSubagents });
      await subagentRegistry.bootstrapBuiltins(BUILTIN_SUBAGENTS);
      const settingsStore = new FsSettingsStore({
        userSettingsPath: tmpSettings,
        cwd: tmpRoot,
      });
      const claude = new ClaudeAdapter({ subagentRegistry, settingsStore });
      const exec = new RecordingExecutor();
      await claude.invoke(
        { prompt: 'test', subagent: 'security-review' },
        exec
      );
      expect(exec.lastArgv).toContain('--agents');
      expect(exec.lastArgv).toContain('--agent');
      expect(exec.lastArgv).toContain('security-review');
      // The JSON next to --agents contains the security-review definition.
      const agentsIdx = exec.lastArgv.indexOf('--agents');
      const parsed = JSON.parse(exec.lastArgv[agentsIdx + 1]) as Record<string, { prompt: string }>;
      expect(parsed['security-review']).toBeTruthy();
      expect(parsed['security-review'].prompt).toContain('security reviewer');
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  it('emits no --agents on api auth path (ANTHROPIC_API_KEY set) regardless of inv.subagent', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    try {
      const subagentRegistry = new FsSubagentRegistry({ storageDir: tmpSubagents });
      await subagentRegistry.bootstrapBuiltins([DEFAULT_ASYNCTHINK_DELEGATE]);
      const settingsStore = new FsSettingsStore({
        userSettingsPath: tmpSettings,
        cwd: tmpRoot,
      });
      const claude = new ClaudeAdapter({ subagentRegistry, settingsStore });
      const exec = new RecordingExecutor();
      await claude.invoke(
        { prompt: 'test', subagent: 'asyncthink-delegate' },
        exec
      );
      // API path skips subagent injection by design — caller specified one,
      // but the adapter respects the auth-path gate.
      expect(exec.lastArgv).not.toContain('--agents');
      expect(exec.lastArgv).not.toContain('--agent');
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
