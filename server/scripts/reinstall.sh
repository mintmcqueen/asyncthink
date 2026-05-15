#!/usr/bin/env bash
# asyncthink — npm run reinstall
#
# Thin verifier for the marketplace upgrade flow. Does ONLY safe, idempotent
# steps; never auto-commits, never auto-pushes. Branch-rotation methodology
# stays in charge of git ops.
#
# v2.3.1 (R-DIST-D.1): introduced. Verifies version triple + runs install.
# v2.3.2: two fixes:
#   - "already installed" no-op falls back to `claude plugin update`.
#   - Cache install path is checked for `server/node_modules/`; if absent
#     (a known `update`-vs-`install` gap in the plugin manager), populate via
#     `npm install --omit=dev --ignore-scripts` so the server actually boots.
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
echo "${BOLD}[1/7]${NC} Checking version triple..."

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
echo "${BOLD}[2/7]${NC} Checking git state..."

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
echo "${BOLD}[3/7]${NC} Running: claude plugin marketplace update asyncthink-local"
if claude plugin marketplace update asyncthink-local; then
  echo "${GREEN}✓ Marketplace metadata refreshed${NC}"
else
  echo "${YELLOW}⚠ Marketplace update returned non-zero; continuing${NC}"
fi
echo

# ─── Step 4: install (with update fallback) ───────────────────────────────
echo "${BOLD}[4/7]${NC} Running: claude plugin install asyncthink@asyncthink-local"
# Capture output AND exit code so we can detect the "already installed" no-op
# and fall back to `claude plugin update`. v2.3.2 fix.
set +e
INSTALL_OUT=$(claude plugin install asyncthink@asyncthink-local 2>&1)
INSTALL_RC=$?
set -e
echo "${INSTALL_OUT}"

if [ ${INSTALL_RC} -ne 0 ]; then
  echo "${RED}✗ Plugin install failed (exit ${INSTALL_RC})${NC}" >&2
  exit 1
fi

# Detect the no-op signature. The plugin manager prints
# "Plugin "<name>@<marketplace>" is already installed" when the install path
# is a no-op (an existing bookmark is present). In that case we need an
# explicit `claude plugin update` to actually pull the new version into the
# bookmark.
if echo "${INSTALL_OUT}" | grep -qiE 'already installed|already up.?to.?date'; then
  echo "${YELLOW}⚠ Install was a no-op (bookmark already present). Falling back to update.${NC}"
  echo "${BOLD}    Running: claude plugin update asyncthink@asyncthink-local${NC}"
  if ! claude plugin update asyncthink@asyncthink-local; then
    echo "${RED}✗ Plugin update failed${NC}" >&2
    exit 1
  fi
  echo "${GREEN}✓ Plugin updated${NC}"
else
  echo "${GREEN}✓ Plugin installed${NC}"
fi
echo

# ─── Step 5: verify bookmark ──────────────────────────────────────────────
echo "${BOLD}[5/7]${NC} Reading installed bookmark..."

BOOKMARK="$HOME/.claude/plugins/installed_plugins.json"
INSTALL_PATH=""
if [ -f "${BOOKMARK}" ]; then
  # Capture installPath in addition to printing the entry so step 6 can use it.
  read -r BOOK_VER INSTALL_PATH <<< "$(node -e "
    const b = JSON.parse(require('fs').readFileSync('${BOOKMARK}','utf8'));
    const entry = (b.plugins['asyncthink@asyncthink-local'] || [])[0];
    if (!entry) { console.error('No asyncthink@asyncthink-local entry found'); process.exit(1); }
    process.stdout.write(entry.version + ' ' + entry.installPath);
  ")"
  echo "  version:        ${BOOK_VER}"
  echo "  installPath:    ${INSTALL_PATH}"
  if [ "${BOOK_VER}" != "${VERSION}" ]; then
    echo "${YELLOW}⚠ Bookmark version (${BOOK_VER}) does not match expected (${VERSION}). Did you push origin/develop?${NC}"
  fi
else
  echo "${YELLOW}⚠ No bookmark file at ${BOOKMARK} (unusual)${NC}"
fi
echo

# ─── Step 6: ensure runtime deps in cache ─────────────────────────────────
echo "${BOLD}[6/7]${NC} Checking runtime deps in install path..."

if [ -n "${INSTALL_PATH}" ] && [ -d "${INSTALL_PATH}/server" ]; then
  if [ -d "${INSTALL_PATH}/server/node_modules" ]; then
    echo "${GREEN}✓ node_modules present${NC}"
  else
    # v2.3.2 fix: `claude plugin update` does NOT run `npm install` (unlike
    # the first-install path), so the cache dir lacks runtime deps and the
    # MCP server fails to boot. Populate.
    # v2.4 hardening: switched from `npm install` to `npm ci` so the install
    # resolves ONLY what `package-lock.json` pins. Defends against the
    # post-Shai-Hulud npm threat model where a compromised minor release
    # would otherwise auto-resolve through caret ranges in package.json.
    echo "${YELLOW}⚠ node_modules absent at ${INSTALL_PATH}/server/node_modules${NC}"
    echo "    Plugin manager's update flow doesn't run npm install. Populating runtime deps..."
    echo "${BOLD}    cd ${INSTALL_PATH}/server && npm ci --omit=dev --ignore-scripts${NC}"
    if (cd "${INSTALL_PATH}/server" && npm ci --omit=dev --ignore-scripts --silent); then
      echo "${GREEN}✓ Runtime deps installed (frozen lockfile)${NC}"
    else
      echo "${RED}✗ npm ci failed in ${INSTALL_PATH}/server${NC}" >&2
      echo "${RED}   You'll need to install deps manually before restarting Claude Code:${NC}" >&2
      echo "${RED}   cd ${INSTALL_PATH}/server && npm ci --omit=dev --ignore-scripts${NC}" >&2
      exit 1
    fi
  fi
else
  echo "${YELLOW}⚠ Could not determine installPath from bookmark; skipping deps check${NC}"
fi
echo

# ─── Step 7: restart reminder ─────────────────────────────────────────────
echo "${BOLD}[7/7]${NC}"
echo "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${BOLD}  Restart Claude Code now: exit and re-launch.  /clear is insufficient.${NC}"
echo "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
