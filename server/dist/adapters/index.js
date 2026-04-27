/**
 * AdapterRegistry — runtime lookup of adapter impls by id.
 *
 * Built-ins registered at module load. Future extensibility: a hook for
 * plugin-supplied adapters can register additional impls before first use.
 */
import { ClaudeAdapter } from './impl/claude.js';
import { GeminiAdapter } from './impl/gemini.js';
import { CodexAdapter } from './impl/codex.js';
export class AdapterRegistry {
    map = new Map();
    register(adapter) {
        this.map.set(adapter.id, adapter);
    }
    get(id) {
        return this.map.get(id);
    }
    list() {
        return [...this.map.values()];
    }
    static withDefaults() {
        const r = new AdapterRegistry();
        r.register(new ClaudeAdapter());
        r.register(new GeminiAdapter());
        r.register(new CodexAdapter());
        return r;
    }
}
