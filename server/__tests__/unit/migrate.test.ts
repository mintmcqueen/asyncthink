import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { migrateV1Ledger } from '../../src/migrate.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-migrate-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('migrateV1Ledger', () => {
  it('renames a v1 ledger.json to ledger.v1.json.bak with a stderr warning', () => {
    const v1Path = join(tmp, 'ledger.json');
    writeFileSync(
      v1Path,
      JSON.stringify({
        tasks: { 'sess::demo': { id: 'sess::demo', topic: 'x', status: 'running' } },
        lastUpdated: '2025-01-01T00:00:00Z',
      })
    );
    const r = migrateV1Ledger(tmp);
    expect(r.performed).toBe(true);
    expect(r.from).toBe(v1Path);
    expect(r.to).toBe(join(tmp, 'ledger.v1.json.bak'));
    expect(r.warning).toContain('Migrated v1 ledger');
    expect(existsSync(v1Path)).toBe(false);
    expect(existsSync(join(tmp, 'ledger.v1.json.bak'))).toBe(true);
  });

  it('is a no-op when no v1 ledger exists', () => {
    const r = migrateV1Ledger(tmp);
    expect(r.performed).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it('is idempotent on a second invocation (file already migrated)', () => {
    writeFileSync(join(tmp, 'ledger.json'), '{}');
    expect(migrateV1Ledger(tmp).performed).toBe(true);
    expect(migrateV1Ledger(tmp).performed).toBe(false);
  });
});
