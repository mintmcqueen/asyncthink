#!/bin/bash
#
# verify-hooks.sh — detect drift between installed hooks and skill source
#
# Installed git-guard hooks can drift from the skill source (either because
# a hook was edited locally after install, or because the skill evolved and
# the repo didn't get updated). Silent drift means skill-level improvements
# don't reach the repo until the next explicit install.
#
# This script compares each installed hook against its skill source and
# reports mismatches. Exit 0 = in sync, 1 = drift detected.
#
# Run:
#   ./scripts/hooks/verify-hooks.sh            # just report
#   ./scripts/hooks/verify-hooks.sh --update   # copy skill version over (asks per file)
#   ./scripts/hooks/verify-hooks.sh --quiet    # exit code only, no output
#
# Finds the skill source via $HOME/.claude/skills/git-guard/scripts/ by default.
# Override with GIT_GUARD_SKILL_SCRIPTS env var.

set -e

SKILL_SCRIPTS="${GIT_GUARD_SKILL_SCRIPTS:-$HOME/.claude/skills/git-guard/scripts}"
REPO_SCRIPTS="$(dirname "${BASH_SOURCE[0]}")"
UPDATE_MODE=false
QUIET=false

for arg in "$@"; do
  case "$arg" in
    --update) UPDATE_MODE=true ;;
    --quiet|-q) QUIET=true ;;
    -h|--help)
      grep '^#' "${BASH_SOURCE[0]}" | head -20
      exit 0
      ;;
  esac
done

if [ ! -d "$SKILL_SCRIPTS" ]; then
  [ "$QUIET" = false ] && echo "⚠ Skill source not found at $SKILL_SCRIPTS — skipping drift check." >&2
  exit 0
fi

drift_count=0
missing_count=0
ok_count=0

# Compare one file pair. Sets drift_count / missing_count / ok_count in parent scope.
# Args: $1 = skill path, $2 = repo path, $3 = display name
compare_pair() {
  local skill_file="$1" repo_file="$2" name="$3"

  if [ ! -f "$repo_file" ]; then
    missing_count=$((missing_count + 1))
    [ "$QUIET" = false ] && echo "✗ MISSING in repo: $name"
    if [ "$UPDATE_MODE" = true ]; then
      mkdir -p "$(dirname "$repo_file")"
      cp "$skill_file" "$repo_file"
      [ -x "$skill_file" ] && chmod +x "$repo_file"
      echo "  → copied from skill source"
    fi
    return
  fi

  if cmp -s "$skill_file" "$repo_file"; then
    ok_count=$((ok_count + 1))
    [ "$QUIET" = false ] && echo "✓ $name"
  else
    drift_count=$((drift_count + 1))
    if [ "$QUIET" = false ]; then
      local skill_lines repo_lines added removed
      skill_lines=$(wc -l < "$skill_file" | tr -d ' ')
      repo_lines=$(wc -l < "$repo_file" | tr -d ' ')
      added=$(diff <(sort "$skill_file") <(sort "$repo_file") | grep -c '^>' || true)
      removed=$(diff <(sort "$skill_file") <(sort "$repo_file") | grep -c '^<' || true)
      echo "⚠ DRIFT: $name  (skill: ${skill_lines}L, repo: ${repo_lines}L, +$added/-$removed lines vs skill)"
    fi
    if [ "$UPDATE_MODE" = true ]; then
      printf "  Overwrite repo copy with skill version? [y/N] "
      read -r reply </dev/tty
      if [ "$reply" = "y" ] || [ "$reply" = "Y" ]; then
        cp "$skill_file" "$repo_file"
        [ -x "$skill_file" ] && chmod +x "$repo_file"
        echo "  → overwrote $name"
      else
        echo "  → kept repo version (drift remains)"
      fi
    fi
  fi
}

# Top-level hook scripts
for skill_file in "$SKILL_SCRIPTS"/*.sh; do
  [ -f "$skill_file" ] || continue
  name=$(basename "$skill_file")
  compare_pair "$skill_file" "$REPO_SCRIPTS/$name" "$name"
done

# _lib/ — shared helpers + manifest generators (shell + mjs)
if [ -d "$SKILL_SCRIPTS/_lib" ]; then
  for skill_file in "$SKILL_SCRIPTS"/_lib/*.sh "$SKILL_SCRIPTS"/_lib/*.mjs; do
    [ -f "$skill_file" ] || continue
    name="_lib/$(basename "$skill_file")"
    compare_pair "$skill_file" "$REPO_SCRIPTS/$name" "$name"
  done
fi

# Check for orphans: repo has files not in skill
for repo_file in "$REPO_SCRIPTS"/*.sh; do
  [ -f "$repo_file" ] || continue
  name=$(basename "$repo_file")
  # Skip the verify-hooks.sh itself and known repo-specific files
  case "$name" in
    verify-hooks.sh) continue ;;
  esac
  skill_file="$SKILL_SCRIPTS/$name"
  if [ ! -f "$skill_file" ]; then
    [ "$QUIET" = false ] && echo "⚠ ORPHAN: $name (in repo, not in skill — may be obsolete)"
  fi
done

# _lib/ orphans (repo-local extensions like check-admin-portal-deps.sh are
# expected — report them as orphans so they're visible, but don't fail)
if [ -d "$REPO_SCRIPTS/_lib" ]; then
  for repo_file in "$REPO_SCRIPTS"/_lib/*.sh "$REPO_SCRIPTS"/_lib/*.mjs; do
    [ -f "$repo_file" ] || continue
    name="_lib/$(basename "$repo_file")"
    skill_file="$SKILL_SCRIPTS/$name"
    if [ ! -f "$skill_file" ]; then
      [ "$QUIET" = false ] && echo "⚠ ORPHAN: $name (in repo, not in skill)"
    fi
  done
fi

if [ "$QUIET" = false ]; then
  echo ""
  echo "Summary: $ok_count in sync, $drift_count drifted, $missing_count missing"
fi

if [ "$drift_count" -gt 0 ] || [ "$missing_count" -gt 0 ]; then
  exit 1
fi
exit 0
