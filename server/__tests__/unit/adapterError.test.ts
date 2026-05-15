/**
 * Unit tests for AdapterError envelope + per-adapter detectors.
 *
 * Covers R-DIAG-D.1 (envelope shape) and R-DIAG-D.2 (per-adapter detectors).
 * All cases use canned `AdapterErrorRaw` shapes that match real CLI output
 * captured during R4 research; no live subprocess.
 */

import { describe, it, expect } from 'vitest';
import {
  AdapterError,
  ContextLimitExceededError,
  detectClaudeError,
  detectGeminiError,
  detectCodexError,
  detectBinaryMissing,
} from '../../src/core/adapterError.js';

describe('AdapterError', () => {
  it('exposes kind, adapter, summary, actionable, raw, details', () => {
    const err = new AdapterError({
      kind: 'rate-limit',
      adapter: 'claude',
      model: 'claude-haiku-4-5',
      summary: 'rate-limited',
      actionable: 'wait',
      raw: { stdout: 'x', stderr: '', exitCode: 1 },
      details: { capTokens: 50000 },
    });
    expect(err.kind).toBe('rate-limit');
    expect(err.adapter).toBe('claude');
    expect(err.model).toBe('claude-haiku-4-5');
    expect(err.summary).toBe('rate-limited');
    expect(err.actionable).toBe('wait');
    expect(err.raw?.stdout).toBe('x');
    expect(err.details).toEqual({ capTokens: 50000 });
  });

  it('toJSON strips raw and preserves kind/adapter/summary/actionable/details', () => {
    const err = new AdapterError({
      kind: 'auth',
      adapter: 'codex',
      summary: 'not logged in',
      actionable: 'run codex login',
      raw: { stdout: 'big', stderr: 'noisy', exitCode: 1 },
    });
    const json = err.toJSON() as Record<string, unknown>;
    expect(json.kind).toBe('auth');
    expect(json.adapter).toBe('codex');
    expect(json.summary).toBe('not logged in');
    expect(json.actionable).toBe('run codex login');
    expect(json.raw).toBeUndefined();
  });
});

describe('ContextLimitExceededError', () => {
  it('is a subclass of AdapterError with kind=context', () => {
    const err = new ContextLimitExceededError({
      approxTokens: 250000,
      maxTokens: 200000,
      tier: 'high',
      adapter: 'claude',
    });
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.kind).toBe('context');
    expect(err.name).toBe('ContextLimitExceededError');
    expect(err.approxTokens).toBe(250000);
    expect(err.maxTokens).toBe(200000);
    expect(err.tier).toBe('high');
  });
});

describe('detectClaudeError', () => {
  it('detects rate-limit with parsed cap', () => {
    const err = detectClaudeError(
      {
        stdout:
          'Error: Rate limit reached for claude-haiku-4-5-20251001 in organization (TPM): Limit 50000\n',
        stderr: '',
        exitCode: 1,
      },
      'claude-haiku-4-5-20251001'
    );
    expect(err?.kind).toBe('rate-limit');
    expect(err?.details?.capTokens).toBe(50000);
  });

  it('detects auth via /login hint', () => {
    const err = detectClaudeError(
      { stdout: 'Invalid API key · Please run /login', stderr: '', exitCode: 1 },
      'sonnet'
    );
    expect(err?.kind).toBe('auth');
  });

  it('detects timeout from exitCode 124 + executor stderr marker', () => {
    const err = detectClaudeError(
      { stdout: '', stderr: '[timeout after 300000ms]', exitCode: 124 },
      'sonnet'
    );
    expect(err?.kind).toBe('timeout');
  });

  it('returns null on success-shaped output', () => {
    const err = detectClaudeError(
      { stdout: 'PONG', stderr: '', exitCode: 0 },
      'sonnet'
    );
    expect(err).toBeNull();
  });
});

describe('detectGeminiError', () => {
  it('detects auth via missing GEMINI_API_KEY on stderr JSON', () => {
    const stderr = JSON.stringify({
      session_id: 's',
      error: {
        type: 'Error',
        message:
          'When using Gemini API, you must specify the GEMINI_API_KEY environment variable.',
        code: 41,
      },
    });
    const err = detectGeminiError({ stdout: '', stderr, exitCode: 41 }, 'flash');
    expect(err?.kind).toBe('auth');
    expect(err?.actionable).toMatch(/GEMINI_API_KEY/);
  });

  it('detects auth via API_KEY_INVALID', () => {
    const stderr = JSON.stringify({
      error: { message: 'API key not valid. Please pass a valid API key.', code: 400 },
    });
    const err = detectGeminiError({ stdout: '', stderr, exitCode: 144 }, 'flash');
    expect(err?.kind).toBe('auth');
  });

  it('detects rate-limit via RESOURCE_EXHAUSTED', () => {
    const stderr = JSON.stringify({
      error: { message: 'RESOURCE_EXHAUSTED: Quota exceeded.', code: 429 },
    });
    const err = detectGeminiError({ stdout: '', stderr, exitCode: 1 }, 'flash');
    expect(err?.kind).toBe('rate-limit');
  });

  it('returns null on success', () => {
    const err = detectGeminiError(
      { stdout: '{"response":"PONG"}', stderr: '', exitCode: 0 },
      'flash'
    );
    expect(err).toBeNull();
  });
});

describe('detectCodexError', () => {
  it('detects 401 from NDJSON turn.failed line', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'turn.failed',
        error: {
          message:
            'unexpected status 401 Unauthorized: Missing bearer or basic authentication',
        },
      }),
    ].join('\n');
    const err = detectCodexError(
      { stdout, stderr: 'codex_api error', exitCode: 1 },
      'gpt-5-codex'
    );
    expect(err?.kind).toBe('auth');
  });

  it('detects 429 from NDJSON', () => {
    const stdout = JSON.stringify({
      type: 'error',
      message: 'HTTP 429 Too Many Requests',
    });
    const err = detectCodexError(
      { stdout, stderr: '', exitCode: 1 },
      'gpt-5-codex'
    );
    expect(err?.kind).toBe('rate-limit');
  });

  it('returns null on a stream with no error lines', () => {
    const stdout = JSON.stringify({ type: 'turn.completed', text: 'done' });
    const err = detectCodexError(
      { stdout, stderr: '', exitCode: 0 },
      'gpt-5-codex'
    );
    expect(err).toBeNull();
  });
});

describe('detectBinaryMissing', () => {
  it('detects ENOENT from a synthetic spawn error', () => {
    const fake = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const err = detectBinaryMissing(fake, 'claude', 'claude');
    expect(err?.kind).toBe('binary-missing');
    expect(err?.actionable).toMatch(/Install/);
  });

  it('returns null on unrelated errors', () => {
    expect(detectBinaryMissing(new Error('some other failure'), 'claude', 'claude')).toBeNull();
  });
});
