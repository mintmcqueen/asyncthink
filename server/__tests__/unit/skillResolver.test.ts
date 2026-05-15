import { describe, it, expect } from 'vitest';
import {
  resolveSkill,
  SkillNotFoundError,
  SkillAdapterMismatchError,
} from '../../src/skills/resolver.js';
import type { Skill, SkillRegistry } from '../../src/core/skillRegistry.js';
import type { AdapterManifest, ManifestRegistry } from '../../src/core/manifests.js';
import type { AuditEvent, AuditLog } from '../../src/core/auditLog.js';

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

  // v2.2 — credentials passthrough
  it('passes credentials from skill frontmatter through to ResolvedSkill', async () => {
    const reg = lookup([baseSkill({ name: 's', credentials: 'staging' })]);
    const r = await resolveSkill(reg, { skill: 's', callerPrompt: 'p' });
    expect(r.credentials).toBe('staging');
  });

  it('caller credentials override skill credentials', async () => {
    const reg = lookup([baseSkill({ name: 's', credentials: 'staging' })]);
    const r = await resolveSkill(reg, {
      skill: 's',
      callerPrompt: 'p',
      callerCredentials: 'production',
    });
    expect(r.credentials).toBe('production');
  });

  // v2.2 — successor-model substitution (R6b-D.2)
  function makeManifestRegistry(manifests: AdapterManifest[]): ManifestRegistry {
    return {
      async loadAll() {
        return manifests;
      },
      async get(id) {
        return manifests.find((m) => m.id === id);
      },
    };
  }
  const codexManifest: AdapterManifest = {
    id: 'codex',
    displayName: 'Codex',
    binary: 'codex',
    tiers: { high: 'gpt-5.5', med: 'gpt-5-codex', low: 'gpt-5-mini' },
    defaultTier: 'med',
    requiredEnv: [],
    defaultTimeoutMs: 1000,
  };

  it('skill-pinned model that is in current tiers passes through verbatim', async () => {
    const reg = lookup([
      baseSkill({ name: 's', model: 'gpt-5.5' }),
    ]);
    const r = await resolveSkill(
      reg,
      { skill: 's', callerPrompt: 'p' },
      { manifests: makeManifestRegistry([codexManifest]) }
    );
    expect(r.model).toBe('gpt-5.5');
    expect(r.substitutedFrom).toBeUndefined();
  });

  it('skill-pinned model NOT in current tiers triggers R6b-D.2 substitution', async () => {
    const reg = lookup([
      baseSkill({ name: 's', model: 'gpt-DEPRECATED' }),
    ]);
    const events: AuditEvent[] = [];
    const auditLog: AuditLog = {
      async record(e) {
        events.push(e);
      },
    };
    const warnings: string[] = [];
    const r = await resolveSkill(
      reg,
      { skill: 's', callerPrompt: 'p' },
      {
        manifests: makeManifestRegistry([codexManifest]),
        auditLog,
        stderr: (s) => warnings.push(s),
      }
    );
    expect(r.model).toBe('gpt-5-codex'); // codex defaultTier=med
    expect(r.substitutedFrom).toBe('gpt-DEPRECATED');
    expect(events.some((e) => e.kind === 'model.substitute')).toBe(true);
    expect(warnings.some((w) => w.includes('gpt-DEPRECATED'))).toBe(true);
  });

  it('caller raw model wins over skill pin (no substitution)', async () => {
    const reg = lookup([
      baseSkill({ name: 's', model: 'gpt-DEPRECATED' }),
    ]);
    const r = await resolveSkill(
      reg,
      { skill: 's', callerPrompt: 'p', callerModel: 'gpt-5.5' },
      { manifests: makeManifestRegistry([codexManifest]) }
    );
    expect(r.model).toBe('gpt-5.5');
    expect(r.substitutedFrom).toBeUndefined();
  });

  it('substitution does not fire without manifest registry', async () => {
    const reg = lookup([
      baseSkill({ name: 's', model: 'gpt-DEPRECATED' }),
    ]);
    const r = await resolveSkill(reg, { skill: 's', callerPrompt: 'p' });
    expect(r.model).toBe('gpt-DEPRECATED');
    expect(r.substitutedFrom).toBeUndefined();
  });
});
