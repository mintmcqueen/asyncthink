#!/bin/bash
#
# git-guard post-merge hook
#
# Runs the configured typecheck immediately after a merge or pull.
# Warns (non-blocking) on failure — merges with type errors are legal
# (could be fixed in a follow-up commit) but you should know immediately.
#
# Configure via: git config git-guard.typecheck-cmd '<command>'
# Default: skipped (no command configured)
#

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$PROJECT_ROOT" ] && exit 0
cd "$PROJECT_ROOT" || exit 0

TYPECHECK_CMD=$(git config --get git-guard.typecheck-cmd 2>/dev/null || true)
[ -z "$TYPECHECK_CMD" ] && exit 0

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Post-merge check: $TYPECHECK_CMD"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if eval "$TYPECHECK_CMD" 2>&1; then
  echo "  ✓ Typecheck clean"
else
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  ⚠️  Typecheck FAILED after merge"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "A common cause: a conflict resolution accepted 'theirs' for a file"
  echo "your branch had modified, dropping exports that other files still"
  echo "import. Check conflicted file history with:"
  echo "  git log --oneline ORIG_HEAD..HEAD -- <file>"
  echo ""
  echo "Fix before pushing (pre-push hook will block otherwise)."
  echo ""
fi
echo ""
exit 0
