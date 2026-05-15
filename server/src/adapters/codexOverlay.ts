/**
 * v2.5.0 — Codex MCP-allowlist enforcement via $CODEX_HOME overlay.
 *
 * The codex CLI (v0.125+) has no per-invocation MCP-server allowlist flag.
 * The `-c 'mcp_servers={}'` override is known broken upstream
 * (https://github.com/openai/codex/issues/16045 — TOML inline-empty-table
 * merges instead of replaces). The clean enforcement primitive is to
 * materialize a temporary CODEX_HOME directory whose `config.toml` contains
 * only the allowed `[mcp_servers.<name>]` tables, then spawn codex with
 * CODEX_HOME pointing at the overlay.
 *
 * Auth handling: if the user authenticates via `codex login` (writes
 * `auth.json` to the real $CODEX_HOME), we hardlink it into the overlay so
 * the same inode is used — token refresh by codex propagates back to the
 * user's real auth.json. If the user authenticates via OPENAI_API_KEY or
 * macOS Keychain (`cli_auth_credentials_store = "keyring"`), auth.json
 * doesn't exist in the source and we skip the link. The env-var path is
 * orthogonal to CODEX_HOME and works either way.
 *
 * Persistence model: one overlay per `threadId`, not per spawn.
 * codex `resumeStrategy: 'native'` requires `sessions/<id>.jsonl` files
 * under CODEX_HOME — a fresh-per-spawn overlay would break multi-turn
 * resume. The overlay is created once per thread, reused for resumes,
 * and reaped via `cleanupCodexOverlay(threadId)` when the thread closes
 * (paired with the existing `thread.close` audit emission).
 *
 * Minimum codex version: 0.125. Earlier versions had unstable mcp_servers
 * schema; v0.125+ stabilized `enabled_tools`/`disabled_tools` per server.
 */

