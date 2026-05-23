/**
 * v2.6.0 — FsSettingsStore: TOML + YAML-frontmatter backed settings layer.
 *
 * User scope:    ~/.config/asyncthink/settings.toml          (TOML, full file)
 * Project scope: <cwd-or-ancestor>/.claude/asyncthink.local.md
 *                  (YAML frontmatter only; markdown body is ignored)
 *
 * Why two formats:
 *   - User scope mirrors codex (~/.codex/config.toml) and AWS (~/.aws/config)
 *     conventions — TOML is the right idiom for "user config file you might
 *     hand-edit."
 *   - Project scope mirrors Claude Code's plugin-name.local.md pattern that
 *     skill-files already follow; YAML frontmatter is what we already parse
 *     in stores/skillRegistry.ts.
 *
 * Zero parser deps — we ship a minimal TOML + YAML reader/emitter for
 * exactly the shape we accept (defaults.adapter, defaults.subagent). If we
 * later expand the schema, this gets factored, not third-party-replaced.
 *
 * Atomic write: write-to-temp + rename. Cache invalidates on every set/unset.
 */

import { promises as fsp, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  EffectiveSettings,
  SettingsLayer,
  SettingsStore,
  SettingsValues,
} from '../core/settings.js';
import {
  BUILTIN_DEFAULTS,
  mergeLayers,
  setPath,
  unsetPath,
  validateKey,
} from '../core/settings.js';

export interface FsSettingsStoreOptions {
  /** Override user-settings path (for tests). Defaults to ~/.config/asyncthink/settings.toml. */
  userSettingsPath?: string;
  /** Override starting cwd for project-settings walk (for tests). Defaults to process.cwd(). */
  cwd?: string;
}

export class FsSettingsStore implements SettingsStore {
  private readonly userPath: string;
  private readonly cwd: string;
  private cache: EffectiveSettings | null = null;

  constructor(opts: FsSettingsStoreOptions = {}) {
    this.userPath = opts.userSettingsPath ?? defaultUserSettingsPath();
    this.cwd = opts.cwd ?? process.cwd();
  }

  async get(): Promise<EffectiveSettings> {
    if (this.cache) return this.cache;
    this.cache = await this.load();
    return this.cache;
  }

  async set(
    key: string,
    value: unknown,
    scope: 'user' | 'project'
  ): Promise<EffectiveSettings> {
    const validation = validateKey(key, value);
    if (!validation.valid) {
      throw new Error(`SettingsStore.set: ${validation.reason}`);
    }
    if (scope === 'user') {
      const current = (await this.readUser()) ?? {};
      const next = setPath(current, key, value);
      await this.writeUser(next);
    } else {
      const projectPath = await this.locateProjectPath({ createIfMissing: true });
      const current = projectPath ? (this.readProjectFile(projectPath) ?? {}) : {};
      const next = setPath(current, key, value);
      if (projectPath) await this.writeProject(projectPath, next);
    }
    this.cache = null;
    return this.get();
  }

  async unset(key: string, scope: 'user' | 'project'): Promise<EffectiveSettings> {
    if (scope === 'user') {
      const current = (await this.readUser()) ?? {};
      const next = unsetPath(current, key);
      await this.writeUser(next);
    } else {
      const projectPath = await this.locateProjectPath({ createIfMissing: false });
      if (projectPath) {
        const current = this.readProjectFile(projectPath) ?? {};
        const next = unsetPath(current, key);
        await this.writeProject(projectPath, next);
      }
    }
    this.cache = null;
    return this.get();
  }

  private async load(): Promise<EffectiveSettings> {
    const userValues = (await this.readUser()) ?? {};
    const projectPath = await this.locateProjectPath({ createIfMissing: false });
    const projectValues = projectPath ? (this.readProjectFile(projectPath) ?? {}) : {};

    const layers: SettingsLayer[] = [
      // Order matters for the breakdown display: highest precedence first.
      {
        source: 'project',
        path: projectPath ?? undefined,
        exists: !!projectPath,
        values: projectValues,
      },
      {
        source: 'user',
        path: this.userPath,
        exists: existsSync(this.userPath),
        values: userValues,
      },
      { source: 'builtin', exists: true, values: BUILTIN_DEFAULTS },
    ];

    // Merge: bottom-up so highest-precedence wins.
    const effective = mergeLayers([
      BUILTIN_DEFAULTS,
      userValues,
      projectValues,
    ]);

    return { effective, layers };
  }

  private async readUser(): Promise<SettingsValues | undefined> {
    if (!existsSync(this.userPath)) return undefined;
    try {
      const raw = await fsp.readFile(this.userPath, 'utf8');
      return parseToml(raw);
    } catch {
      return undefined;
    }
  }

