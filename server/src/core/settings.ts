/**
 * v2.6.0 — Settings: file-backed durable defaults for AsyncThink.
 *
 * Replaces v2.5.1's `ASYNCTHINK_DEFAULT_ADAPTER` env var with a layered
 * persistence model:
 *
 *   1. Per-call arg               (delegate({adapter: 'gemini'}))
 *   2. Skill frontmatter          (skill pins adapter)
 *   3. Project settings           (.claude/asyncthink.local.md in cwd/ancestors)
 *   4. User settings              (~/.config/asyncthink/settings.toml)
 *   5. Built-in default           (defaults.adapter = "claude")
 *
 * Layer 5 reflects the "running inside Claude Code" framing — claude is
 * the implicit default, and the v2.6.0 claude adapter spawns a dedicated
 * subagent on the subscription auth path to keep the delegate persona
 * distinct from the parent session.
 *
 * The Settings interface is the v3-portable contract; v3 RemoteCompanion
 * substitutes a server-backed store at the same interface.
 */

export type AdapterId = 'claude' | 'gemini' | 'codex';

export interface SettingsValues {
  defaults?: {
    /** Adapter to use when caller omits `adapter` and skill doesn't pin one. */
    adapter?: AdapterId;
    /** Subagent id to bind to claude adapter spawns on subscription auth path. */
    subagent?: string;
  };
}

/**
 * Where a particular setting value came from in the resolution chain. Tool
 * responses surface this so the user can debug "why is delegate picking X?"
 * without spelunking the codebase.
 */
export type SettingsLayerSource = 'builtin' | 'user' | 'project';

export interface SettingsLayer {
  source: SettingsLayerSource;
  /** Absolute path to the file, or undefined for builtin. */
  path?: string;
  /** Whether the file exists on disk (true for builtin always). */
  exists: boolean;
  /** Raw values from this layer (after parsing). */
  values: SettingsValues;
}

export interface EffectiveSettings {
  /** Merged values, top of stack wins. */
  effective: SettingsValues;
  /** Per-layer breakdown for debug + tool response. */
  layers: SettingsLayer[];
}

/**
 * Read-write interface. v2.6 ships FsSettingsStore; v3 substitutes
 * RemoteSettingsStore behind the same shape.
 */
export interface SettingsStore {
  /** Return effective settings + per-layer breakdown. */
  get(): Promise<EffectiveSettings>;
  /** Update one key at the given scope. Atomic write + cache invalidation. */
  set(key: string, value: unknown, scope: 'user' | 'project'): Promise<EffectiveSettings>;
  /** Clear one key from the given scope. */
  unset(key: string, scope: 'user' | 'project'): Promise<EffectiveSettings>;
}

/**
 * Built-in defaults — the lowest-precedence layer. Choices here are
 * intentional and reflect AsyncThink's framing:
 *   - adapter: "claude" because AsyncThink is invoked from inside Claude
 *     Code; claude is the implicit subordinate.
 *   - subagent: "asyncthink-delegate" — the plugin-shipped subagent that
 *     gives the claude-subscription path a distinct persona.
 */
export const BUILTIN_DEFAULTS: SettingsValues = {
  defaults: {
    adapter: 'claude',
    subagent: 'asyncthink-delegate',
  },
};

/**
 * Dotted-path lookup: 'defaults.adapter' → values?.defaults?.adapter.
 * Returns undefined for missing paths. Pure function; exported for tests
 * and tool handlers that need to read a single key.
 */
export function readPath(values: SettingsValues, key: string): unknown {
  const parts = key.split('.');
  let cursor: unknown = values;
  for (const p of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

/**
 * Dotted-path set: returns a new SettingsValues with key set to value.
 * Pure function; used by FsSettingsStore.set to compute the new on-disk
 * shape before atomic write.
 */
export function setPath(
  values: SettingsValues,
  key: string,
  value: unknown
): SettingsValues {
  const parts = key.split('.');
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(values));
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (
      cursor[p] === undefined ||
      cursor[p] === null ||
      typeof cursor[p] !== 'object'
    ) {
      cursor[p] = {};
    }
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return out as SettingsValues;
}

export function unsetPath(values: SettingsValues, key: string): SettingsValues {
  const parts = key.split('.');
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(values));
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cursor[p] === undefined || typeof cursor[p] !== 'object') return out as SettingsValues;
    cursor = cursor[p] as Record<string, unknown>;
  }
  delete cursor[parts[parts.length - 1]];
  return out as SettingsValues;
}

/**
 * Merge layer values bottom-up. Later layers override earlier; objects
 * deep-merge, scalars replace.
 */
export function mergeLayers(layers: SettingsValues[]): SettingsValues {
  const out: SettingsValues = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const k of Object.keys(layer) as (keyof SettingsValues)[]) {
      const v = layer[k];
      if (v === undefined) continue;
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const existing = (out[k] ?? {}) as Record<string, unknown>;
        out[k] = { ...existing, ...(v as Record<string, unknown>) } as SettingsValues[typeof k];
      } else {
        out[k] = v as SettingsValues[typeof k];
      }
    }
  }
  return out;
}

/**
 * Whitelisted keys + their value validators. Keeps the settings shape
 * principled — arbitrary keys are rejected rather than silently accepted
 * and ignored at read time.
 */
const VALID_ADAPTERS = new Set<AdapterId>(['claude', 'gemini', 'codex']);

export function validateKey(
  key: string,
  value: unknown
): { valid: true } | { valid: false; reason: string } {
  switch (key) {
    case 'defaults.adapter': {
      if (typeof value !== 'string') {
        return { valid: false, reason: 'defaults.adapter must be a string' };
      }
      if (!VALID_ADAPTERS.has(value as AdapterId)) {
        return {
          valid: false,
          reason: `defaults.adapter must be one of: ${[...VALID_ADAPTERS].join(', ')}`,
        };
      }
      return { valid: true };
    }
    case 'defaults.subagent': {
      if (typeof value !== 'string' || value.length === 0) {
        return { valid: false, reason: 'defaults.subagent must be a non-empty string' };
      }
      return { valid: true };
    }
    default:
      return {
        valid: false,
        reason: `unknown setting key "${key}". Known keys: defaults.adapter, defaults.subagent.`,
      };
  }
}
