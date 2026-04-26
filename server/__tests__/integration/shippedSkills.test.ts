/**
 * Verifies that the three shipped skills load via the SkillRegistry's
 * production path-resolution.
 */

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FsSkillRegistry } from '../../src/stores/skillRegistry.js';

// __tests__/integration/shippedSkills.test.ts → up two = server/__tests__,
// up three = server/, up four = plugin root → skills/.
const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = join(dirname(__filename), '..', '..', '..');
const PLUGIN_SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

describe('shipped skills', () => {
  it('loads code-review, architecture-critique, and test-design from the plugin root', async () => {
    const reg = new FsSkillRegistry({
      pluginSkillsDir: PLUGIN_SKILLS_DIR,
      userSkillsDir: '/nonexistent/asyncthink-test-user',
    });
    const all = await reg.list();
    const ids = all.map((s) => s.name).sort();
    expect(ids).toEqual(['architecture-critique', 'code-review', 'test-design']);
  });

  it('each shipped skill points at a valid adapter id', async () => {
    const reg = new FsSkillRegistry({
      pluginSkillsDir: PLUGIN_SKILLS_DIR,
      userSkillsDir: '/nonexistent/asyncthink-test-user',
    });
    const valid = new Set(['claude', 'gemini', 'codex']);
    for (const s of await reg.list()) {
      expect(valid.has(s.adapter)).toBe(true);
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.promptBody.length).toBeGreaterThan(50);
    }
  });

  it('code-review uses codex; architecture-critique uses gemini; test-design uses claude', async () => {
    const reg = new FsSkillRegistry({
      pluginSkillsDir: PLUGIN_SKILLS_DIR,
      userSkillsDir: '/nonexistent/asyncthink-test-user',
    });
    expect((await reg.get('code-review'))?.adapter).toBe('codex');
    expect((await reg.get('architecture-critique'))?.adapter).toBe('gemini');
    expect((await reg.get('test-design'))?.adapter).toBe('claude');
  });
});
