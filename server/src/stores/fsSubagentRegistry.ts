/**
 * v2.6.0 — FsSubagentRegistry: JSON-per-file at
 *   ~/.local/share/asyncthink/subagents/<sanitized-id>.json
 *
 * Mirrors the existing AsyncThink storage pattern (ThreadStore + TaskStore
 * are both filesystem-backed JSONL/JSON; no SQLite dep).
 *
 * Atomic writes via tmp+rename. List walks the directory; reads parse each
 * file independently (one corrupt file doesn't break list).
 *
 * Built-in bootstrap: on first server boot, missing built-ins are written.
 * User-created subagents shadow built-ins by id.
 */

import { promises as fsp, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  BuiltinSubagent,
  Subagent,
  SubagentCreateInput,
  SubagentRegistry,
  SubagentUpdateInput,
} from '../core/subagent.js';
import { SUBAGENT_SCHEMA_VERSION, isValidSubagentId, slugifyName } from '../core/subagent.js';

export interface FsSubagentRegistryOptions {
  /** Override storage dir (for tests). Defaults to ~/.local/share/asyncthink/subagents. */
  storageDir?: string;
  /** Clock for createdAt/lastUsedAt stamps. */
  now?: () => Date;
}

export class FsSubagentRegistry implements SubagentRegistry {
  private readonly storageDir: string;
  private readonly now: () => Date;

  constructor(opts: FsSubagentRegistryOptions = {}) {
    this.storageDir = opts.storageDir ?? defaultStorageDir();
    this.now = opts.now ?? (() => new Date());
  }

  async list(): Promise<Subagent[]> {
    if (!existsSync(this.storageDir)) return [];
    const out: Subagent[] = [];
    for (const entry of readdirSync(this.storageDir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(this.storageDir, entry);
      try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as Subagent;
        if (parsed.id && parsed.name) out.push(parsed);
      } catch {
        // Skip unparseable files; list shouldn't fail because of one corrupt entry.
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Subagent | undefined> {
    // v2.8.1 — defense against path traversal via caller-supplied subagent id.
    // Without this guard, `inv.subagent = "../../../etc/passwd"` would be
    // normalized by path.join inside pathFor() and read an arbitrary JSON
    // file. The id must match slugifyName output (1-64 chars, lowercase
    // alphanumerics + non-edge dashes).
    if (!isValidSubagentId(id)) return undefined;
    const path = this.pathFor(id);
    if (!existsSync(path)) return undefined;
    try {
      const raw = await fsp.readFile(path, 'utf8');
      return JSON.parse(raw) as Subagent;
    } catch {
      return undefined;
    }
  }

  async create(input: SubagentCreateInput): Promise<Subagent> {
    if (!input.name?.trim() || !input.prompt?.trim() || !input.description?.trim()) {
      throw new Error(
        'subagent_create: name, description, and prompt are all required and must be non-empty.'
      );
    }
    const id = slugifyName(input.name);
    if (!id) {
      throw new Error('subagent_create: name slugged to empty id; pick a name with at least one alphanumeric character.');
    }
    if (existsSync(this.pathFor(id))) {
      throw new Error(
        `subagent_create: id "${id}" already exists. Use subagent_update to modify, or pick a different name.`
      );
    }
    const subagent: Subagent = {
      id,
      name: input.name.trim(),
      description: input.description.trim(),
      prompt: input.prompt.trim(),
      tools: input.tools,
      model: input.model,
      createdAt: this.now().toISOString(),
      schemaVersion: SUBAGENT_SCHEMA_VERSION,
    };
    await this.write(subagent);
    return subagent;
  }

  async update(id: string, patch: SubagentUpdateInput): Promise<Subagent> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`subagent_update: subagent "${id}" not found.`);
    }
    const next: Subagent = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
      ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
    };
    await this.write(next);
    return next;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    // v2.8.1 — invalid ids return `deleted: false` rather than throwing.
    // Symmetric with get(); a delete of a non-id is just a no-op.
    if (!isValidSubagentId(id)) return { deleted: false };
    const path = this.pathFor(id);
    if (!existsSync(path)) return { deleted: false };
    await fsp.unlink(path);
    return { deleted: true };
  }

  /**
   * Touch lastUsedAt — called by the claude adapter on successful spawn.
   * Not part of the SubagentRegistry public interface (it's a side-effect
   * the adapter performs), but exposed here for completeness.
   */
  async markUsed(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    existing.lastUsedAt = this.now().toISOString();
    await this.write(existing);
  }

  async bootstrapBuiltins(builtins: BuiltinSubagent[]): Promise<void> {
    await fsp.mkdir(this.storageDir, { recursive: true });
    for (const b of builtins) {
      const path = this.pathFor(b.id);
      if (existsSync(path)) continue; // user customization wins
      const subagent: Subagent = {
        id: b.id,
        name: b.name,
        description: b.description,
        prompt: b.prompt,
        tools: b.tools,
        model: b.model,
        createdAt: this.now().toISOString(),
        isBuiltIn: true,
        schemaVersion: SUBAGENT_SCHEMA_VERSION,
      };
      await this.write(subagent);
    }
  }

  /**
   * v2.8.1 — gate every filesystem path construction on the id-validity
   * check. This is defense-in-depth: even if a caller forgets to validate
   * before reaching this method, traversal sequences (`../`, absolute
   * paths, dotfiles, etc.) are rejected at the source.
   *
   * Throws `SubagentIdInvalidError` rather than returning undefined,
   * because reaching pathFor() means a caller intended a real filesystem
   * operation; returning undefined would hide bugs.
   */
  private pathFor(id: string): string {
    if (!isValidSubagentId(id)) {
      throw new SubagentIdInvalidError(id);
    }
    return join(this.storageDir, `${id}.json`);
  }

  private async write(subagent: Subagent): Promise<void> {
    await fsp.mkdir(this.storageDir, { recursive: true });
    const path = this.pathFor(subagent.id);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(subagent, null, 2));
    await fsp.rename(tmp, path);
  }
}

/**
 * v2.8.1 — thrown when a method is called with an id that doesn't match
 * the slugified form. Surfaces caller bugs instead of silently no-op'ing.
 */
export class SubagentIdInvalidError extends Error {
  constructor(id: string) {
    super(
      `subagent id "${id}" is invalid. Valid ids match slugifyName output: ` +
        `1-64 chars, lowercase alphanumerics, dashes allowed except at edges.`
    );
    this.name = 'SubagentIdInvalidError';
  }
}

function defaultStorageDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ?? join(process.env.HOME ?? homedir(), '.local', 'share');
  return join(base, 'asyncthink', 'subagents');
}

// Exposed for tests that need to manipulate the dir constant.
export const __testing = { defaultStorageDir };

// Silence unused-import warning on `dirname` (used by writers that need it).
void dirname;