  private async writeUser(values: SettingsValues): Promise<void> {
    await fsp.mkdir(dirname(this.userPath), { recursive: true });
    const toml = emitToml(values);
    await atomicWrite(this.userPath, toml);
  }

  private readProjectFile(path: string): SettingsValues | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const raw = readFileSync(path, 'utf8');
      return parseYamlFrontmatter(raw);
    } catch {
      return undefined;
    }
  }

  private async writeProject(path: string, values: SettingsValues): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    const md = emitYamlFrontmatter(values);
    await atomicWrite(path, md);
  }

  /**
   * Walk up from cwd looking for a `.claude/asyncthink.local.md`. Stops at
   * the first match or the filesystem root. Returns the absolute path of
   * the file (whether it exists yet or not, when createIfMissing).
   */
  private async locateProjectPath(opts: {
    createIfMissing: boolean;
  }): Promise<string | null> {
    let dir = resolve(this.cwd);
    while (true) {
      const candidate = join(dir, '.claude', 'asyncthink.local.md');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (opts.createIfMissing) {
      // No existing file found in ancestor chain — create one in cwd's .claude/.
      return join(resolve(this.cwd), '.claude', 'asyncthink.local.md');
    }
    return null;
  }
}

function defaultUserSettingsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ?? join(process.env.HOME ?? homedir(), '.config');
  return join(base, 'asyncthink', 'settings.toml');
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, path);
}

/* ─────────────────── Minimal TOML reader/emitter ─────────────────── */
/*
 * Subset supported (matches the v2.6 SettingsValues shape):
 *   - [section] table headers
 *   - key = "string" / key = true / key = false / key = 42
 *   - Comments (# to EOL)
 *   - One nesting level (defaults.adapter → [defaults] adapter = "...")
 * Does NOT support: arrays, dotted keys, multi-line strings, inline tables.
 */

export function parseToml(text: string): SettingsValues {
  const out: Record<string, Record<string, unknown>> = {};
  let currentSection: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const sectionMatch = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!out[currentSection]) out[currentSection] = {};
      continue;
    }
    const kvMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch || !currentSection) continue;
    const [, key, raw] = kvMatch;
    out[currentSection][key] = parseTomlScalar(raw.trim());
  }
  return out as SettingsValues;
}

function parseTomlScalar(raw: string): unknown {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

export function emitToml(values: SettingsValues): string {
  const lines: string[] = [
    '# AsyncThink user settings — edit with care, or use:',
    '#   asyncthink_config({action: "set_setting", ...}) from your orchestrator.',
    '',
  ];
  for (const section of Object.keys(values).sort()) {
    const body = (values as Record<string, unknown>)[section];
    if (!body || typeof body !== 'object') continue;
    const entries = Object.entries(body as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    if (entries.length === 0) continue;
    lines.push(`[${section}]`);
    for (const [k, v] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${k} = ${emitTomlScalar(v)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function emitTomlScalar(v: unknown): string {
  if (typeof v === 'string') return `"${v.replace(/"/g, '\\"')}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return `"${String(v)}"`;
}

/* ─────────────────── Minimal YAML frontmatter reader/emitter ─────────────────── */

export function parseYamlFrontmatter(text: string): SettingsValues {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return {};
  const yamlLines = lines.slice(1, endIdx);
  const out: Record<string, Record<string, unknown>> = {};
  let currentSection: string | null = null;
  for (const raw of yamlLines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    // Top-level: "section:" with no value
    const sectionMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/.exec(raw);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!out[currentSection]) out[currentSection] = {};
      continue;
    }
    // Indented k: v under a section
    const indentedMatch = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(raw);
    if (indentedMatch && currentSection) {
      const [, k, v] = indentedMatch;
      out[currentSection][k] = parseYamlScalar(v.trim());
    }
  }
  return out as SettingsValues;
}

function parseYamlScalar(raw: string): unknown {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

export function emitYamlFrontmatter(values: SettingsValues): string {
  const lines: string[] = ['---'];
  for (const section of Object.keys(values).sort()) {
    const body = (values as Record<string, unknown>)[section];
    if (!body || typeof body !== 'object') continue;
    const entries = Object.entries(body as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    if (entries.length === 0) continue;
    lines.push(`${section}:`);
    for (const [k, v] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${k}: ${emitYamlScalar(v)}`);
    }
  }
  lines.push('---', '', '<!-- AsyncThink project settings — edit frontmatter above, or use:', '     asyncthink_config({action: "set_setting", scope: "project", ...}) from your orchestrator. -->', '');
  return lines.join('\n');
}

function emitYamlScalar(v: unknown): string {
  if (typeof v === 'string') return `"${v.replace(/"/g, '\\"')}"`;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  return `"${String(v)}"`;
}
