/**
 * v2.5.0 — audit-supply-chain.mjs regression tests.
 *
 * Spawns the script as a subprocess against synthetic test fixtures
 * (IOC list + lockfile) and asserts: exit code, JSON shape, structured
 * report contents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fsp, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'audit-supply-chain.mjs');

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-supply-audit-'));
});

afterEach(async () => {
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* */
  }
});

interface IocEntry {
  name: string;
  version: string;
  source: string;
  kind?: string;
}

interface LockfileEntry {
  name: string;
  version: string;
}

function setup(opts: {
  ioc?: IocEntry[];
  iocMissing?: boolean;
  iocCorrupt?: boolean;
  lockfile?: Record<string, LockfileEntry | unknown>;
  lockfileMissing?: boolean;
}): { server: string; env: NodeJS.ProcessEnv } {
  // Materialize a fake server tree at <tmp>/server/.
  const serverDir = join(tmp, 'server');
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(join(serverDir, 'scripts', 'ioc'), { recursive: true });

  // IOC list.
  if (!opts.iocMissing) {
    const iocPath = join(serverDir, 'scripts', 'ioc', 'compromised-packages.json');
    if (opts.iocCorrupt) {
      writeFileSync(iocPath, '{this is not json');
    } else {
      const packages = opts.ioc ?? [];
      writeFileSync(
        iocPath,
        JSON.stringify(
          {
            lastRefreshed: '2026-05-15',
            sourceCounts: { cobenian: packages.length, wiz: 0 },
            totalUnique: packages.length,
            packages,
          },
          null,
          2
        )
      );
    }
  }

  // Lockfile.
  if (!opts.lockfileMissing) {
    const lockPath = join(serverDir, 'package-lock.json');
    const pkgs: Record<string, unknown> = { '': { name: 'asyncthink', version: '2.5.0' } };
    for (const [key, entry] of Object.entries(opts.lockfile ?? {})) {
      pkgs[key] = entry;
    }
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          name: 'asyncthink',
          lockfileVersion: 3,
          requires: true,
          packages: pkgs,
        },
        null,
        2
      )
    );
  }

  return {
    server: serverDir,
    env: { ...process.env },
  };
}

function runAudit(serverDir: string, env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
} {
  // Copy the script into the fake tree so __dirname-based path resolution lands
  // inside our temp scripts/ dir.
  const scriptDst = join(serverDir, 'scripts', 'audit-supply-chain.mjs');
  const scriptSrc = SCRIPT;
  const copyResult = spawnSync('cp', [scriptSrc, scriptDst]);
  if (copyResult.status !== 0) {
    throw new Error(`failed to copy script: ${copyResult.stderr}`);
  }
  const result = spawnSync('node', [scriptDst], { env, encoding: 'utf8' });
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
  };
}

describe('audit-supply-chain — exit codes', () => {
  it('exit 0 on clean lockfile + no node_modules', () => {
    const { server, env } = setup({
      ioc: [{ name: 'chalk', version: '5.6.1', source: 'cobenian', kind: 'malware' }],
      lockfile: {
        'node_modules/chalk': { name: 'chalk', version: '5.6.2' },
        'node_modules/zod': { name: 'zod', version: '4.1.13' },
      },
    });
    const r = runAudit(server, env);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({
      summary: {
        compromisedVersionHits: 0,
        lockfileEntriesScanned: 2,
      },
    });
  });

  it('exit 1 on a compromised-version match', () => {
    const { server, env } = setup({
      ioc: [{ name: 'chalk', version: '5.6.1', source: 'cobenian', kind: 'malware' }],
      lockfile: {
        'node_modules/chalk': { name: 'chalk', version: '5.6.1' },
      },
    });
    const r = runAudit(server, env);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({
      summary: { compromisedVersionHits: 1 },
      failures: {
        compromisedVersions: [
          {
            name: 'chalk',
            version: '5.6.1',
            source: 'cobenian',
            kind: 'malware',
          },
        ],
      },
    });
    expect(r.stderr).toContain('✗ 1 compromised version(s) detected');
  });

  it('exit 2 when IOC list is missing', () => {
    const { server, env } = setup({ iocMissing: true });
    const r = runAudit(server, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('IOC list missing');
  });

  it('exit 2 when IOC list is corrupt', () => {
    const { server, env } = setup({ iocCorrupt: true });
    const r = runAudit(server, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('IOC list corrupt');
  });

  it('exit 2 when lockfile is missing', () => {
    const { server, env } = setup({ ioc: [], lockfileMissing: true });
    const r = runAudit(server, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('No lockfile');
  });

  it('catches scoped packages (axios-style: @scope/name)', () => {
    const { server, env } = setup({
      ioc: [
        {
          name: '@cap-js/sqlite',
          version: '2.2.2',
          source: 'cobenian',
          kind: 'malware',
        },
      ],
      lockfile: {
        'node_modules/@cap-js/sqlite': { name: '@cap-js/sqlite', version: '2.2.2' },
      },
    });
    const r = runAudit(server, env);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({
      summary: { compromisedVersionHits: 1 },
      failures: {
        compromisedVersions: [
          {
            name: '@cap-js/sqlite',
            version: '2.2.2',
          },
        ],
      },
    });
  });

  it('multiple hits all reported', () => {
    const { server, env } = setup({
      ioc: [
        { name: 'axios', version: '1.14.1', source: 'cobenian', kind: 'malware' },
        { name: 'node-ipc', version: '9.1.6', source: 'wiz', kind: 'malware' },
      ],
      lockfile: {
        'node_modules/axios': { name: 'axios', version: '1.14.1' },
        'node_modules/node-ipc': { name: 'node-ipc', version: '9.1.6' },
        'node_modules/clean-dep': { name: 'clean-dep', version: '1.0.0' },
      },
    });
    const r = runAudit(server, env);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({
      summary: {
        compromisedVersionHits: 2,
        lockfileEntriesScanned: 3,
      },
    });
  });
});

describe('audit-supply-chain — JSON report shape', () => {
  it('top-level structure has summary, sourceCounts, failures, warnings', () => {
    const { server, env } = setup({
      ioc: [{ name: 'chalk', version: '5.6.1', source: 'cobenian', kind: 'malware' }],
      lockfile: { 'node_modules/zod': { name: 'zod', version: '4.1.13' } },
    });
    const r = runAudit(server, env);
    expect(r.json).toHaveProperty('summary');
    expect(r.json).toHaveProperty('sourceCounts');
    expect(r.json).toHaveProperty('failures.compromisedVersions');
    expect(r.json).toHaveProperty('failures.bootstrapperFiles');
    expect(r.json).toHaveProperty('warnings.installScripts');
  });

  it('preserves IOC metadata (source, kind, reason) on hits', () => {
    const { server, env } = setup({
      ioc: [
        {
          name: 'evil',
          version: '0.0.7',
          source: 'aikido',
          kind: 'malware',
        },
      ],
      lockfile: { 'node_modules/evil': { name: 'evil', version: '0.0.7' } },
    });
    const r = runAudit(server, env);
    expect(r.status).toBe(1);
    const json = r.json as { failures: { compromisedVersions: { source: string; kind: string }[] } };
    expect(json.failures.compromisedVersions[0]).toMatchObject({
      source: 'aikido',
      kind: 'malware',
    });
  });
});
