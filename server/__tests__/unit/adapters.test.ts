import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/impl/claude.js';
import { GeminiAdapter } from '../../src/adapters/impl/gemini.js';
import { CodexAdapter } from '../../src/adapters/impl/codex.js';
import { AdapterRegistry } from '../../src/adapters/index.js';
import { RecordingExecutor } from '../_helpers/recordingExecutor.js';

describe('ClaudeAdapter', () => {
  it('emits --print with the prompt as the final arg', async () => {
    const a = new ClaudeAdapter();
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'PING', cwd: '/work' }, exec);
    expect(exec.calls[0].bin).toBe('claude');
    expect(exec.calls[0].argv[0]).toBe('--print');
    expect(exec.calls[0].argv).toContain('PING');
  });

  it('raw model override wins over default tier', async () => {
    const a = new ClaudeAdapter();
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'p', model: 'claude-override' }, exec);
    const argv = exec.calls[0].argv;
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-override');
  });

  it('intelligence tier resolves to the matching model id', async () => {
    const a = new ClaudeAdapter({
      tiers: { high: 'claude-h', med: 'claude-m', low: 'claude-l' },
      defaultTier: 'med',
    });
    const exec = new RecordingExecutor([
      { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
      { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
      { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
    ]);
    await a.invoke({ prompt: 'p', intelligence: 'high' }, exec);
    await a.invoke({ prompt: 'p', intelligence: 'low' }, exec);
    await a.invoke({ prompt: 'p' }, exec); // default = med
    const modelOf = (i: number) =>
      exec.calls[i].argv[exec.calls[i].argv.indexOf('--model') + 1];
    expect(modelOf(0)).toBe('claude-h');
    expect(modelOf(1)).toBe('claude-l');
    expect(modelOf(2)).toBe('claude-m');
  });

  it('raw model wins over intelligence tier when they agree (no conflict)', async () => {
    const a = new ClaudeAdapter({
      tiers: { high: 'h', med: 'm', low: 'l' },
      defaultTier: 'med',
    });
    const exec = new RecordingExecutor();
    // intelligence: 'high' resolves to 'h' which equals model='h' — same id, allowed.
    await a.invoke({ prompt: 'p', intelligence: 'high', model: 'h' }, exec);
    const argv = exec.calls[0].argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('h');
  });

  it('throws TierModelConflictError when intelligence and model disagree (F1)', async () => {
    const a = new ClaudeAdapter({
      tiers: { high: 'h', med: 'm', low: 'l' },
      defaultTier: 'med',
    });
    const exec = new RecordingExecutor();
    await expect(
      a.invoke({ prompt: 'p', intelligence: 'low', model: 'h' }, exec)
    ).rejects.toThrow(/Conflicting model selection.*intelligence="low".*model="h"/);
  });

  it('error message names the resolved tier model so caller can fix it', async () => {
    const a = new ClaudeAdapter({
      tiers: { high: 'opus', med: 'sonnet', low: 'haiku' },
      defaultTier: 'med',
    });
    const exec = new RecordingExecutor();
    let err: Error | undefined;
    try {
      await a.invoke({ prompt: 'p', intelligence: 'low', model: 'opus' }, exec);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain('"haiku"');
    expect(err?.message).toContain('"opus"');
  });

  it('prepends a Files header when files are supplied', async () => {
    const a = new ClaudeAdapter();
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'analyze', files: ['/a.ts', '/b.ts'] }, exec);
    const promptArg = exec.calls[0].argv[exec.calls[0].argv.length - 1];
    expect(promptArg).toContain('Files available for review');
    expect(promptArg).toContain('/a.ts');
    expect(promptArg).toContain('/b.ts');
    expect(promptArg).toContain('analyze');
  });

  it('echoes inv.sessionId back unchanged (replay strategy)', async () => {
    const a = new ClaudeAdapter();
    const exec = new RecordingExecutor();
    const out = await a.invoke({ prompt: 'p', sessionId: 'thread-7' }, exec);
    expect(out.sessionId).toBe('thread-7');
  });
});

