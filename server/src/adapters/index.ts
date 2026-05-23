/**
 * AdapterRegistry — runtime lookup of adapter impls by id.
 *
 * Built-ins registered at module load. Future extensibility: a hook for
 * plugin-supplied adapters can register additional impls before first use.
 */

import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { SettingsStore } from '../core/settings.js';
import type { SubagentRegistry } from '../core/subagent.js';
import { ClaudeAdapter } from './impl/claude.js';
import { GeminiAdapter } from './impl/gemini.js';
import { CodexAdapter } from './impl/codex.js';

export class AdapterRegistry {
  private readonly map = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    this.map.set(adapter.id, adapter);
  }

  get(id: string): Adapter | undefined {
    return this.map.get(id);
  }

  list(): Adapter[] {
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
  static withDefaults(
    opts: {
      auditLog?: AuditLog;
      settingsStore?: SettingsStore;
      subagentRegistry?: SubagentRegistry;
    } = {}
  ): AdapterRegistry {
    const r = new AdapterRegistry();
    r.register(
      new ClaudeAdapter({
        settingsStore: opts.settingsStore,
        subagentRegistry: opts.subagentRegistry,
        auditLog: opts.auditLog,
      })
    );
    r.register(new GeminiAdapter());
    r.register(new CodexAdapter({ auditLog: opts.auditLog }));
    return r;
  }
}
