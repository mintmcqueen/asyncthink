import { describe, it, expect } from 'vitest';
import {
  findSkillConflicts,
  formatSkillConflict,
} from '../../src/skills/conflictValidator.js';
import type { Skill } from '../../src/core/skillRegistry.js';
import type { AdapterManifest } from '../../src/core/manifests.js';

const manifest = (id: string, tiers: Record<'high' | 'med' | 'low', string>): AdapterManifest => ({
  id,
  displayName: id,
  binary: id,
  tiers,
  defaultTier: 'med',
  requiredEnv: [],
  defaultTimeoutMs: 60_000,
});

const skill = (overrides: Partial<Skill>): Skill => ({
  name: 'test-skill',
  adapter: 'claude',
  description: 'd',
  promptBody: 'b',
  source: 'plugin',
  ...overrides,
});

describe('findSkillConflicts (F1)', () => {
  const claude = manifest('claude', { high: 'opus', med: 'sonnet', low: 'haiku' });

  it('returns empty when no skills pin both intelligence and model', () => {
    const skills = [
      skill({ name: 'a', intelligence: 'high' }),
      skill({ name: 'b', model: 'sonnet' }),
      skill({ name: 'c' }), // neither
    ];
    expect(findSkillConflicts(skills, [claude])).toEqual([]);
  });

  it('returns empty when both are pinned and they agree', () => {
    const skills = [skill({ name: 'a', intelligence: 'high', model: 'opus' })];
    expect(findSkillConflicts(skills, [claude])).toEqual([]);
  });

  it('flags a conflict when both are pinned and disagree', () => {
    const skills = [skill({ name: 'rotten', intelligence: 'low', model: 'opus' })];
    const conflicts = findSkillConflicts(skills, [claude]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      skillName: 'rotten',
      adapter: 'claude',
      intelligence: 'low',
      pinnedModel: 'opus',
      tierModel: 'haiku',
    });
  });

  it('skips skills whose adapter is unknown (defer to runtime)', () => {
    const skills = [
      skill({ name: 'unknown-adapter', adapter: 'mystery', intelligence: 'high', model: 'x' }),
    ];
    expect(findSkillConflicts(skills, [claude])).toEqual([]);
  });

  it('formatSkillConflict emits a clear stderr-friendly message', () => {
    const msg = formatSkillConflict({
      skillName: 'rotten',
      adapter: 'claude',
      intelligence: 'low',
      pinnedModel: 'opus',
      tierModel: 'haiku',
    });
    expect(msg).toContain('rotten');
    expect(msg).toContain('claude');
    expect(msg).toContain('low');
    expect(msg).toContain('haiku');
    expect(msg).toContain('opus');
    expect(msg).toContain('TierModelConflictError');
  });
});
