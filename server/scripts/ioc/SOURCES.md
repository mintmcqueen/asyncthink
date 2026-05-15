# IOC Sources & Attribution

The committed `compromised-packages.json` is a deterministic merge of two
public IOC lists, refreshed via `npm run audit:supply-chain:refresh`.

## Sources

### Cobenian/shai-hulud-detect (primary seed)
- URL: https://github.com/Cobenian/shai-hulud-detect
- File: `compromised-packages.txt` on `main`
- License: **MIT**
- Coverage: 2,100+ confirmed compromised package versions across the
  Sept-2025 → May-2026 npm supply-chain campaigns. Aggregates findings from
  StepSecurity, Wiz.io, Semgrep, JFrog, Socket.dev.
- Tagging in output: `source: "cobenian"`

### Wiz Research IOCs (Shai-Hulud 2.0)
- URL: https://github.com/wiz-sec-public/wiz-research-iocs
- File: `reports/shai-hulud-2-packages.csv` on `main`
- License: no LICENSE file at repo root; README labels content as "public
  indicators of compromise aggregated by Wiz Research". We pull the CSV
  at refresh time and surface its entries with `source: "wiz"`. We do
  not redistribute the original CSV verbatim — entries are normalized
  into our shape (`{name, version, source, kind}`) with the originating
  source preserved per record.
- Tagging in output: `source: "wiz"`

## Optional local enrichment (NOT committed)

### Aikido Intel
- URL: https://malware-list.aikido.dev/malware_predictions.json
- Coverage: ~125,000 npm entries (MALWARE/TELEMETRY/PROTESTWARE classes).
  We filter to MALWARE only.
- License: data license not separately published; the tool (`safe-chain`)
  is AGPL/commercial dual. We do NOT commit Aikido data to this repo.
  Run `npm run audit:supply-chain:refresh -- --with-aikido` to pull a
  local-only enrichment file at `scripts/ioc/aikido-enrichment.json`
  (gitignored). The audit script picks it up automatically when present.
- Tagging in output: `source: "aikido"`

## Refresh cadence

- Default: weekly via `.github/workflows/refresh-ioc.yml` (cron Mon 03:00 UTC).
  Opens a PR with the diff against the previous committed `compromised-packages.json`.
- Incident: re-run `npm run audit:supply-chain:refresh` manually to pick up
  upstream updates immediately.

## Detection layers in `audit-supply-chain.mjs`

1. **Exact `name@version` match** against the merged IOC Map. Failure.
2. **Bun-bootstrapper filename glob** inside `node_modules/` —
   `setup_bun.js`, `bun_environment.js`, `bw_setup.js`. High-signal IOCs
   from Shai-Hulud 2.0, Bitwarden CLI, SAP cap-js campaigns. Failure.
3. **Install-lifecycle script presence** in installed `package.json`
   files. Warning only — our reinstall script uses `--ignore-scripts`,
   so these are diary entries, not RCE.

Out of scope (v2.5):
- Integrity-hash cross-walk: lockfile carries `sha512-…` integrity,
  IOC sources carry tarball `sha256`. Cross-walking requires re-fetching
  and re-hashing tarballs. Deferred.
- Maintainer-change / registry-time-jump detection. Network-bound and
  slow; lives in a separate `audit:supply-chain:remote` if needed.