describe('GeminiAdapter', () => {
  it('emits -p, --output-format json, --approval-mode plan, --skip-trust, -m', async () => {
    const a = new GeminiAdapter({
      tiers: { high: 'gh', med: 'gemini-default', low: 'gl' },
      defaultTier: 'med',
    });
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'PING' }, exec);
    const argv = exec.calls[0].argv;
    expect(exec.calls[0].bin).toBe('gemini');
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('PING');
    expect(argv).toContain('--output-format');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
    expect(argv).toContain('--approval-mode');
    expect(argv[argv.indexOf('--approval-mode') + 1]).toBe('plan');
    expect(argv).toContain('--skip-trust');
    expect(argv).toContain('-m');
    expect(argv[argv.indexOf('-m') + 1]).toBe('gemini-default');
  });

  it('intelligence tier picks the matching gemini model id', async () => {
    const a = new GeminiAdapter({
      tiers: { high: 'gh', med: 'gm', low: 'gl' },
      defaultTier: 'med',
    });
    const exec = new RecordingExecutor([
      { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
      { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
    ]);
    await a.invoke({ prompt: 'p', intelligence: 'high' }, exec);
    await a.invoke({ prompt: 'p', intelligence: 'low' }, exec);
    expect(exec.calls[0].argv[exec.calls[0].argv.indexOf('-m') + 1]).toBe('gh');
    expect(exec.calls[1].argv[exec.calls[1].argv.indexOf('-m') + 1]).toBe('gl');
  });

  it('passes unique parent directories via --include-directories', async () => {
    const a = new GeminiAdapter();
    const exec = new RecordingExecutor();
    await a.invoke(
      {
        prompt: 'p',
        files: ['/proj/src/a.ts', '/proj/src/b.ts', '/proj/docs/x.md'],
      },
      exec
    );
    const argv = exec.calls[0].argv;
    expect(argv).toContain('--include-directories');
    const dirs = argv[argv.indexOf('--include-directories') + 1];
    expect(dirs.split(',').sort()).toEqual(['/proj/docs', '/proj/src']);
  });

  it('omits --include-directories when no files', async () => {
    const a = new GeminiAdapter();
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'p' }, exec);
    expect(exec.calls[0].argv).not.toContain('--include-directories');
  });

  it('parses gemini json {response: "..."} into text', async () => {
    const a = new GeminiAdapter();
    const exec = new RecordingExecutor([
      { stdout: JSON.stringify({ response: 'PONG' }), stderr: '', exitCode: 0, durationMs: 1 },
    ]);
    const out = await a.invoke({ prompt: 'PING' }, exec);
    expect(out.text).toBe('PONG');
  });

  it('extracts response field even when stdout is preceded by noise (F2)', async () => {
    const a = new GeminiAdapter();
    const noisyStdout =
      'MCP issues detected. Run /mcp list for status.' + JSON.stringify({ response: 'PONG' });
    const exec = new RecordingExecutor([
      { stdout: noisyStdout, stderr: '', exitCode: 0, durationMs: 1 },
    ]);
    const out = await a.invoke({ prompt: 'PING' }, exec);
    expect(out.text).toBe('PONG');
  });

  it('returns empty when stdout is operational noise without JSON (F2)', async () => {
    const a = new GeminiAdapter();
    const exec = new RecordingExecutor([
      {
        stdout: 'MCP issues detected. Run /mcp list for status.',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      },
    ]);
    const out = await a.invoke({ prompt: 'PING' }, exec);
    expect(out.text).toBe('');
  });

  it('handles JSON with nested braces and escaped strings (F2)', async () => {
    const a = new GeminiAdapter();
    const payload = JSON.stringify({
      response: 'inner has } and {nested}',
      stats: { models: { 'g-pro': { latencyMs: 100 } } },
    });
    const exec = new RecordingExecutor([
      { stdout: 'noise prefix...' + payload, stderr: '', exitCode: 0, durationMs: 1 },
    ]);
    const out = await a.invoke({ prompt: 'PING' }, exec);
    expect(out.text).toBe('inner has } and {nested}');
  });

  it('surfaces gemini error.message as structured error string (F2)', async () => {
    const a = new GeminiAdapter();
    const exec = new RecordingExecutor([
      {
        stdout: JSON.stringify({ error: { message: 'API quota exceeded' } }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      },
    ]);
    const out = await a.invoke({ prompt: 'PING' }, exec);
    expect(out.text).toBe('[gemini error] API quota exceeded');
  });
});

