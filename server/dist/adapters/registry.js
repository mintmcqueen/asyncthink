/**
 * FsManifestRegistry — loads adapter manifests from this plugin's bundled
 * manifests/ directory.
 *
 * The registry only exposes metadata; it does NOT instantiate adapters.
 * Execution lives in ./impl/<id>.ts. The two are wired together by the council
 * and delegate code paths via the AdapterRegistry (different concept, future
 * work) or by direct import.
 */
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const REQUIRED_FIELDS = [
    'id',
    'displayName',
    'binary',
    'tiers',
    'defaultTier',
    'requiredEnv',
    'defaultTimeoutMs',
];
const VALID_TIERS = ['high', 'med', 'low'];
export class FsManifestRegistry {
    cache = null;
    manifestsDir;
    constructor(manifestsDir) {
        this.manifestsDir = manifestsDir ?? defaultManifestsDir();
    }
    async loadAll() {
        if (this.cache)
            return [...this.cache.values()];
        const cache = new Map();
        const entries = await fs.readdir(this.manifestsDir);
        for (const name of entries) {
            if (!name.endsWith('.json'))
                continue;
            const path = join(this.manifestsDir, name);
            const raw = await fs.readFile(path, 'utf8');
            const parsed = JSON.parse(raw);
            const manifest = validate(parsed, path);
            if (cache.has(manifest.id)) {
                throw new Error(`Duplicate manifest id "${manifest.id}" at ${path}`);
            }
            cache.set(manifest.id, manifest);
        }
        this.cache = cache;
        return [...cache.values()];
    }
    async get(id) {
        if (!this.cache)
            await this.loadAll();
        return this.cache.get(id);
    }
}
function validate(value, path) {
    if (!value || typeof value !== 'object') {
        throw new Error(`Manifest at ${path} is not an object`);
    }
    const obj = value;
    for (const field of REQUIRED_FIELDS) {
        if (!(field in obj)) {
            throw new Error(`Manifest at ${path} missing required field "${String(field)}"`);
        }
    }
    if (typeof obj.id !== 'string' || obj.id.length === 0) {
        throw new Error(`Manifest at ${path} has invalid id`);
    }
    if (!Array.isArray(obj.requiredEnv) || !obj.requiredEnv.every((s) => typeof s === 'string')) {
        throw new Error(`Manifest at ${path} has invalid requiredEnv (must be string[])`);
    }
    if (typeof obj.defaultTimeoutMs !== 'number' || obj.defaultTimeoutMs <= 0) {
        throw new Error(`Manifest at ${path} has invalid defaultTimeoutMs`);
    }
    const tiers = obj.tiers;
    if (!tiers || typeof tiers !== 'object') {
        throw new Error(`Manifest at ${path} has invalid tiers (must be object)`);
    }
    for (const tier of VALID_TIERS) {
        if (typeof tiers[tier] !== 'string' || tiers[tier].length === 0) {
            throw new Error(`Manifest at ${path} missing or invalid tier "${tier}"`);
        }
    }
    if (!VALID_TIERS.includes(obj.defaultTier)) {
        throw new Error(`Manifest at ${path} has invalid defaultTier (must be one of ${VALID_TIERS.join(', ')})`);
    }
    return obj;
}
function defaultManifestsDir() {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, 'manifests');
}
