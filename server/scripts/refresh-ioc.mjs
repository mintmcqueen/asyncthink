#!/usr/bin/env node
/**
 * refresh-ioc.mjs — pulls public IOC feeds and writes a deterministic merged
 * JSON to scripts/ioc/compromised-packages.json.
 *
 * Sources (default — committed to repo):
 *   - Cobenian/shai-hulud-detect compromised-packages.txt (MIT)
 *     2,100+ confirmed bad versions across Sept-2025 → May-2026 campaigns.
 *   - wiz-sec-public/wiz-research-iocs shai-hulud-2-packages.csv (Wiz Research,
 *     public IOCs — link-only attribution; not redistributed verbatim).
 *
 * Optional enrichment (`--with-aikido`; NOT committed):
 *   - Aikido malware_predictions.json (live, ~125k entries; mirrorable).
 *     Written to scripts/ioc/aikido-enrichment.json which is .gitignored.
 *     Audit picks it up automatically if present.
 *
 * Run: npm run audit:supply-chain:refresh [--with-aikido]
 * Cadence: weekly via .github/workflows/refresh-ioc.yml; manual on incident.
 *
 * Committed file shape (deterministic, sorted, stable):
 *   {
 *     lastRefreshed: <YYYY-MM-DD>,
 *     sourceCounts: { cobenian: N, wiz: N },
 *     totalUnique: N,
 *     packages: [ { name, version, source, kind } ]
 *   }
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, 'ioc', 'compromised-packages.json');
const AIKIDO_PATH = join(__dirname, 'ioc', 'aikido-enrichment.json');
const WITH_AIKIDO = process.argv.includes('--with-aikido');

const SRC = {
  cobenian:
    'https://raw.githubusercontent.com/Cobenian/shai-hulud-detect/main/compromised-packages.txt',
  wiz: 'https://raw.githubusercontent.com/wiz-sec-public/wiz-research-iocs/main/reports/shai-hulud-2-packages.csv',
  aikido: 'https://malware-list.aikido.dev/malware_predictions.json',
};

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseCobenian(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Format: "ecosystem:name:version" OR "name:version" (defaults to npm).
    // Handle scoped packages: "@scope/name:version" or "npm:@scope/name:version".
    let body = trimmed;
    if (trimmed.startsWith('npm:')) body = trimmed.slice('npm:'.length);
    else if (trimmed.startsWith('pypi:')) continue;
    else if (trimmed.startsWith('rubygems:')) continue;
    // body is now name:version, where name can contain @ for scopes.
    // Split on the LAST colon.
    const lastColon = body.lastIndexOf(':');
    if (lastColon <= 0) continue;
    const name = body.slice(0, lastColon).trim();
    const version = body.slice(lastColon + 1).trim();
    if (!name || !version) continue;
    out.push({ name, version, source: 'cobenian', kind: 'malware' });
  }
  return out;
}

function parseWiz(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  // Skip header "Package,Version"
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Format: "name,= version" (= prefix for exact constraint).
    const comma = line.lastIndexOf(',');
    if (comma <= 0) continue;
    const name = line.slice(0, comma).trim();
    let version = line.slice(comma + 1).trim();
    if (version.startsWith('=')) version = version.slice(1).trim();
    if (!name || !version) continue;
    out.push({ name, version, source: 'wiz', kind: 'malware' });
  }
  return out;
}

function parseAikido(json) {
  // Aikido feed shape: array of {package_name, version, reason} entries.
  // reason ∈ { MALWARE, TELEMETRY, PROTESTWARE }.
  const out = [];
  if (!Array.isArray(json)) return out;
  for (const entry of json) {
    if (!entry || typeof entry !== 'object') continue;
    const name = entry.package_name ?? entry.name;
    const version = entry.version;
    const reason = String(entry.reason ?? '').toUpperCase();
    if (typeof name !== 'string' || typeof version !== 'string') continue;
    if (!name || !version) continue;
    // We ship MALWARE only; TELEMETRY and PROTESTWARE are noisier and out
    // of scope for a "did your supply chain get owned" gate.
    if (reason && reason !== 'MALWARE') continue;
    out.push({
      name,
      version,
      source: 'aikido',
      kind: 'malware',
      ...(entry.reason ? { reason: entry.reason } : {}),
    });
  }
  return out;
}

async function main() {
  const counts = { cobenian: 0, wiz: 0 };
  const merged = new Map(); // "name@version" → entry

  // Cobenian (required)
  try {
    const text = await fetchText(SRC.cobenian);
    const entries = parseCobenian(text);
    counts.cobenian = entries.length;
    for (const e of entries) {
      const key = `${e.name}@${e.version}`;
      if (!merged.has(key)) merged.set(key, e);
    }
    console.error(`[refresh-ioc] cobenian: ${entries.length} entries`);
  } catch (err) {
    console.error(`[refresh-ioc] cobenian FAILED: ${err.message}`);
    process.exit(2);
  }

  // Wiz (required)
  try {
    const text = await fetchText(SRC.wiz);
    const entries = parseWiz(text);
    counts.wiz = entries.length;
    for (const e of entries) {
      const key = `${e.name}@${e.version}`;
      if (!merged.has(key)) merged.set(key, e);
    }
    console.error(`[refresh-ioc] wiz: ${entries.length} entries`);
  } catch (err) {
    console.error(`[refresh-ioc] wiz FAILED: ${err.message}`);
    process.exit(2);
  }

  // Deterministic order: sort by name, then version.
  const packages = [...merged.values()].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.version < b.version ? -1 : 1;
  });

  const out = {
    lastRefreshed: new Date().toISOString().split('T')[0], // YYYY-MM-DD (stable for diffs)
    sourceCounts: counts,
    totalUnique: packages.length,
    packages,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.error(
    `[refresh-ioc] wrote ${OUT_PATH} — ${packages.length} unique committed entries`
  );

  // Optional Aikido enrichment — large, NOT committed.
  if (WITH_AIKIDO) {
    try {
      const text = await fetchText(SRC.aikido, 30000);
      const json = JSON.parse(text);
      const entries = parseAikido(json);
      const aikidoOut = {
        lastRefreshed: new Date().toISOString().split('T')[0],
        sourceCount: entries.length,
        packages: entries.sort((a, b) => {
          if (a.name !== b.name) return a.name < b.name ? -1 : 1;
          return a.version < b.version ? -1 : 1;
        }),
      };
      writeFileSync(AIKIDO_PATH, JSON.stringify(aikidoOut, null, 2) + '\n');
      console.error(
        `[refresh-ioc] wrote ${AIKIDO_PATH} — ${entries.length} aikido entries (gitignored)`
      );
    } catch (err) {
      console.error(
        `[refresh-ioc] aikido SKIPPED (${err.message}); continuing without`
      );
    }
  } else {
    console.error(
      '[refresh-ioc] (Aikido enrichment skipped; pass --with-aikido for local +123k extra entries)'
    );
  }
}

main().catch((err) => {
  console.error(`[refresh-ioc] FATAL: ${err.stack ?? err.message}`);
  process.exit(2);
});
