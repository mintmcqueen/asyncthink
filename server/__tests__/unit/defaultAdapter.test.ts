/**
 * v2.5.1 — ASYNCTHINK_DEFAULT_ADAPTER env-var support.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDefaultAdapter,
  __resetDefaultAdapterCache,
} from '../../src/tools/defaultAdapter.js';

beforeEach(() => {
  __resetDefaultAdapterCache();
  delete process.env.ASYNCTHINK_DEFAULT_ADAPTER;
});

describe('getDefaultAdapter', () => {
  it('returns undefined when env var is unset', () => {
    expect(getDefaultAdapter()).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = '';
    expect(getDefaultAdapter()).toBeUndefined();
  });

  it('returns undefined for whitespace-only', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = '   ';
    expect(getDefaultAdapter()).toBeUndefined();
  });

  it('accepts "gemini"', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = 'gemini';
    expect(getDefaultAdapter()).toBe('gemini');
  });

  it('accepts "claude"', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = 'claude';
    expect(getDefaultAdapter()).toBe('claude');
  });

  it('accepts "codex"', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = 'codex';
    expect(getDefaultAdapter()).toBe('codex');
  });

  it('case-insensitive', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = 'GEMINI';
    expect(getDefaultAdapter()).toBe('gemini');
  });

  it('trims whitespace', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = '  gemini  ';
    expect(getDefaultAdapter()).toBe('gemini');
  });

  it('returns undefined for invalid values', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = 'opus';
    expect(getDefaultAdapter()).toBeUndefined();
  });

  it('caches first read', () => {
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = 'gemini';
    expect(getDefaultAdapter()).toBe('gemini');
    // Change after first read — should not be re-read until reset.
    process.env.ASYNCTHINK_DEFAULT_ADAPTER = 'claude';
    expect(getDefaultAdapter()).toBe('gemini');
    __resetDefaultAdapterCache();
    expect(getDefaultAdapter()).toBe('claude');
  });
});
