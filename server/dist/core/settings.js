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
/**
 * Built-in defaults — the lowest-precedence layer. Choices here are
 * intentional and reflect AsyncThink's framing:
 *   - adapter: "claude" because AsyncThink is invoked from inside Claude
 *     Code; claude is the implicit subordinate.
 *   - subagent: "asyncthink-delegate" — the plugin-shipped subagent that
 *     gives the claude-subscription path a distinct persona.
 */
export const BUILTIN_DEFAULTS = {
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
export function readPath(values, key) {
    const parts = key.split('.');
    let cursor = values;
    for (const p of parts) {
        if (cursor === null || typeof cursor !== 'object')
            return undefined;
        cursor = cursor[p];
    }
    return cursor;
}
/**
 * Dotted-path set: returns a new SettingsValues with key set to value.
 * Pure function; used by FsSettingsStore.set to compute the new on-disk
 * shape before atomic write.
 */
export function setPath(values, key, value) {
    const parts = key.split('.');
    const out = JSON.parse(JSON.stringify(values));
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cursor[p] === undefined ||
            cursor[p] === null ||
            typeof cursor[p] !== 'object') {
            cursor[p] = {};
        }
        cursor = cursor[p];
    }
    cursor[parts[parts.length - 1]] = value;
    return out;
}
export function unsetPath(values, key) {
    const parts = key.split('.');
    const out = JSON.parse(JSON.stringify(values));
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cursor[p] === undefined || typeof cursor[p] !== 'object')
            return out;
        cursor = cursor[p];
    }
    delete cursor[parts[parts.length - 1]];
    return out;
}
/**
 * Merge layer values bottom-up. Later layers override earlier; objects
 * deep-merge, scalars replace.
 */
export function mergeLayers(layers) {
    const out = {};
    for (const layer of layers) {
        if (!layer || typeof layer !== 'object')
            continue;
        for (const k of Object.keys(layer)) {
            const v = layer[k];
            if (v === undefined)
                continue;
            if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                const existing = (out[k] ?? {});
                out[k] = { ...existing, ...v };
            }
            else {
                out[k] = v;
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
const VALID_ADAPTERS = new Set(['claude', 'gemini', 'codex']);
export function validateKey(key, value) {
    switch (key) {
        case 'defaults.adapter': {
            if (typeof value !== 'string') {
                return { valid: false, reason: 'defaults.adapter must be a string' };
            }
            if (!VALID_ADAPTERS.has(value)) {
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
