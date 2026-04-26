import { describe, it, expect } from 'vitest';
import { LocalSubprocessExecutor } from '../../src/exec/localSubprocess.js';

const exec = new LocalSubprocessExecutor();

describe('LocalSubprocessExecutor', () => {
  it('captures stdout from a successful command', async () => {
    const r = await exec.run({
      bin: 'sh',
      argv: ['-c', 'echo hello'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
    expect(r.stderr).toBe('');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr separately from stdout', async () => {
    const r = await exec.run({
      bin: 'sh',
      argv: ['-c', 'echo out; echo err 1>&2'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
  });

  it('reports non-zero exit codes', async () => {
    const r = await exec.run({
      bin: 'sh',
      argv: ['-c', 'exit 42'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(42);
  });

  it('passes stdin to the subprocess', async () => {
    const r = await exec.run({
      bin: 'cat',
      argv: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      stdin: 'piped-payload',
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('piped-payload');
  });

  it('honors cwd', async () => {
    const r = await exec.run({
      bin: 'pwd',
      argv: [],
      cwd: '/tmp',
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(0);
    // macOS resolves /tmp to /private/tmp via a symlink
    expect(r.stdout.trim()).toMatch(/^(\/tmp|\/private\/tmp)$/);
  });

  it('exposes env to the subprocess', async () => {
    const r = await exec.run({
      bin: 'sh',
      argv: ['-c', 'echo "$ASYNCTHINK_PROBE"'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', ASYNCTHINK_PROBE: 'visible' },
      timeoutMs: 5_000,
    });
    expect(r.stdout.trim()).toBe('visible');
  });

  it('kills the subprocess tree on timeout', async () => {
    const start = Date.now();
    const r = await exec.run({
      bin: 'sh',
      argv: ['-c', 'sleep 30'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    // Should terminate within ~2s of timeout (200ms timeout + grace + signal time)
    expect(elapsed).toBeLessThan(3_000);
    expect(r.exitCode).not.toBe(0);
  });

  it('rejects if the binary does not exist', async () => {
    await expect(
      exec.run({
        bin: '/nonexistent/binary-asyncthink-test',
        argv: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 1_000,
      })
    ).rejects.toThrow();
  });
});
