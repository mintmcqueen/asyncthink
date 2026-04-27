/**
 * FsManifestRegistry — loads adapter manifests from this plugin's bundled
 * manifests/ directory.
 *
 * The registry only exposes metadata; it does NOT instantiate adapters.
 * Execution lives in ./impl/<id>.ts. The two are wired together by the council
 * and delegate code paths via the AdapterRegistry (different concept, future
 * work) or by direct import.
 */
import type { AdapterManifest, ManifestRegistry } from '../core/manifests.js';
export declare class FsManifestRegistry implements ManifestRegistry {
    private cache;
    private readonly manifestsDir;
    constructor(manifestsDir?: string);
    loadAll(): Promise<AdapterManifest[]>;
    get(id: string): Promise<AdapterManifest | undefined>;
}
