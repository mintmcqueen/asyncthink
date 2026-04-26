import { describe, it, expect } from 'vitest';
import {
  resolveSkill,
  SkillNotFoundError,
  SkillAdapterMismatchError,
} from '../../src/skills/resolver.js';
import type { Skill, SkillRegistry } from '../../src/core/skillRegistry.js';

function lookup(skills: Skill[]): SkillRegistry {
  const m = new Map(skills.map((s) => [s.name, s]));
  return {
    list: async () => [...m.values()],
    get: async (name) => m.get(name),
    reload: async () => undefined,
  };
}

const baseSkill = (overrides: Partial<Skill> = {}): Skill => ({
  name: 's',
  adapter: 'codex',
  description: 'd',
  promptBody: 'You are a critic.',
  source: 'plugin',
  ...overrides,
});

describe('resolveSkill', () => {
  it('returns adapter, prompt prefix + caller prompt, and skill defaults', async () => {
    const reg = lookup([
      baseSkill({
        name: 'review',
        promptBody: 'Critic preamble.',
        model: 'gpt-default',
        timeoutMs: 12345,
      }),
    ]);
    const r = await resolveSkill(reg, {
      skill: 'review',
      callerPrompt: 'Look at this code.',
    });
    expect(r.adapter).toBe('codex');
    expect(r.prompt).toBe('Critic preamble.\n\n---\n\nLook at this code.');
    expect(r.model).toBe('gpt-default');
    expect(r.timeoutMs).toBe(12345);
  });

  it('caller model and timeout override skill defaults', async () => {
    const reg = lookup([
      baseSkill({
        name: 'review',
        model: 'gpt-default',
        timeoutMs: 60000,
      }),
    ]);
    const r = await resolveSkill(reg, {
      skill: 'review',
      callerPrompt: 'p',
      callerModel: 'gpt-override',
      callerTimeoutMs: 999,
    });
    expect(r.model).toBe('gpt-override');
    expect(r.timeoutMs).toBe(999);
  });

  it('errors when caller adapter conflicts with skill adapter', async () => {
    const reg = lookup([baseSkill({ name: 'review', adapter: 'codex' })]);
    await expect(
      resolveSkill(reg, {
        skill: 'review',
        callerPrompt: 'p',
        callerAdapter: 'gemini',
      })
    ).rejects.toBeInstanceOf(SkillAdapterMismatchError);
  });

  it('caller adapter that matches the skill is allowed', async () => {
    const reg = lookup([baseSkill({ name: 'review', adapter: 'codex' })]);
    const r = await resolveSkill(reg, {
      skill: 'review',
      callerPrompt: 'p',
      callerAdapter: 'codex',
    });
    expect(r.adapter).toBe('codex');
  });

  it('throws SkillNotFoundError for unknown skill', async () => {
    const reg = lookup([]);
    await expect(
      resolveSkill(reg, { skill: 'missing', callerPrompt: 'p' })
    ).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it('handles empty caller prompt or empty skill body', async () => {
    const reg1 = lookup([baseSkill({ name: 's', promptBody: 'preamble.' })]);
    expect((await resolveSkill(reg1, { skill: 's', callerPrompt: '' })).prompt).toBe('preamble.');
    const reg2 = lookup([baseSkill({ name: 's', promptBody: '' })]);
    expect((await resolveSkill(reg2, { skill: 's', callerPrompt: 'caller-only' })).prompt).toBe(
      'caller-only'
    );
  });
});
