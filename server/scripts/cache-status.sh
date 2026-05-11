#!/usr/bin/env bash
# asyncthink v2.3 — npm run cache:status (R-DIST-D.2)
#
# Reads the plugin manager's bookmark + cache dir layout and prints
# classification of each version dir: bookmarked | orphaned | stranded.
# Read-only; safe to run anytime.

set -euo pipefail

CACHE_ROOT="$HOME/.claude/plugins/cache/asyncthink-local/asyncthink"
BOOKMARK="$HOME/.claude/plugins/installed_plugins.json"

if [ ! -d "${CACHE_ROOT}" ]; then
  echo "No asyncthink-local cache at ${CACHE_ROOT}"
  exit 0
fi

BOOKMARKED_VERSION=""
BOOKMARKED_PATH=""
if [ -f "${BOOKMARK}" ]; then
  read -r BOOKMARKED_VERSION BOOKMARKED_PATH <<< "$(node -e "
    const b = JSON.parse(require('fs').readFileSync('${BOOKMARK}','utf8'));
    const entry = (b.plugins['asyncthink@asyncthink-local'] || [])[0];
    if (entry) console.log(entry.version + ' ' + entry.installPath);
  ")"
fi

echo "Bookmarked version: ${BOOKMARKED_VERSION:-<none>}"
echo "Bookmarked path:    ${BOOKMARKED_PATH:-<none>}"
echo
echo "Cache directories under ${CACHE_ROOT}:"

for dir in "${CACHE_ROOT}"/*; do
  [ -d "${dir}" ] || continue
  name="$(basename "${dir}")"
  size_kb="$(du -sk "${dir}" 2>/dev/null | cut -f1)"
  if [ "${dir}" = "${BOOKMARKED_PATH}" ]; then
    status="bookmarked"
  elif [ -f "${dir}/.orphaned_at" ]; then
    status="orphaned"
  else
    status="stranded"
  fi
  printf '  %-12s %s  (%s KB)\n' "[${status}]" "${name}" "${size_kb}"
done
