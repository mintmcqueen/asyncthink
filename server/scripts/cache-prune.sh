#!/usr/bin/env bash
# asyncthink v2.3 — npm run cache:prune (R-DIST-D.2)
#
# Removes any cache directory NOT marked as bookmarked. Respects .orphaned_at
# markers (still removes them; that's the point). NEVER touches the bookmarked
# version dir.

set -euo pipefail

CACHE_ROOT="$HOME/.claude/plugins/cache/asyncthink-local/asyncthink"
BOOKMARK="$HOME/.claude/plugins/installed_plugins.json"

if [ ! -d "${CACHE_ROOT}" ]; then
  echo "No asyncthink-local cache at ${CACHE_ROOT}; nothing to prune."
  exit 0
fi

BOOKMARKED_PATH=""
if [ -f "${BOOKMARK}" ]; then
  BOOKMARKED_PATH=$(node -e "
    const b = JSON.parse(require('fs').readFileSync('${BOOKMARK}','utf8'));
    const entry = (b.plugins['asyncthink@asyncthink-local'] || [])[0];
    if (entry) console.log(entry.installPath);
  ")
fi

removed=0
freed_kb=0

for dir in "${CACHE_ROOT}"/*; do
  [ -d "${dir}" ] || continue
  if [ "${dir}" = "${BOOKMARKED_PATH}" ]; then
    echo "keeping bookmarked: $(basename "${dir}")"
    continue
  fi
  size_kb="$(du -sk "${dir}" 2>/dev/null | cut -f1)"
  echo "removing $(basename "${dir}") (${size_kb} KB)"
  rm -rf "${dir}"
  removed=$((removed + 1))
  freed_kb=$((freed_kb + size_kb))
done

echo
echo "Removed ${removed} directories; freed ~${freed_kb} KB."
