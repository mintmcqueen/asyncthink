/**
 * AdapterRegistry — runtime lookup of adapter impls by id.
 *
 * Built-ins registered at module load. Future extensibility: a hook for
 * plugin-supplied adapters can register additional impls before first use.
 */
import type { Adapter } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
export declare class AdapterRegistry {
    private readonly map;
    register(adapter: Adapter): void;
    get(id: string): Adapter | undefined;
    list(): Adapter[];
    /**
     * v2.5.0 — accept an optional auditLog so the codex adapter can emit
     * `codex.overlay.materialize` events for observability of the F3-D.2 gate.
     */
    static withDefaults(opts?: {
        auditLog?: AuditLog;
    }): AdapterRegistry;
}