import { promises as fsp, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

/**
 * Sanitize a threadId to a single safe path segment. ThreadIds in
 * AsyncThink can include colons (e.g., `chain-xyz::fork-id`), which are
 * legal on POSIX but reserved in some shells. Map all non-alphanumeric
 * to underscore; bound to 80 chars.
 */
function sanitizeThreadId(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

function overlayPathForThread(threadId: string): string {
  return join(
    tmpdir(),
    'asyncthink',
    'codex-overlay',
    sanitizeThreadId(threadId)
  );
}

function realCodexHomeFromEnv(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
}

/**
 * TOML emitter for a single `[mcp_servers.<name>]` block. We accept either:
 *   - A pass-through extracted from the user's real config.toml (preserves
 *     command/args/env exactly), OR
 *   - A minimal stub (only the section header) for servers we don't have
 *     source config for — codex will fail to start that server gracefully
 *     (it logs and continues unless `required = true`, which we never set).
 *
 * We don't ship a TOML parser dep (security pass: keep the dep tree minimal).
 * Instead we slice the user's config.toml as text using a regex that
 * recognizes `[mcp_servers.<name>]` section headers; the body runs from the
 * header line up to the next top-level header `[xxx]` that's NOT a deeper
 * subtable of `mcp_servers.<name>`.
 */
function extractServerSection(realConfig: string, name: string): string | null {
  // Match `[mcp_servers.<name>]` (case-sensitive — TOML keys are case-sensitive).
  // Allow quoted or bare table keys.
  const safeName = name.replace(/[.\\+*?()|^$\[\]{}]/g, '\\$&');
  const headerRe = new RegExp(
    `^\\[mcp_servers\\.(?:"${safeName}"|${safeName})\\]\\s*$`,
    'm'
  );
  const match = headerRe.exec(realConfig);
  if (!match) return null;
  const start = match.index;
  // Find the next top-level header that's NOT a child of [mcp_servers.<name>.*].
  const after = realConfig.slice(start + match[0].length);
  const nextHeaderRe = /^\[([^\]]+)\]\s*$/gm;
  let nextStart = after.length;
  let m: RegExpExecArray | null;
  while ((m = nextHeaderRe.exec(after)) !== null) {
    const key = m[1];
    // A header like `[mcp_servers."<name>".env]` IS a child — keep going.
    const isChildOfThisServer =
      key.startsWith(`mcp_servers."${name}".`) ||
      key.startsWith(`mcp_servers.${name}.`);
    if (!isChildOfThisServer) {
      nextStart = m.index;
      break;
    }
  }
  return match[0] + after.slice(0, nextStart);
}

export interface MaterializeArgs {
  threadId: string;
  allowedServers: string[];
  /** Override for tests; defaults to detection from env. */
  realCodexHome?: string;
  /** Override for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface MaterializeResult {
  /** Absolute path to the overlay directory; safe to pass as CODEX_HOME env var. */
  overlayPath: string;
  /** True if a real config.toml was found and read; false if we wrote a stub-only overlay. */
  sourceConfigPresent: boolean;
  /** Whether auth.json was linked from the real CODEX_HOME. */
  authLinked: boolean;
  /** Number of [mcp_servers.<name>] tables emitted (may be fewer than allowedServers.length if source config didn't have them). */
  emittedServers: number;
}

/**
 * Materialize a slim CODEX_HOME overlay for the given thread + allowlist.
 *
 * Behavior:
 *   - Creates `<tmpdir>/asyncthink/codex-overlay/<sanitized-threadId>/`.
 *   - Writes `config.toml` containing ONLY [mcp_servers.<name>] tables for
 *     the allowlisted names that exist in the user's real config.toml.
 *     Names not in the user's config are silently dropped (server can't be
 *     launched without command/url anyway).
 *   - If the user has `~/.codex/auth.json`, hardlinks it into the overlay.
 *   - Idempotent: re-running with the same threadId + allowlist + source
 *     config rewrites the overlay; codex re-reads config.toml at startup.
 */
export async function materializeCodexOverlay(
  args: MaterializeArgs
): Promise<MaterializeResult> {
  const overlayPath = overlayPathForThread(args.threadId);
  const env = args.env ?? process.env;
  const realHome = args.realCodexHome ?? realCodexHomeFromEnv(env);

  await fsp.mkdir(overlayPath, { recursive: true });

  // Read source config if present.
  let sourceConfig: string | null = null;
  const sourceConfigPath = join(realHome, 'config.toml');
  if (existsSync(sourceConfigPath)) {
    try {
      sourceConfig = await fsp.readFile(sourceConfigPath, 'utf8');
    } catch {
      sourceConfig = null;
    }
  }

  // Emit slim config.toml.
  const header =
    '# Generated by AsyncThink — slim $CODEX_HOME overlay for MCP-allowlist enforcement.\n' +
    '# Only allowlisted [mcp_servers.<name>] tables are present; codex falls back\n' +
    "# to built-in defaults for model, sandbox, etc. — AsyncThink's adapter passes\n" +
    '# those via CLI flags, so the slim config is intentional.\n\n';

  const blocks: string[] = [];
  let emittedServers = 0;
  if (sourceConfig) {
    for (const name of args.allowedServers) {
      const block = extractServerSection(sourceConfig, name);
      if (block) {
        blocks.push(block.trim());
        emittedServers++;
      }
      // If a name isn't in the user's config, we skip it. Spawning a server
      // requires command/url at minimum, and inventing those is unsafe.
    }
  }

  const configToml = header + blocks.join('\n\n') + (blocks.length ? '\n' : '');
  await fsp.writeFile(join(overlayPath, 'config.toml'), configToml);

  // Hardlink auth.json from the real CODEX_HOME so token refresh propagates.
  let authLinked = false;
  const realAuth = join(realHome, 'auth.json');
  const overlayAuth = join(overlayPath, 'auth.json');
  if (existsSync(realAuth)) {
    try {
      // Remove any existing link first (idempotency).
      if (existsSync(overlayAuth)) {
        await fsp.unlink(overlayAuth);
      }
      await fsp.link(realAuth, overlayAuth);
      authLinked = true;
    } catch {
      // Hardlink can fail across filesystems; fall back to copy is unsafe
      // (token refresh wouldn't propagate). Leave unlinked — env-var or
      // keychain auth still works.
    }
  }

  return {
    overlayPath,
    sourceConfigPresent: sourceConfig !== null,
    authLinked,
    emittedServers,
  };
}

/**
 * Recursively remove the codex overlay for a thread. Idempotent — no error
 * if the overlay doesn't exist. Called by the threadStore close path.
 */
export async function cleanupCodexOverlay(threadId: string): Promise<void> {
  const overlayPath = overlayPathForThread(threadId);
  try {
    await fsp.rm(overlayPath, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Exposed for the threadStore close hook to know whether a thread has an
 * overlay to clean (avoids stat'ing on every close).
 */
export function overlayExists(threadId: string): boolean {
  return existsSync(overlayPathForThread(threadId));
}

/** Exposed for tests + audit. */
export const __testing = {
  overlayPathForThread,
  sanitizeThreadId,
  extractServerSection,
  realCodexHomeFromEnv,
};
