import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FsManifestRegistry } from '../../src/adapters/registry.js';

async function withTempManifestsDir(
  manifests: Record<string, unknown>
): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'asyncthink-manifests-'));
  for (const [name, content] of Object.entries(manifests)) {
    await fs.writeFile(join(dir, name), JSON.stringify(content), 'utf8');
  }
  return dir;
}

describe('FsManifestRegistry', () => {
  it('loads all bundled manifests (claude, gemini, codex)', async () => {
    const reg = new FsManifestRegistry();
    const all = await reg.loadAll();
    const ids = all.map((m) => m.id).sort();
    expect(ids).toEqual(['claude', 'codex', 'gemini']);
  });

  it('exposes metadata fields on each bundled manifest', async () => {
    const reg = new FsManifestRegistry();
    const claude = await reg.get('claude');
    expect(claude?.binary).toBe('claude');
    expect(claude?.defaultTimeoutMs).toBeGreaterThan(0);
    const gemini = await reg.get('gemini');
    expect(gemini?.requiredEnv).toContain('GEMINI_API_KEY');
    const codex = await reg.get('codex');
    expect(codex?.binary).toBe('codex');
    expect(codex?.requiredEnv).toContain('OPENAI_API_KEY');
  });

  it('returns undefined for unknown id', async () => {
    const reg = new FsManifestRegistry();
    expect(await reg.get('does-not-exist')).toBeUndefined();
  });

  it('rejects manifests missing required fields', async () => {
    const dir = await withTempManifestsDir({
      'broken.json': { id: 'broken' },
    });
    const reg = new FsManifestRegistry(dir);
    await expect(reg.loadAll()).rejects.toThrow(/missing required field/);
  });

  it('rejects manifests with non-string requiredEnv', async () => {
    const dir = await withTempManifestsDir({
      'bad.json': {
        id: 'bad',
        displayName: 'X',
        binary: 'x',
        tiers: { high: 'h', med: 'm', low: 'l' },
        defaultTier: 'med',
        requiredEnv: 'NOT_AN_ARRAY',
        defaultTimeoutMs: 1000,
      },
    });
    const reg = new FsManifestRegistry(dir);
    await expect(reg.loadAll()).rejects.toThrow(/requiredEnv/);
  });

  it('rejects duplicate manifest ids', async () => {
    const dir = await withTempManifestsDir({
      'a.json': mk('dup'),
      'b.json': mk('dup'),
    });
    const reg = new FsManifestRegistry(dir);
    await expect(reg.loadAll()).rejects.toThrow(/Duplicate manifest id/);
  });

  it('caches the loaded set across repeated calls', async () => {
    const reg = new FsManifestRegistry();
    const a = await reg.loadAll();
    const b = await reg.loadAll();
    expect(b).toHaveLength(a.length);
  });
});

function mk(id: string) {
  return {
    id,
    displayName: id,
    binary: id,
    tiers: { high: 'h', med: 'm', low: 'l' },
    defaultTier: 'med',
    requiredEnv: [],
    defaultTimeoutMs: 1000,
  };
}
