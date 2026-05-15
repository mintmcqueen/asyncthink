#!/usr/bin/env node
/**
 * audit-supply-chain.mjs — scan server/package-lock.json for known-compromised
 * npm packages, plus opportunistic warnings on attack-tradecraft signatures
 * inside node_modules.
 *
 * Complements `npm audit`:
 *   - `npm audit` queries the GitHub Advisory Database, which lags real-world
 *     discovery by hours-to-days.
 *   - This script reads a locally-committed IOC list (Cobenian + Wiz) that
 *     catches Shai-Hulud / Mini Shai-Hulud / axios / node-ipc / Bitwarden /
 *     SAP campaign versions the moment the IOC list is refreshed.
 *
 * Detection layers:
 *   1. Exact `name@version` match against the IOC Map.            (failure)
 *   2. Bun-bootstrapper filename glob inside node_modules.        (failure)
 *   3. `preinstall` / `install` / `postinstall` script presence
 *      in installed package.json files.                           (warning)
 *
 * Exit codes:
 *   0 — no matches
 *   1 — one or more matches (failure-class)
 *   2 — IOC list missing or corrupt
 *
 * Output:
 *   stdout — structured JSON report
 *   stderr — human-readable summary
 *
 * Run: npm run audit:supply-chain
 *
 * The committed IOC file covers Cobenian (MIT) + Wiz Research IOCs.
 * Optional local enrichment (Aikido feed, ~125k entries) is picked up
 * automatically if scripts/ioc/aikido-enrichment.json exists locally
 * (refresh-ioc.mjs --with-aikido populates it).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, '..');

const IOC_PATH = join(__dirname, 'ioc', 'compromised-packages.json');
const AIKIDO_PATH = join(__dirname, 'ioc', 'aikido-enrichment.json');
const LOCKFILE_PATH = join(SERVER_ROOT, 'package-lock.json');
const NODE_MODULES = join(SERVER_ROOT, 'node_modules');

// Filenames dropped by recent campaigns (Shai-Hulud 2.0, Bitwarden, SAP
// cap-js). Bun-runtime drops are specific enough to flag unconditionally;
// other ambiguous names (setup.mjs, execution.js) are intentionally OUT to
// keep the false-positive rate at zero.
const ALWAYS_FLAG = new Set([
  'setup_bun.js',
  'bun_environment.js',
  'bw_setup.js',
]);

function loadIocList() {
  if (!existsSync(IOC_PATH)) {
    console.error(
      `[audit:supply-chain] IOC list missing at ${IOC_PATH}. Run npm run audit:supply-chain:refresh.`
    );
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(IOC_PATH, 'utf8'));
  } catch (err) {
    console.error(
      `[audit:supply-chain] IOC list corrupt (${err.message}). Re-run refresh.`
    );
    process.exit(2);
  }
  const map = new Map();
  for (const p of raw.packages ?? []) {
    if (!p?.name || !p?.version) continue;
    map.set(`${p.name}@${p.version}`, p);
  }
  // Optional Aikido enrichment.
  if (existsSync(AIKIDO_PATH)) {
    try {
      const aikRaw = JSON.parse(readFileSync(AIKIDO_PATH, 'utf8'));
      for (const p of aikRaw.packages ?? []) {
        if (!p?.name || !p?.version) continue;
        const k = `${p.name}@${p.version}`;
        if (!map.has(k)) map.set(k, p);
      }
    } catch {
      // best-effort enrichment; ignore parse errors
    }
  }
  return {
    map,
    lastRefreshed: raw.lastRefreshed,
    sourceCounts: raw.sourceCounts,
    aikidoLoaded: existsSync(AIKIDO_PATH),
  };
}

function loadLockfile() {
  if (!existsSync(LOCKFILE_PATH)) {
    console.error(`[audit:supply-chain] No lockfile at ${LOCKFILE_PATH}.`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(LOCKFILE_PATH, 'utf8'));
  } catch (err) {
    console.error(`[audit:supply-chain] Lockfile parse failed: ${err.message}`);
    process.exit(2);
  }
}

function checkLockfile(lockfile, iocMap) {
  const hits = [];
  for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    if (!entry?.name || !entry?.version) {
      // Some lockfile entries lack `name`; derive from key.
      entry.name = entry.name ?? key.split('node_modules/').pop();
    }
    const name = entry.name ?? key.split('node_modules/').pop();
    const lookupKey = `${name}@${entry.version}`;
    const ioc = iocMap.get(lookupKey);
    if (ioc) {
      hits.push({
        name,
        version: entry.version,
        path: key,
        source: ioc.source,
        kind: ioc.kind,
        ...(ioc.reason ? { reason: ioc.reason } : {}),
      });
    }
  }
  return hits;
}

function scanBootstrapperFiles() {
  if (!existsSync(NODE_MODULES)) return [];
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return; // bounded
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip nested node_modules to keep the walk bounded; the lockfile
        // walk handles transitive deps.
        if (ent.name === 'node_modules' && depth > 0) continue;
        walk(full, depth + 1);
      } else if (ent.isFile() && ALWAYS_FLAG.has(ent.name)) {
        hits.push({ file: ent.name, path: full });
      }
    }
  };
  walk(NODE_MODULES, 0);
  return hits;
}

function scanInstallScripts() {
  if (!existsSync(NODE_MODULES)) return [];
  const warnings = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Each direct subdir of node_modules (and one level of @scope/) is
        // a package; check its package.json.
        if (ent.name === 'node_modules' && depth > 0) continue;
        const pkgJson = join(full, 'package.json');
        try {
          const st = statSync(pkgJson);
          if (st.isFile()) {
            try {
              const j = JSON.parse(readFileSync(pkgJson, 'utf8'));
              const scripts = j.scripts ?? {};
              const presentLifecycle = ['preinstall', 'install', 'postinstall'].filter(
                (k) => typeof scripts[k] === 'string' && scripts[k].length > 0
              );
              if (presentLifecycle.length > 0) {
                warnings.push({
                  package: j.name ?? ent.name,
                  version: j.version,
                  scripts: presentLifecycle.reduce((acc, k) => {
                    acc[k] = scripts[k];
                    return acc;
                  }, {}),
                });
              }
            } catch {
              /* unreadable package.json — skip */
            }
          }
        } catch {
          /* no package.json — recurse for @scope dirs */
        }
        walk(full, depth + 1);
      }
    }
  };
  walk(NODE_MODULES, 0);
  return warnings;
}

