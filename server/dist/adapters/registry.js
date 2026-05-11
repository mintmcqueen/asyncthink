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
import { authPathsFor } from './authPath.js';
const RATE_LIMIT_CLASSES = ['standard', 'rate-limited', 'unlimited'];
const CAP_DIMS = ['input', 'output', 'requests', 'messages'];
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
    // Optional tierLimits validation (R6a-D.1).
    if (obj.tierLimits !== undefined) {
        if (typeof obj.tierLimits !== 'object' || obj.tierLimits === null) {
            throw new Error(`Manifest at ${path} has invalid tierLimits (must be object or absent)`);
        }
        const limits = obj.tierLimits;
        for (const tier of VALID_TIERS) {
            const entry = limits[tier];
            if (entry === undefined)
                continue;
            if (typeof entry !== 'object' || entry === null) {
                throw new Error(`Manifest at ${path} tierLimits["${tier}"] must be an object`);
            }
            const e = entry;
            if (e.maxContext !== undefined && (typeof e.maxContext !== 'number' || e.maxContext <= 0)) {
                throw new Error(`Manifest at ${path} tierLimits["${tier}"].maxContext must be a positive number`);
            }
            if (e.rateLimitClass !== undefined &&
                e.rateLimitClass !== 'standard' &&
                e.rateLimitClass !== 'rate-limited' &&
                e.rateLimitClass !== 'unlimited') {
                throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimitClass must be 'standard'|'rate-limited'|'unlimited'`);
            }
            if (e.expectedLatencyMsP50 !== undefined &&
                (typeof e.expectedLatencyMsP50 !== 'number' || e.expectedLatencyMsP50 < 0)) {
                throw new Error(`Manifest at ${path} tierLimits["${tier}"].expectedLatencyMsP50 must be a non-negative number`);
            }
            // v2.3 — rateLimit.byAuthPath validation (R6a-D.4).
            if (e.rateLimit !== undefined) {
                validateRateLimit(e.rateLimit, path, tier, obj.id);
            }
        }
    }
    // v2.3 — mcp.allowlist / mcp.catalog (F3-D.2).
    if (obj.mcp !== undefined) {
        if (typeof obj.mcp !== 'object' || obj.mcp === null) {
            throw new Error(`Manifest at ${path} mcp must be an object`);
        }
        const m = obj.mcp;
        if (!Array.isArray(m.allowlist) || !m.allowlist.every((s) => typeof s === 'string')) {
            throw new Error(`Manifest at ${path} mcp.allowlist must be string[]`);
        }
        if (m.catalog !== undefined &&
            (!Array.isArray(m.catalog) || !m.catalog.every((s) => typeof s === 'string'))) {
            throw new Error(`Manifest at ${path} mcp.catalog must be string[] if present`);
        }
    }
    return obj;
}
function validateRateLimit(rl, path, tier, adapterId) {
    if (typeof rl !== 'object' || rl === null) {
        throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit must be object`);
    }
    const r = rl;
    if (typeof r.lastVerified !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}/.test(r.lastVerified)) {
        throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit.lastVerified must be ISODate string`);
    }
    if (typeof r.byAuthPath !== 'object' || r.byAuthPath === null) {
        throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit.byAuthPath must be object`);
    }
    const ap = r.byAuthPath;
    const validPaths = new Set(authPathsFor(adapterId));
    for (const key of Object.keys(ap)) {
        if (!validPaths.has(key)) {
            throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit.byAuthPath key "${key}" not valid for adapter "${adapterId}". Valid: ${[...validPaths].join(', ')}`);
        }
        const advisory = ap[key];
        if (typeof advisory !== 'object' || advisory === null) {
            throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit.byAuthPath["${key}"] must be object`);
        }
        const a = advisory;
        if (!RATE_LIMIT_CLASSES.includes(a.class)) {
            throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit.byAuthPath["${key}"].class must be one of ${RATE_LIMIT_CLASSES.join(',')}`);
        }
        if (a.cap !== undefined) {
            const c = a.cap;
            if (typeof c.tokens !== 'number' || c.tokens <= 0) {
                throw new Error(`...cap.tokens must be positive number (${path} tier=${tier} path=${key})`);
            }
            if (typeof c.windowSec !== 'number' || c.windowSec <= 0) {
                throw new Error(`...cap.windowSec must be positive number (${path} tier=${tier} path=${key})`);
            }
            if (!CAP_DIMS.includes(c.dim)) {
                throw new Error(`...cap.dim must be one of ${CAP_DIMS.join(',')} (${path} tier=${tier} path=${key})`);
            }
        }
    }
    if (typeof r.default !== 'string' || !validPaths.has(r.default)) {
        throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit.default "${String(r.default)}" not in byAuthPath keys`);
    }
    if (!(r.default in ap)) {
        throw new Error(`Manifest at ${path} tierLimits["${tier}"].rateLimit.default "${String(r.default)}" must appear in byAuthPath`);
    }
}
function defaultManifestsDir() {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, 'manifests');
}
