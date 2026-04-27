/**
 * Unit tests for tierResolver (v2.2 R6a-D.2 + R6b-D.2 entry points).
 *
 * resolveModel covers conflict detection (existing v2.1.1 F1) and the new
 * substituteStaleSkillPin opt-in (R6b-D.2). checkContextLimit covers the
 * pre-flight check used by LocalInProcessTaskExecutor.start.
 */

import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveModel,
  checkContextLimit,
  TierModelConflictError,
} from '../../src/adapters/tierResolver.js';
import { ContextLimitExceededError } from '../../src/core/taskExecutor.js';
import type { IntelligenceTier } from '../../src/core/manifests.js';

const claudeTiers: Record<IntelligenceTier, string> = {
  high: 'claude-sonnet-4-6',
  med: 'claude-sonnet-4-6',
  low: 'claude-haiku-4-5',
};

describe('resolveModel', () => {
  it('returns the tier model when only intelligence is set', () => {
    const r = resolveModel({ prompt: 'p', intelligence: 'low' }, claudeTiers, 'med');
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.tier).toBe('low');
  });

  it('returns the defaultTier model when nothing is set', () => {
    const r = resolveModel({ prompt: 'p' }, claudeTiers, 'med');
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.tier).toBe('med');
  });

  it('raw model passes through verbatim (escape hatch)', () => {
    const r = resolveModel({ prompt: 'p', model: 'claude-experimental' }, claudeTiers, 'med');
    expect(r.model).toBe('claude-experimental');
  });

  it('throws TierModelConflictError when tier and model disagree', () => {
    expect(() =>
      resolveModel({ prompt: 'p', intelligence: 'low', model: 'claude-sonnet-4-6' }, claudeTiers, 'med')
    ).toThrow(TierModelConflictError);
  });

  it('matching tier+model is allowed', () => {
    const r = resolveModel(
      { prompt: 'p', intelligence: 'low', model: 'claude-haiku-4-5' },
      claudeTiers,
      'med'
    );
    expect(r.model).toBe('claude-haiku-4-5');
  });

  // R6b-D.2 — successor substitution opt-in
  describe('substituteStaleSkillPin opt-in (R6b-D.2)', () => {
    it('substitutes defaultTier model when raw model is not in current tiers', () => {
      const warnings: string[] = [];
      const r = resolveModel(
        { prompt: 'p', model: 'claude-DEPRECATED' },
        claudeTiers,
        'med',
        { substituteStaleSkillPin: true, stderr: (s) => warnings.push(s) }
      );
      expect(r.model).toBe('claude-sonnet-4-6');
      expect(r.substitutedFrom).toBe('claude-DEPRECATED');
      expect(warnings.some((w) => w.includes('claude-DEPRECATED'))).toBe(true);
    });

    it('current tier model passes through (no substitution)', () => {
      const r = resolveModel(
        { prompt: 'p', model: 'claude-haiku-4-5' },
        claudeTiers,
        'med',
        { substituteStaleSkillPin: true }
      );
      expect(r.model).toBe('claude-haiku-4-5');
      expect(r.substitutedFrom).toBeUndefined();
    });

    it('without opt-in, out-of-tier raw model passes through verbatim', () => {
      const r = resolveModel(
        { prompt: 'p', model: 'claude-NEW' },
        claudeTiers,
        'med'
      );
      expect(r.model).toBe('claude-NEW');
      expect(r.substitutedFrom).toBeUndefined();
    });

    it('opt-in is ignored when intelligence is supplied alongside model', () => {
      // Conflict detection still runs first.
      expect(() =>
        resolveModel(
          { prompt: 'p', intelligence: 'low', model: 'claude-NEW' },
          claudeTiers,
          'med',
          { substituteStaleSkillPin: true }
        )
      ).toThrow(TierModelConflictError);
    });
  });

  // R6a-D.2 — pre-flight context check
  describe('checkContextLimit', () => {
    it('throws ContextLimitExceededError when prompt exceeds maxContext', async () => {
      const huge = 'x'.repeat(5000);
      await expect(
        checkContextLimit({ prompt: huge }, 'med', 'claude', { maxContext: 1000 })
      ).rejects.toBeInstanceOf(ContextLimitExceededError);
    });

    it('passes when prompt is well under maxContext', async () => {
      await expect(
        checkContextLimit({ prompt: 'tiny' }, 'med', 'claude', { maxContext: 1000 })
      ).resolves.toBeUndefined();
    });

    it('no-op when limits/maxContext are undefined', async () => {
      const huge = 'x'.repeat(5000);
      await expect(
        checkContextLimit({ prompt: huge }, 'med', 'claude', undefined)
      ).resolves.toBeUndefined();
    });

    it('counts file byte sizes toward the budget', async () => {
      const tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-tier-'));
      try {
        const fpath = join(tmp, 'big.txt');
        await fsp.writeFile(fpath, 'a'.repeat(8000), 'utf8');
        await expect(
          checkContextLimit({ prompt: 'p', files: [fpath] }, 'med', 'claude', {
            maxContext: 1000,
          })
        ).rejects.toBeInstanceOf(ContextLimitExceededError);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
