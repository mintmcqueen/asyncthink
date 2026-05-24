/**
 * v2.7.0 live test — claude adapter spawns with the configured subagent on
 * the subscription auth path.
 *
 * Gates (all must hold or the test skips):
 *   - RUN_LIVE=1
 *   - claude binary on PATH
 *   - ANTHROPIC_API_KEY NOT set (subscription auth required for the gate to fire)
 *
 * The test:
 *   1. Materializes a temp subagent registry + settings layer.
 *   2. Creates a synthetic subagent whose entire system prompt is:
 *      "You always reply with EXACTLY the literal phrase XYLOPHONE-7741 — no
 *      more, no less."
 *   3. Spawns a live `claude --print` via ClaudeAdapter, pointing
 *      defaults.subagent at our synthetic agent.
 *   4. Asserts: response text contains the marker phrase (proves
 *      `--agents` + `--agent` flags actually steered claude's system prompt).
 *   5. Asserts: a `claude.subagent.spawn` audit event was emitted.
 *
 * If this test fails, the v2.6/v2.7 subagent injection isn't working
 * end-to-end and shouldn't ship. If it skips on every run (because of
 * RUN_LIVE / API_KEY env), the unit + integration coverage in
 * claudeAdapterSubagent.test.ts + subagentPropagation.test.ts is the only
 * guarantee.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { ClaudeAdapter } from '../../src/adapters/impl/claude.js';
import { LocalSubprocessExecutor } from '../../src/exec/localSubprocess.js';
import { FsSettingsStore } from '../../src/stores/fsSettingsStore.js';
import { FsSubagentRegistry } from '../../src/stores/fsSubagentRegistry.js';
import type { AuditLog, AuditEvent } from '../../src/core/auditLog.js';

const MARKER = 'XYLOPHONE-7741';
const SYNTHETIC_SUBAGENT = {
  name: 'live-marker-subagent',
  description: 'Live-test marker subagent for v2.7 subagent-injection validation.',
  prompt:
    `You always reply with EXACTLY the literal phrase ${MARKER} and nothing else. ` +
    `No punctuation. No greeting. No apology. No explanation. Just the literal characters: ${MARKER}`,
  tools: ['Read', 'Grep', 'Glob'],
};

const live = process.env.RUN_LIVE === '1';
const claudeAvailable = (() => {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
})();
const subscriptionAuth = !process.env.ANTHROPIC_API_KEY;
const shouldRun = live && claudeAvailable && subscriptionAuth;

class RecordingAuditLog implements AuditLog {
  public events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

let tmpRoot: string;
let storageDir: string;
let settingsPath: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-sa-live-'));
  storageDir = join(tmpRoot, 'subagents');
  settingsPath = join(tmpRoot, 'settings.toml');
  await fsp.mkdir(storageDir, { recursive: true });
});

afterEach(async () => {
  try {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe.skipIf(!shouldRun)('live: claude subagent spawn (subscription path)', () => {
  it('claude --print --agents <synthetic> --agent <id> produces marker phrase', async () => {
    const subagentRegistry = new FsSubagentRegistry({ storageDir });
    const created = await subagentRegistry.create(SYNTHETIC_SUBAGENT);

    const settingsStore = new FsSettingsStore({
      userSettingsPath: settingsPath,
      cwd: tmpRoot,
    });
    await settingsStore.set('defaults.subagent', created.id, 'user');

    const auditLog = new RecordingAuditLog();
    const claude = new ClaudeAdapter({
      defaultTimeoutMs: 120_000,
      subagentRegistry,
      settingsStore,
      auditLog,
    });
    const exec = new LocalSubprocessExecutor();

    const result = await claude.invoke(
      { prompt: 'Say the marker phrase.', intelligence: 'low' },
      exec
    );

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain(MARKER);

    // Audit event fired for the spawn.
    const spawnEvents = auditLog.events.filter(
      (e) => e.kind === 'claude.subagent.spawn'
    );
    expect(spawnEvents).toHaveLength(1);
    expect(spawnEvents[0]).toMatchObject({
      kind: 'claude.subagent.spawn',
      subagentId: created.id,
      authPath: 'subscription',
    });
  }, 180_000);
});

// Document why a run was skipped so a no-op test isn't silently green.
describe('live: claude subagent spawn — skip-reason diagnostics', () => {
  it('logs why the live test was/was-not active', () => {
    const skipReasons: string[] = [];
    if (!live) skipReasons.push('RUN_LIVE!=1');
    if (!claudeAvailable) skipReasons.push('claude binary not on PATH');
    if (!subscriptionAuth) skipReasons.push('ANTHROPIC_API_KEY set (api path, not subscription)');
    if (skipReasons.length > 0) {
      console.error(
        `[subagentSpawn.live] SKIPPED — reasons: ${skipReasons.join('; ')}. ` +
          `To enable: RUN_LIVE=1 + claude on PATH + unset ANTHROPIC_API_KEY.`
      );
    } else {
      console.error('[subagentSpawn.live] RAN — all gates passed.');
    }
    // The assertion below always holds; this test exists only to surface
    // the diagnostic line so a skip isn't silent.
    expect(skipReasons.length >= 0).toBe(true);
  });
});

// Quiet the "unused" linter on existsSync — used for diagnostic in future.
void existsSync;