function main() {
  const { map, lastRefreshed, sourceCounts, aikidoLoaded } = loadIocList();
  const lockfile = loadLockfile();

  const versionHits = checkLockfile(lockfile, map);
  const bootstrapperHits = scanBootstrapperFiles();
  const scriptWarnings = scanInstallScripts();

  const totalLockfileEntries = Object.keys(lockfile.packages ?? {}).filter(
    (k) => k.startsWith('node_modules/')
  ).length;

  const report = {
    summary: {
      iocLastRefreshed: lastRefreshed,
      iocEntries: map.size,
      aikidoEnrichment: aikidoLoaded,
      lockfileEntriesScanned: totalLockfileEntries,
      compromisedVersionHits: versionHits.length,
      bootstrapperFileHits: bootstrapperHits.length,
      installScriptWarnings: scriptWarnings.length,
    },
    sourceCounts,
    failures: {
      compromisedVersions: versionHits,
      bootstrapperFiles: bootstrapperHits,
    },
    warnings: {
      installScripts: scriptWarnings,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  // stderr summary (human-readable).
  console.error(
    `[audit:supply-chain] IOC list: ${map.size} entries (refreshed ${lastRefreshed}${aikidoLoaded ? ', + aikido enrichment' : ''})`
  );
  console.error(
    `[audit:supply-chain] Scanned ${totalLockfileEntries} lockfile entries.`
  );
  if (scriptWarnings.length > 0) {
    console.error(
      `[audit:supply-chain] ⚠ ${scriptWarnings.length} package(s) declare install lifecycle scripts (defensive note — your installs use --ignore-scripts, so these did NOT execute):`
    );
    for (const w of scriptWarnings) {
      console.error(`  - ${w.package}@${w.version}: ${Object.keys(w.scripts).join(',')}`);
    }
  }
  if (versionHits.length === 0 && bootstrapperHits.length === 0) {
    console.error('[audit:supply-chain] ✓ No compromised versions or known bootstrapper signatures detected.');
    process.exit(0);
  }
  if (versionHits.length > 0) {
    console.error(
      `[audit:supply-chain] ✗ ${versionHits.length} compromised version(s) detected:`
    );
    for (const h of versionHits) {
      console.error(
        `  - ${h.name}@${h.version} (source: ${h.source}${h.kind ? `, kind: ${h.kind}` : ''})`
      );
    }
  }
  if (bootstrapperHits.length > 0) {
    console.error(
      `[audit:supply-chain] ✗ ${bootstrapperHits.length} known-bootstrapper file(s) detected:`
    );
    for (const h of bootstrapperHits) {
      console.error(`  - ${h.file} at ${h.path}`);
    }
  }
  process.exit(1);
}

main();
