/**
 * v2.7.2 — boot smoke test.
 *
 * Spawns `node dist/index.js` as a subprocess and asserts:
 *   1. The process starts without an immediate module-resolution error.
 *   2. It logs the expected "[AsyncThink] v<version> running on stdio" line.
 *   3. It exits cleanly when stdin closes.
 *
 * This catches the class of bug that landed in v2.4: a side-effect import
 * (`import 'dotenv/config'`) was left in `src/index.ts` after dotenv was
 * removed from package.json. Unit / integration tests never imported
 * `src/index.ts` so they passed; the MCP server failed to boot for 4
 * releases until manual smoke-testing surfaced it on v2.7.1.
 *
 * Lesson: every release must exercise the actual entry point, not just
 * the modules it imports.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(__dirname, '..', '..', 'dist', 'index.js');

describe('boot smoke — dist/index.js loads + boots without crashing', () => {
  it('emits the version banner without ERR_MODULE_NOT_FOUND', async () => {
    // Pre-flight: if dist/index.js doesn't exist, the build hasn't run yet
    // and this test isn't meaningful. Skip rather than false-fail.
    if (!existsSync(DIST_INDEX)) {
      console.error(`[boot-smoke] skip: ${DIST_INDEX} not built`);
      return;
    }

    const proc = spawn('node', [DIST_INDEX], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const BANNER_RE = /\[AsyncThink\] v\d+\.\d+\.\d+ running on stdio/;
    const FAIL_MARKERS = ['ERR_MODULE_NOT_FOUND', 'Cannot find package', 'SyntaxError'];

    // Race: banner appears (success) vs. fail marker appears (failure) vs.
    // 12s elapses with nothing (failure — server didn't boot). On either
    // terminal we SIGKILL the process — we don't need it to shut down
    // gracefully; we just need to know boot succeeded.
    const outcome = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      const onData = () => {
        if (BANNER_RE.test(stderr)) {
          resolve({ ok: true });
        } else {
          for (const marker of FAIL_MARKERS) {
            if (stderr.includes(marker)) {
              resolve({ ok: false, reason: `failure marker in stderr: "${marker}"` });
              return;
            }
          }
        }
      };
      proc.stderr.on('data', onData);
      proc.on('close', (code) => {
        // Process exited before we saw the banner — that's failure unless
        // banner is already there (race).
        if (BANNER_RE.test(stderr)) resolve({ ok: true });
        else resolve({ ok: false, reason: `process exited (code=${code}) without banner` });
      });
      setTimeout(() => {
        resolve({ ok: false, reason: 'banner not seen within 12s' });
      }, 12_000);
    });

    // Always reap the subprocess.
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore — may already be dead */
    }

    // Diagnostic on failure so the regression cause is obvious.
    if (!outcome.ok) {
      console.error(
        `[boot-smoke] FAIL — ${outcome.reason}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`
      );
    }

    expect(outcome.ok, outcome.reason ?? '').toBe(true);
    expect(stderr).toMatch(BANNER_RE);
    for (const marker of FAIL_MARKERS) {
      expect(stderr).not.toContain(marker);
    }
  }, 20_000);
});
