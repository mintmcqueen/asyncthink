import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FsSkillRegistry, parseFrontmatter } from '../../src/stores/skillRegistry.js';

let pluginDir: string;
let userDir: string;

beforeEach(async () => {
  pluginDir = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-skills-plugin-'));
  userDir = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-skills-user-'));
});

afterEach(async () => {
  for (const d of [pluginDir, userDir]) {
    try {
      await fsp.rm(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function writeSkill(dir: string, name: string, frontmatter: string, body: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, 'SKILL.md');
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  return path;
}

function writeUserSkill(dir: string, name: string, frontmatter: string, body: string): string {
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  return path;
}

describe('parseFrontmatter', () => {
  it('extracts key/value pairs and body', () => {
    const r = parseFrontmatter('---\nadapter: codex\ndescription: x\n---\n\nbody text\n');
    expect(r?.frontmatter.adapter).toBe('codex');
    expect(r?.frontmatter.description).toBe('x');
    expect(r?.body.trim()).toBe('body text');
  });

  it('returns undefined when no frontmatter', () => {
    expect(parseFrontmatter('# just a doc\n')).toBeUndefined();
  });

  it('returns undefined for unterminated frontmatter', () => {
    expect(parseFrontmatter('---\nadapter: claude\nbody\n')).toBeUndefined();
  });

  it('parses integers and booleans as their types', () => {
    const r = parseFrontmatter(
      '---\ntimeout_ms: 240000\nactive: true\nratio: 1.5\n---\n\nbody'
    );
    expect(r?.frontmatter.timeout_ms).toBe(240000);
    expect(r?.frontmatter.active).toBe(true);
    expect(r?.frontmatter.ratio).toBe(1.5);
  });

  it('strips wrapping quotes on string values', () => {
    const r = parseFrontmatter('---\ndescription: "with quotes"\n---\n\n');
    expect(r?.frontmatter.description).toBe('with quotes');
  });

  it('skips comment and blank lines in frontmatter', () => {
    const r = parseFrontmatter(
      '---\n# header comment\n\nadapter: codex\ndescription: x\n---\n\n'
    );
    expect(r?.frontmatter.adapter).toBe('codex');
  });
});

describe('FsSkillRegistry', () => {
  it('loads plugin and user skills with full metadata', async () => {
    writeSkill(
      pluginDir,
      'code-review',
      'adapter: codex\ndescription: Adversarial code review\nmodel: gpt-5.4\nfiles_glob: src/**/*.ts\ntimeout_ms: 240000',
      'You are a critical code reviewer.'
    );
    writeUserSkill(
      userDir,
      'second-opinion',
      'adapter: gemini\ndescription: Second-opinion analysis',
      'Provide a second opinion on the question.'
    );

    const reg = new FsSkillRegistry({ pluginSkillsDir: pluginDir, userSkillsDir: userDir });
    const all = await reg.list();
    expect(all.map((s) => s.name).sort()).toEqual(['code-review', 'second-opinion']);
    const cr = await reg.get('code-review');
    expect(cr?.adapter).toBe('codex');
    expect(cr?.model).toBe('gpt-5.4');
    expect(cr?.filesGlob).toBe('src/**/*.ts');
    expect(cr?.timeoutMs).toBe(240000);
    expect(cr?.promptBody).toBe('You are a critical code reviewer.');
    expect(cr?.source).toBe('plugin');
    const so = await reg.get('second-opinion');
    expect(so?.source).toBe('user');
  });

  it('user skills override plugin skills with the same name', async () => {
    writeSkill(pluginDir, 'review', 'adapter: codex\ndescription: original', 'plugin body');
    writeUserSkill(userDir, 'review', 'adapter: claude\ndescription: overridden', 'user body');

    const reg = new FsSkillRegistry({ pluginSkillsDir: pluginDir, userSkillsDir: userDir });
    const r = await reg.get('review');
    expect(r?.adapter).toBe('claude');
    expect(r?.promptBody).toBe('user body');
    expect(r?.source).toBe('user');
  });

  it('skips files without required frontmatter fields', async () => {
    // Missing adapter.
    writeSkill(pluginDir, 'broken-no-adapter', 'description: x', 'body');
    // Missing description.
    writeSkill(pluginDir, 'broken-no-description', 'adapter: codex', 'body');

    const reg = new FsSkillRegistry({ pluginSkillsDir: pluginDir, userSkillsDir: userDir });
    expect(await reg.list()).toHaveLength(0);
  });

  it('returns undefined for unknown skill', async () => {
    const reg = new FsSkillRegistry({ pluginSkillsDir: pluginDir, userSkillsDir: userDir });
    expect(await reg.get('nope')).toBeUndefined();
  });

  it('reload() picks up new skill files', async () => {
    const reg = new FsSkillRegistry({ pluginSkillsDir: pluginDir, userSkillsDir: userDir });
    expect(await reg.list()).toHaveLength(0);
    writeSkill(pluginDir, 'fresh', 'adapter: codex\ndescription: fresh', 'body');
    expect(await reg.list()).toHaveLength(0); // cached
    await reg.reload();
    expect((await reg.list()).map((s) => s.name)).toEqual(['fresh']);
  });

  it('handles missing dirs gracefully (treats as empty)', async () => {
    const reg = new FsSkillRegistry({
      pluginSkillsDir: '/nonexistent/asyncthink-test',
      userSkillsDir: '/nonexistent/asyncthink-test-user',
    });
    expect(await reg.list()).toEqual([]);
  });
});
