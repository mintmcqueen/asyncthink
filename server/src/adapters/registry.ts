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
import type { AdapterManifest, ManifestRegistry } from '../core/manifests.js';

const REQUIRED_FIELDS: (keyof AdapterManifest)[] = [
  'id',
  'displayName',
  'binary',
  'defaultModel',
  'requiredEnv',
  'defaultTimeoutMs',
];

export class FsManifestRegistry implements ManifestRegistry {
  private cache: Map<string, AdapterManifest> | null = null;
  private readonly manifestsDir: string;

  constructor(manifestsDir?: string) {
    this.manifestsDir = manifestsDir ?? defaultManifestsDir();
  }

  async loadAll(): Promise<AdapterManifest[]> {
    if (this.cache) return [...this.cache.values()];
    const cache = new Map<string, AdapterManifest>();
    const entries = await fs.readdir(this.manifestsDir);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.manifestsDir, name);
      const raw = await fs.readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const manifest = validate(parsed, path);
      if (cache.has(manifest.id)) {
        throw new Error(`Duplicate manifest id "${manifest.id}" at ${path}`);
      }
      cache.set(manifest.id, manifest);
    }
    this.cache = cache;
    return [...cache.values()];
  }

  async get(id: string): Promise<AdapterManifest | undefined> {
    if (!this.cache) await this.loadAll();
    return this.cache!.get(id);
  }
}

function validate(value: unknown, path: string): AdapterManifest {
  if (!value || typeof value !== 'object') {
    throw new Error(`Manifest at ${path} is not an object`);
  }
  const obj = value as Record<string, unknown>;
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
  return obj as unknown as AdapterManifest;
}

function defaultManifestsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'manifests');
}
