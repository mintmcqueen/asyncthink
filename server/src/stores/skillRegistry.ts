/**
 * FsSkillRegistry — markdown-frontmatter skill loader.
 *
 * Reads skills from two locations:
 *   - <plugin-root>/skills/<name>/SKILL.md       (built-ins)
 *   - ~/.config/asyncthink/skills/<name>.md      (user)
 *
 * User skills override plugin skills with the same id.
 *
 * Frontmatter format is a small subset of YAML — line-oriented `key: value`
 * pairs only, no nested objects, no flow style. Scalars are parsed as:
 *   - integer if matches /^-?\d+$/
 *   - boolean for "true"/"false"
 *   - string otherwise (quotes optional)
 *
 * Anything between the first `---` and the next `---` is the frontmatter;
 * content after the closing `---` is the prompt body.
 */

import { promises as fsp, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Skill, SkillRegistry } from '../core/skillRegistry.js';

interface RawFrontmatter {
  adapter?: unknown;
  model?: unknown;
  files_glob?: unknown;
  timeout_ms?: unknown;
  description?: unknown;
}

export interface FsSkillRegistryOptions {
  pluginSkillsDir?: string;
  userSkillsDir?: string;
}

export class FsSkillRegistry implements SkillRegistry {
  private cache: Map<string, Skill> | null = null;
  private readonly pluginSkillsDir: string;
  private readonly userSkillsDir: string;

  constructor(opts: FsSkillRegistryOptions = {}) {
    this.pluginSkillsDir = opts.pluginSkillsDir ?? defaultPluginSkillsDir();
    this.userSkillsDir = opts.userSkillsDir ?? defaultUserSkillsDir();
  }

  async list(): Promise<Skill[]> {
    if (!this.cache) await this.scan();
    return [...this.cache!.values()];
  }

  async get(name: string): Promise<Skill | undefined> {
    if (!this.cache) await this.scan();
    return this.cache!.get(name);
  }

  async reload(): Promise<void> {
    this.cache = null;
    await this.scan();
  }

  private async scan(): Promise<void> {
    const cache = new Map<string, Skill>();
    // Plugin skills first.
    for (const skill of await scanDirectoryStyle(this.pluginSkillsDir, 'plugin')) {
      cache.set(skill.name, skill);
    }
    // User skills second; overrides plugin.
    for (const skill of await scanFlatStyle(this.userSkillsDir, 'user')) {
      cache.set(skill.name, skill);
    }
    this.cache = cache;
  }
}

async function scanDirectoryStyle(dir: string, source: 'plugin' | 'user'): Promise<Skill[]> {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir)) {
    const skillDir = join(dir, entry);
    let st;
    try {
      st = statSync(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const skill = await loadSkillFile(skillFile, entry, source);
    if (skill) out.push(skill);
  }
  return out;
}

async function scanFlatStyle(dir: string, source: 'plugin' | 'user'): Promise<Skill[]> {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const path = join(dir, entry);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const name = basename(entry, '.md');
    const skill = await loadSkillFile(path, name, source);
    if (skill) out.push(skill);
  }
  return out;
}

async function loadSkillFile(
  path: string,
  name: string,
  source: 'plugin' | 'user'
): Promise<Skill | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed) return undefined;
  const fm = parsed.frontmatter as RawFrontmatter;
  if (typeof fm.adapter !== 'string' || fm.adapter.length === 0) {
    return undefined;
  }
  if (typeof fm.description !== 'string' || fm.description.length === 0) {
    return undefined;
  }
  return {
    name,
    adapter: fm.adapter,
    model: typeof fm.model === 'string' ? fm.model : undefined,
    filesGlob: typeof fm.files_glob === 'string' ? fm.files_glob : undefined,
    timeoutMs: typeof fm.timeout_ms === 'number' ? fm.timeout_ms : undefined,
    description: fm.description,
    promptBody: parsed.body.trim(),
    source,
  };
}

interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(raw: string): ParsedDocument | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    // No frontmatter → reject (skills must declare metadata).
    return undefined;
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return undefined;

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join('\n');
  const frontmatter: Record<string, unknown> = {};
  for (const line of fmLines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    frontmatter[m[1]] = parseScalar(m[2]);
  }
  return { frontmatter, body };
}

function parseScalar(raw: string): string | number | boolean {
  let s = raw.trim();
  // Strip wrapping quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function defaultPluginSkillsDir(): string {
  // From server/dist/stores/skillRegistry.js → up four levels = plugin root,
  // then `skills/`. From source we land at `server/src/stores/...`; for tests
  // we override via the constructor.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'skills');
}

function defaultUserSkillsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ?? join(home, '.config');
  return join(base, 'asyncthink', 'skills');
}