describe('CodexAdapter', () => {
  it('emits exec subcommand and read-only sandbox flags on first turn', async () => {
    const a = new CodexAdapter({
      tiers: { high: 'gh', med: 'gpt-default', low: 'gl' },
      defaultTier: 'med',
    });
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'PING', cwd: '/proj' }, exec);
    const argv = exec.calls[0].argv;
    expect(exec.calls[0].bin).toBe('codex');
    expect(argv[0]).toBe('exec');
    expect(argv).not.toContain('resume');
    expect(argv).toContain('--sandbox');
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
    // v0.47 dropped --ask-for-approval; sandbox mode governs approval.
    expect(argv).not.toContain('--ask-for-approval');
    expect(argv).toContain('--json');
    expect(argv).toContain('--skip-git-repo-check');
    expect(argv).toContain('--color');
    expect(argv[argv.indexOf('--color') + 1]).toBe('never');
    expect(argv).toContain('--cd');
    expect(argv[argv.indexOf('--cd') + 1]).toBe('/proj');
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-default');
    expect(argv[argv.length - 1]).toBe('PING');
  });

  it('intelligence tier picks the matching codex model id', async () => {
    const a = new CodexAdapter({
      tiers: { high: 'gpt-h', med: 'gpt-m', low: 'gpt-l' },
      defaultTier: 'high',
    });
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'p' }, exec); // default = high
    expect(
      exec.calls[0].argv[exec.calls[0].argv.indexOf('--model') + 1]
    ).toBe('gpt-h');
  });

  it('inserts "resume <sessionId>" after exec when sessionId is provided', async () => {
    const a = new CodexAdapter();
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'follow up', sessionId: 'codex-sess-42' }, exec);
    const argv = exec.calls[0].argv;
    expect(argv[0]).toBe('exec');
    expect(argv[1]).toBe('resume');
    expect(argv[2]).toBe('codex-sess-42');
  });

  it('inlines files as XML-fenced context blocks at top of prompt', async () => {
    const a = new CodexAdapter();
    const exec = new RecordingExecutor();
    await a.invoke({ prompt: 'analyze', files: ['/proj/a.ts', '/proj/b.ts'] }, exec);
    const promptArg = exec.calls[0].argv[exec.calls[0].argv.length - 1];
    expect(promptArg).toContain('<context>');
    expect(promptArg).toContain('<file path="/proj/a.ts">');
    expect(promptArg).toContain('<file path="/proj/b.ts">');
    expect(promptArg).toContain('</context>');
    expect(promptArg).toContain('analyze');
  });

  it('extracts thread id from thread.started event and exposes it as result.sessionId', async () => {
    const a = new CodexAdapter();
    const stream = [
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-real-id' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'PONG' }),
    ].join('\n');
    const exec = new RecordingExecutor([
      { stdout: stream, stderr: '', exitCode: 0, durationMs: 1 },
    ]);
    const out = await a.invoke({ prompt: 'PING' }, exec);
    expect(out.sessionId).toBe('codex-real-id');
  });

  it('falls back to inv.sessionId when stream has no session id', async () => {
    const a = new CodexAdapter();
    const exec = new RecordingExecutor([
      { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
    ]);
    const out = await a.invoke({ prompt: 'p', sessionId: 'fallback' }, exec);
    expect(out.sessionId).toBe('fallback');
  });
});

describe('AdapterRegistry', () => {
  it('withDefaults() registers claude, gemini, codex', () => {
    const r = AdapterRegistry.withDefaults();
    expect(r.list().map((a) => a.id).sort()).toEqual(['claude', 'codex', 'gemini']);
  });

  it('all built-in adapters declare readOnly: true', () => {
    const r = AdapterRegistry.withDefaults();
    for (const a of r.list()) expect(a.readOnly).toBe(true);
  });

  it('returns undefined for unknown id', () => {
    const r = AdapterRegistry.withDefaults();
    expect(r.get('llama-cli')).toBeUndefined();
  });
});
