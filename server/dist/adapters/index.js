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
    /**
     * v2.5.0 — accept an optional auditLog so the codex adapter can emit
     * `codex.overlay.materialize` events.
     *
     * v2.6.0 — accept settingsStore + subagentRegistry so the claude adapter
     * can resolve the active subagent and inject it on the subscription
     * auth path (--agents + --agent flags on claude --print).
     */
    static withDefaults(opts = {}) {
        const r = new AdapterRegistry();
        r.register(new ClaudeAdapter({
            settingsStore: opts.settingsStore,
            subagentRegistry: opts.subagentRegistry,
            auditLog: opts.auditLog,
        }));
        r.register(new GeminiAdapter());
        r.register(new CodexAdapter({ auditLog: opts.auditLog }));
        return r;
    }
}
