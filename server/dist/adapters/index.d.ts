/**
 * AdapterRegistry — runtime lookup of adapter impls by id.
 *
 * Built-ins registered at module load. Future extensibility: a hook for
 * plugin-supplied adapters can register additional impls before first use.
 */
import type { Adapter } from '../core/adapter.js';
export declare class AdapterRegistry {
    private readonly map;
    register(adapter: Adapter): void;
    get(id: string): Adapter | undefined;
    list(): Adapter[];
    static withDefaults(): AdapterRegistry;
}
