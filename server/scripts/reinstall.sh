#!/usr/bin/env bash
# asyncthink v2.3 — npm run reinstall (R-DIST-D.1)
#
# Thin verifier for the marketplace upgrade flow. Does ONLY safe, idempotent
# steps; never auto-commits, never auto-pushes. Branch-rotation methodology
# stays in charge of git ops.
#
# Usage (from repo root or anywhere):
#   npm run reinstall              # delegates to this script via server/package.json

set -euo pipefail

# Colors
if [ -t 1 ]; then
  RED=$'\033[0;31m'
  YELLOW=$'\033[1;33m'
  GREEN=$'\033[0;32m'
  BOLD=$'\033[1m'
  NC=$'\033[0m'
else
  RED=""
  YELLOW=""
  GREEN=""
  BOLD=""
  NC=""
fi

# Resolve repo root from this script's location: server/scripts/reinstall.sh → repo root is two dirs up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

echo "${BOLD}asyncthink reinstall verifier${NC}"
echo "Repo root: ${REPO_ROOT}"
echo

# ─── Step 1: version triple ───────────────────────────────────────────────
echo "${BOLD}[1/6]${NC} Checking version triple..."

MKT_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')).plugins[0].version)")
PLUGIN_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')).version)")
PKG_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('server/package.json','utf8')).version)")

echo "  .claude-plugin/marketplace.json: ${MKT_VER}"
echo "  .claude-plugin/plugin.json:      ${PLUGIN_VER}"
echo "  server/package.json:             ${PKG_VER}"

if [ "${MKT_VER}" != "${PLUGIN_VER}" ] || [ "${PLUGIN_VER}" != "${PKG_VER}" ]; then
  echo "${RED}✗ Version triple disagrees. Fix all three to match before running this script again.${NC}" >&2
  exit 1
fi

VERSION="${MKT_VER}"
echo "${GREEN}✓ Version triple agrees: ${VERSION}${NC}"
echo

# ─── Step 2: git state (warning only) ─────────────────────────────────────
echo "${BOLD}[2/6]${NC} Checking git state..."

if [ -n "$(git status --porcelain)" ]; then
  echo "${YELLOW}⚠ Working tree has uncommitted changes; install will use the pushed origin/develop tip${NC}"
fi

# Only warn about unpushed; never fail.
AHEAD=$(git rev-list --count origin/develop..HEAD 2>/dev/null || echo "?")
if [ "${AHEAD}" != "0" ] && [ "${AHEAD}" != "?" ]; then
  echo "${YELLOW}⚠ HEAD is ${AHEAD} commits ahead of origin/develop; install will NOT see those commits${NC}"
  echo "${YELLOW}   Push to origin/develop first (e.g. \`git push\`) for the bump to take effect.${NC}"
fi
echo

# ─── Step 3: marketplace update ───────────────────────────────────────────
echo "${BOLD}[3/6]${NC} Running: claude plugin marketplace update asyncthink-local"
if claude plugin marketplace update asyncthink-local; then
  echo "${GREEN}✓ Marketplace metadata refreshed${NC}"
else
  echo "${YELLOW}⚠ Marketplace update returned non-zero; continuing${NC}"
fi
echo

# ─── Step 4: install ──────────────────────────────────────────────────────
echo "${BOLD}[4/6]${NC} Running: claude plugin install asyncthink@asyncthink-local"
if claude plugin install asyncthink@asyncthink-local; then
  echo "${GREEN}✓ Plugin installed${NC}"
else
  echo "${RED}✗ Plugin install failed${NC}" >&2
  exit 1
fi
echo

# ─── Step 5: verify bookmark ──────────────────────────────────────────────
echo "${BOLD}[5/6]${NC} Reading installed bookmark..."

BOOKMARK="$HOME/.claude/plugins/installed_plugins.json"
if [ -f "${BOOKMARK}" ]; then
  node -e "
    const b = JSON.parse(require('fs').readFileSync('${BOOKMARK}','utf8'));
    const entry = (b.plugins['asyncthink@asyncthink-local'] || [])[0];
    if (!entry) { console.error('No asyncthink@asyncthink-local entry found'); process.exit(1); }
    console.log('  version:        ' + entry.version);
    console.log('  installPath:    ' + entry.installPath);
    console.log('  gitCommitSha:   ' + entry.gitCommitSha);
    console.log('  installedAt:    ' + entry.installedAt);
    if (entry.version !== '${VERSION}') {
      console.error('${RED}⚠ Bookmark version (' + entry.version + ') does not match expected (${VERSION}). Did you push origin/develop?${NC}');
    }
  "
else
  echo "${YELLOW}⚠ No bookmark file at ${BOOKMARK} (unusual)${NC}"
fi
echo

# ─── Step 6: restart reminder ─────────────────────────────────────────────
echo "${BOLD}[6/6]${NC}"
echo "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${BOLD}  Restart Claude Code now: exit and re-launch.  /clear is insufficient.${NC}"
echo "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
