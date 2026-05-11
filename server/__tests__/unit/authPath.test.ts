/**
 * Unit tests for detectAuthPath (R6a-D.4 supporting code).
 *
 * Pure-function tests over env permutations; no subprocess.
 */

import { describe, it, expect } from 'vitest';
import { detectAuthPath, authPathsFor } from '../../src/adapters/authPath.js';

describe('detectAuthPath — claude', () => {
  it('returns vertex when CLAUDE_CODE_USE_VERTEX=1', () => {
    expect(detectAuthPath('claude', { env: { CLAUDE_CODE_USE_VERTEX: '1' } })).toBe('vertex');
    expect(detectAuthPath('claude', { env: { CLAUDE_CODE_USE_VERTEX: 'true' } })).toBe('vertex');
  });

  it('returns bedrock when CLAUDE_CODE_USE_BEDROCK=1', () => {
    expect(detectAuthPath('claude', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } })).toBe('bedrock');
  });

  it('vertex wins over bedrock if both set (deterministic precedence)', () => {
    expect(
      detectAuthPath('claude', {
        env: { CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_BEDROCK: '1' },
      })
    ).toBe('vertex');
  });

  it('returns api when ANTHROPIC_API_KEY is present', () => {
    expect(detectAuthPath('claude', { env: { ANTHROPIC_API_KEY: 'sk-...' } })).toBe('api');
  });

  it('defaults to subscription with empty env', () => {
    expect(detectAuthPath('claude', { env: {} })).toBe('subscription');
  });
});

describe('detectAuthPath — gemini', () => {
  it('returns vertex when GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT', () => {
    expect(
      detectAuthPath('gemini', {
        env: { GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'my-proj' },
      })
    ).toBe('vertex');
  });

  it('returns ai-studio when GOOGLE_GENAI_USE_VERTEXAI set but no project', () => {
    expect(
      detectAuthPath('gemini', { env: { GOOGLE_GENAI_USE_VERTEXAI: 'true' } })
    ).toBe('ai-studio');
  });

  it('returns ai-studio by default', () => {
    expect(detectAuthPath('gemini', { env: { GEMINI_API_KEY: 'x' } })).toBe('ai-studio');
    expect(detectAuthPath('gemini', { env: {} })).toBe('ai-studio');
  });
});

describe('detectAuthPath — codex', () => {
  it('returns azure when OPENAI_API_KEY + AZURE_OPENAI_* env present', () => {
    expect(
      detectAuthPath('codex', {
        env: { OPENAI_API_KEY: 'x', AZURE_OPENAI_API_KEY: 'y' },
      })
    ).toBe('azure');
    expect(
      detectAuthPath('codex', {
        env: { OPENAI_API_KEY: 'x', AZURE_OPENAI_ENDPOINT: 'https://...' },
      })
    ).toBe('azure');
  });

  it('returns api when only OPENAI_API_KEY is present', () => {
    expect(detectAuthPath('codex', { env: { OPENAI_API_KEY: 'sk-...' } })).toBe('api');
  });

  it('defaults to subscription with empty env', () => {
    expect(detectAuthPath('codex', { env: {} })).toBe('subscription');
  });
});

describe('authPathsFor', () => {
  it('lists all paths an adapter may use', () => {
    expect(authPathsFor('claude')).toEqual(['subscription', 'api', 'vertex', 'bedrock']);
    expect(authPathsFor('gemini')).toEqual(['ai-studio', 'vertex']);
    expect(authPathsFor('codex')).toEqual(['subscription', 'api', 'azure']);
  });
});
