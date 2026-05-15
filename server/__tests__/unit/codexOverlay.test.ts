/**
 * v2.5.0 — codex $CODEX_HOME overlay materializer tests.
 *
 * Validates:
 *  - Overlay path is sanitized + scoped under tmpdir.
 *  - config.toml emits only allowlisted [mcp_servers.<name>] blocks.
 *  - Source config sections (including subtables and quoted names) extract
 *    correctly.
 *  - Auth.json is hardlinked when present in source; skipped when absent.
 *  - Cleanup is idempotent + best-effort.
 *  - Allowlisted names absent from the user's config are silently skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  materializeCodexOverlay,
  cleanupCodexOverlay,
  __testing,
} from '../../src/adapters/codexOverlay.js';

const { overlayPathForThread, sanitizeThreadId, extractServerSection } =
  __testing;

let realCodexHome: string;

beforeEach(async () => {
  realCodexHome = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-fake-codex-home-'));
});

afterEach(async () => {
  try {
    await fsp.rm(realCodexHome, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('sanitizeThreadId', () => {
  it('replaces non-alphanumerics with underscore', () => {
    expect(sanitizeThreadId('chain-abc::fork-1')).toBe('chain-abc__fork-1');
    expect(sanitizeThreadId('t-abc/with\\slashes')).toBe('t-abc_with_slashes');
  });

  it('caps length at 80', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeThreadId(long).length).toBe(80);
  });

  it('keeps dots, hyphens, underscores', () => {
    expect(sanitizeThreadId('tsk-abc-123_def.456')).toBe('tsk-abc-123_def.456');
  });
});

describe('overlayPathForThread', () => {
  it('returns a path under tmpdir/asyncthink/codex-overlay', () => {
    const p = overlayPathForThread('chain-abc::fork-1');
    expect(p).toMatch(/asyncthink\/codex-overlay\/chain-abc__fork-1$/);
    expect(p.startsWith(tmpdir())).toBe(true);
  });
});

describe('extractServerSection', () => {
  it('returns null when name absent from source config', () => {
    const cfg = '[other]\nfoo = "bar"\n';
    expect(extractServerSection(cfg, 'sequentialthinking')).toBeNull();
  });

  it('extracts a basic bare-name table', () => {
    const cfg = `
[mcp_servers.sequentialthinking]
command = "npx"
args = ["-y", "sequentialthinking"]

[mcp_servers.other]
command = "other"
`;
    const out = extractServerSection(cfg, 'sequentialthinking');
    expect(out).toContain('[mcp_servers.sequentialthinking]');
    expect(out).toContain('command = "npx"');
    expect(out).not.toContain('[mcp_servers.other]');
  });

  it('extracts a quoted-name table', () => {
    const cfg = `
[mcp_servers."context7"]
url = "https://example.com"
`;
    const out = extractServerSection(cfg, 'context7');
    expect(out).toContain('[mcp_servers."context7"]');
    expect(out).toContain('url = "https://example.com"');
  });

  it('includes subtables of the matched server', () => {
    const cfg = `
[mcp_servers.foo]
command = "bar"

[mcp_servers.foo.env]
TOKEN = "abc"

[mcp_servers.unrelated]
command = "x"
`;
    const out = extractServerSection(cfg, 'foo');
    expect(out).toContain('[mcp_servers.foo]');
    expect(out).toContain('[mcp_servers.foo.env]');
    expect(out).toContain('TOKEN = "abc"');
    expect(out).not.toContain('[mcp_servers.unrelated]');
  });

  it('stops at the next top-level section that is not a subtable', () => {
    const cfg = `
[mcp_servers.foo]
command = "x"

[sandbox]
mode = "read-only"
`;
    const out = extractServerSection(cfg, 'foo');
    expect(out).not.toContain('[sandbox]');
  });
});

describe('materializeCodexOverlay', () => {
  it('creates the overlay dir + writes config.toml', async () => {
    const result = await materializeCodexOverlay({
      threadId: 'test-thread-1',
      allowedServers: ['sequentialthinking'],
      realCodexHome,
    });
    expect(existsSync(result.overlayPath)).toBe(true);
    expect(existsSync(join(result.overlayPath, 'config.toml'))).toBe(true);
    await cleanupCodexOverlay('test-thread-1');
  });

  it('passes through allowed mcp_servers from source config', async () => {
    await fsp.writeFile(
      join(realCodexHome, 'config.toml'),
      `
[mcp_servers.sequentialthinking]
command = "npx"
args = ["-y", "sequentialthinking"]

[mcp_servers.evil-server]
command = "evil"
`
    );
    const result = await materializeCodexOverlay({
      threadId: 'test-thread-2',
      allowedServers: ['sequentialthinking', 'context7'],
      realCodexHome,
    });
    const cfg = await fsp.readFile(
      join(result.overlayPath, 'config.toml'),
      'utf8'
    );
    expect(cfg).toContain('[mcp_servers.sequentialthinking]');
    expect(cfg).toContain('command = "npx"');
    expect(cfg).not.toContain('[mcp_servers.evil-server]');
    expect(cfg).not.toContain('evil');
    expect(result.sourceConfigPresent).toBe(true);
    expect(result.emittedServers).toBe(1); // context7 not in source
    await cleanupCodexOverlay('test-thread-2');
  });

  it('silently drops allowed names not in source config', async () => {
    await fsp.writeFile(
      join(realCodexHome, 'config.toml'),
      '[mcp_servers.sequentialthinking]\ncommand = "x"\n'
    );
    const result = await materializeCodexOverlay({
      threadId: 'test-thread-3',
      allowedServers: ['context7', 'repo-rag'],
      realCodexHome,
    });
    const cfg = await fsp.readFile(
      join(result.overlayPath, 'config.toml'),
      'utf8'
    );
    expect(cfg).not.toContain('[mcp_servers.context7]');
    expect(cfg).not.toContain('[mcp_servers.repo-rag]');
    expect(result.emittedServers).toBe(0);
    await cleanupCodexOverlay('test-thread-3');
  });

  it('emits a stub-only config when source config is missing', async () => {
    // No config.toml in realCodexHome (the dir exists but empty).
    const result = await materializeCodexOverlay({
      threadId: 'test-thread-4',
      allowedServers: ['sequentialthinking'],
      realCodexHome,
    });
    expect(result.sourceConfigPresent).toBe(false);
    expect(result.emittedServers).toBe(0);
    const cfg = await fsp.readFile(
      join(result.overlayPath, 'config.toml'),
      'utf8'
    );
    expect(cfg).toContain('AsyncThink');
    // No actual server table (the placeholder `[mcp_servers.<name>]` in the
    // header is a literal; an actual table would have a real name with no `<>`).
    expect(cfg).not.toMatch(/^\[mcp_servers\.[a-zA-Z]/m);
    await cleanupCodexOverlay('test-thread-4');
  });

  it('hardlinks auth.json when present in source', async () => {
    await fsp.writeFile(join(realCodexHome, 'auth.json'), '{"token":"abc"}');
    const result = await materializeCodexOverlay({
      threadId: 'test-thread-5',
      allowedServers: [],
      realCodexHome,
    });
    expect(result.authLinked).toBe(true);
    const overlayAuth = join(result.overlayPath, 'auth.json');
    expect(existsSync(overlayAuth)).toBe(true);
    // Same inode (hardlink semantics).
    const realStat = statSync(join(realCodexHome, 'auth.json'));
    const overlayStat = statSync(overlayAuth);
    expect(overlayStat.ino).toBe(realStat.ino);
    await cleanupCodexOverlay('test-thread-5');
  });

  it('skips auth.json link when source has none', async () => {
    const result = await materializeCodexOverlay({
      threadId: 'test-thread-6',
      allowedServers: [],
      realCodexHome,
    });
    expect(result.authLinked).toBe(false);
    expect(existsSync(join(result.overlayPath, 'auth.json'))).toBe(false);
    await cleanupCodexOverlay('test-thread-6');
  });

  it('is idempotent — re-running rewrites config and preserves overlay path', async () => {
    await fsp.writeFile(
      join(realCodexHome, 'config.toml'),
      '[mcp_servers.foo]\ncommand = "x"\n'
    );
    const r1 = await materializeCodexOverlay({
      threadId: 'test-thread-7',
      allowedServers: ['foo'],
      realCodexHome,
    });
    // Change the allowlist and re-materialize.
    await fsp.writeFile(
      join(realCodexHome, 'config.toml'),
      '[mcp_servers.bar]\ncommand = "y"\n'
    );
    const r2 = await materializeCodexOverlay({
      threadId: 'test-thread-7',
      allowedServers: ['bar'],
      realCodexHome,
    });
    expect(r1.overlayPath).toBe(r2.overlayPath);
    const cfg = await fsp.readFile(
      join(r2.overlayPath, 'config.toml'),
      'utf8'
    );
    expect(cfg).toContain('[mcp_servers.bar]');
    expect(cfg).not.toContain('[mcp_servers.foo]');
    await cleanupCodexOverlay('test-thread-7');
  });

  it('sanitizes colons + slashes in threadId for safe path', async () => {
    const result = await materializeCodexOverlay({
      threadId: 'chain-x::fork/y',
      allowedServers: [],
      realCodexHome,
    });
    expect(result.overlayPath).toMatch(/chain-x__fork_y$/);
    await cleanupCodexOverlay('chain-x::fork/y');
  });
});

describe('cleanupCodexOverlay', () => {
  it('removes the overlay dir', async () => {
    const result = await materializeCodexOverlay({
      threadId: 'cleanup-test',
      allowedServers: [],
      realCodexHome,
    });
    expect(existsSync(result.overlayPath)).toBe(true);
    await cleanupCodexOverlay('cleanup-test');
    expect(existsSync(result.overlayPath)).toBe(false);
  });

  it('is idempotent (no error if overlay never existed)', async () => {
    await expect(
      cleanupCodexOverlay('never-existed')
    ).resolves.toBeUndefined();
  });
});
