#!/bin/bash
#
# git-guard pre-push hook
#
# Runs configured typecheck and test commands before pushing. Blocks on failure.
# Bypass with --no-verify (strongly discouraged).
#
# Configure via:
#   git config git-guard.typecheck-cmd '<command>'   # e.g., 'npx tsc --noEmit'
#   git config git-guard.test-cmd '<command>'        # e.g., 'npm run test:unit'
#
# Both are skipped if not configured.
#
# Rationale: catches merge regressions (missing exports, broken imports, type errors)
# that commit-msg hooks can't see.

set -e

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
cd "$PROJECT_ROOT" || exit 0

# Skip if no real commits being pushed (e.g., tag push, branch delete)
has_commits=false
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$local_sha" != "0000000000000000000000000000000000000000" ]; then
    has_commits=true
  fi
done
if [ "$has_commits" = "false" ]; then
  exit 0
fi

TYPECHECK_CMD=$(git config --get git-guard.typecheck-cmd 2>/dev/null || true)
TEST_CMD=$(git config --get git-guard.test-cmd 2>/dev/null || true)
CHECK_ROTATION=$(git config --get git-guard.check-rotation-fidelity-on-push 2>/dev/null || echo "true")

# ── Rotation fidelity check ──────────────────────────────────────────
# Runs regardless of typecheck/test config. Detects an incomplete
# cherry-pick rotation: we're on developer/{initials}_{a|b}, the peer
# suffix exists as origin/developer/{initials}_{b|a}, and the peer has
# commits whose content is NOT represented on HEAD (by patch-id or
# subject match). Blocks push if so.
#
# This fix was added after the 40a4f2e incident (2026-04-17) — a rotation
# silently dropped a commit because the diff-subset fallback in the
# branch-delete guard was insufficient. The fix here catches the same
# class of bug at push time.
#
# Opt out per-repo: git config git-guard.check-rotation-fidelity-on-push false
if [ "$CHECK_ROTATION" = "true" ]; then
  current_branch=$(git branch --show-current 2>/dev/null || echo "")
  if [[ "$current_branch" =~ ^developer/(.+)_([ab])$ ]]; then
    initials="${BASH_REMATCH[1]}"
    suffix="${BASH_REMATCH[2]}"
    if [ "$suffix" = "a" ]; then peer_suffix="b"; else peer_suffix="a"; fi
    peer_ref="refs/remotes/origin/developer/${initials}_${peer_suffix}"
    integration="${BRANCH_CLEANUP_TARGET:-origin/${INTEGRATION_BRANCH:-development}}"
    if ! git rev-parse --verify "$integration" >/dev/null 2>&1; then
      integration="origin/develop"  # fallback
    fi

    if git rev-parse --verify "$peer_ref" >/dev/null 2>&1; then
      peer_unmerged=$(git log "$integration..$peer_ref" --oneline 2>/dev/null | wc -l | tr -d ' ')
      if [ "$peer_unmerged" -gt 0 ]; then
        echo ""
        echo "▶ Rotation fidelity: $peer_unmerged commit(s) on origin/developer/${initials}_${peer_suffix}"

        FIDELITY_LIB="$(dirname "${BASH_SOURCE[0]}")/rotation-fidelity.sh"
        if [ -r "$FIDELITY_LIB" ]; then
          # shellcheck disable=SC1090
          source "$FIDELITY_LIB"
          if verify_rotation_fidelity "$peer_ref" "HEAD"; then
            fidelity_rv=0
          else
            fidelity_rv=$?
          fi
          if [ "$fidelity_rv" = "0" ]; then
            echo "  ✓ All $peer_unmerged peer commits verified preserved on HEAD"
          elif [ "$fidelity_rv" = "2" ]; then
            echo "  ⚠ Drift warnings above, but all content represented. Allowing push."
          else
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "  ❌ ROTATION FIDELITY FAILED — push blocked"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Bypass (only if you INTENTIONALLY mean to discard peer work):"
            echo "  git push --no-verify"
            echo ""
            echo "Or delete the peer backup first if it's genuinely obsolete:"
            echo "  git push origin --delete developer/${initials}_${peer_suffix}"
            echo ""
            exit 1
          fi
        fi
      fi
    fi
  fi
fi

# If nothing configured, exit silently — repo opted out of pre-push validation
if [ -z "$TYPECHECK_CMD" ] && [ -z "$TEST_CMD" ]; then
  exit 0
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Pre-push checks (git-guard)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Typecheck
if [ -n "$TYPECHECK_CMD" ]; then
  echo ""
  echo "▶ $TYPECHECK_CMD"
  if ! eval "$TYPECHECK_CMD"; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ❌ TYPECHECK FAILED — push blocked"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "This often indicates:"
    echo "  • A merge dropped function exports"
    echo "  • A refactor renamed something but missed a consumer"
    echo "  • A type annotation is wrong"
    echo ""
    echo "Fix the errors above, or bypass with: git push --no-verify"
    echo "(bypassing means you accept the risk of broken code landing on the remote)"
    echo ""
    exit 1
  fi
  echo "  ✓ Typecheck clean"
fi

# 2. Test command
if [ -n "$TEST_CMD" ]; then
  echo ""
  echo "▶ $TEST_CMD"
  if ! eval "$TEST_CMD"; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ❌ TESTS FAILED — push blocked"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Fix the failing tests above, or bypass with: git push --no-verify"
    echo ""
    exit 1
  fi
  echo "  ✓ Tests passing"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Pre-push checks passed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit 0
