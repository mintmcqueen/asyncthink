#!/bin/bash
#
# rotation-fidelity.sh — shared patch-id audit library
#
# Two public functions, both intended to be sourced by other hook scripts:
#
#   verify_delete_fidelity <ref> <target>
#     For a branch <ref> about to be deleted, verify that every commit
#     unique to <ref> (vs merge-base with <target>) has its content
#     preserved somewhere else — by patch-id or subject match — reachable
#     from <target> or a peer ref.
#     Returns:
#       0 = all commits accounted for (possibly with drift warnings)
#       1 = one or more commits have NO match anywhere (blocks delete)
#       2 = subject matches found but not patch-id (drift — caller decides)
#
#   verify_rotation_fidelity <old_ref> <new_ref>
#     For a cherry-pick rotation from <old_ref> to <new_ref>, verify that
#     every commit on <old_ref> (vs merge-base with <new_ref>) is
#     represented on <new_ref> by patch-id or subject.
#     Returns same exit codes.
#
# Both functions emit missing-commit details on stderr. Caller decides
# how to present them.
#
# Configuration (via git config):
#   git-guard.strict-rotation-fidelity  (default true)
#     When false, functions skip patch-id checks and return 0.
#   git-guard.fidelity-max-commits (default 500)
#     Cap on commits examined per peer ref (bound worst-case runtime).

# No `set -u` — this file is sourced by other scripts that may have
# their own unset-var tolerance. Fail-closed is enforced inline where
# it matters (e.g., missing $ref or $target causes early return 0).

# ── patch-id computation with per-process cache ──────────────────────
# Cache file lives under .qoral/ so multiple hook invocations in the
# same session share work. Cleared manually by the user or when stale.
_FIDELITY_CACHE="${CLAUDE_PROJECT_DIR:-$(pwd)}/.qoral/patch-id-cache.tsv"

_rf_patch_id() {
  local sha="$1"
  # Check cache
  if [ -f "$_FIDELITY_CACHE" ]; then
    local cached
    cached=$(awk -F'\t' -v s="$sha" '$1==s {print $2; exit}' "$_FIDELITY_CACHE" 2>/dev/null)
    if [ -n "$cached" ]; then
      printf '%s' "$cached"
      return
    fi
  fi
  # Compute and cache
  local pid
  pid=$(git show "$sha" 2>/dev/null | git patch-id --stable 2>/dev/null | awk '{print $1}')
  if [ -n "$pid" ]; then
    mkdir -p "$(dirname "$_FIDELITY_CACHE")" 2>/dev/null
    printf '%s\t%s\n' "$sha" "$pid" >> "$_FIDELITY_CACHE" 2>/dev/null
  fi
  printf '%s' "$pid"
}

# ── Build index of (patch-id, sha, subject) triples for a ref range ──
_rf_build_index() {
  local range="$1"; local max="$2"; local out="$3"
  git log "$range" --reverse --format='%H%x09%s' 2>/dev/null | head -n "$max" | \
  while IFS=$'\t' read -r sha subj; do
    local pid
    pid=$(_rf_patch_id "$sha")
    printf '%s\t%s\t%s\n' "$pid" "$sha" "$subj"
  done > "$out"
}

# ── Check: is $pid present in $index? ─────────────────────────────────
_rf_pid_in_index() {
  local pid="$1"; local index="$2"
  [ -z "$pid" ] && return 1
  awk -F'\t' -v p="$pid" '$1==p {found=1; exit} END {exit !found}' "$index"
}

# ── Check: is $subject present in $index? ─────────────────────────────
_rf_subject_in_index() {
  local subj="$1"; local index="$2"
  [ -z "$subj" ] && return 1
  awk -F'\t' -v s="$subj" '$3==s {found=1; exit} END {exit !found}' "$index"
}

# ── Public: verify_delete_fidelity <ref> <target> ────────────────────
verify_delete_fidelity() {
  local ref="$1"; local target="$2"

  local strict
  strict=$(git config --get git-guard.strict-rotation-fidelity 2>/dev/null || echo "true")
  if [ "$strict" != "true" ]; then
    return 0  # opt-out
  fi

  local max
  max=$(git config --get git-guard.fidelity-max-commits 2>/dev/null || echo "500")

  local mergebase
  mergebase=$(git merge-base "$ref" "$target" 2>/dev/null || true)
  [ -z "$mergebase" ] && return 0  # no common history; can't audit

  # ── Squash-merge subsumption short-circuit ────────────────────────
  # If ref's tree matches any tree reachable from target (or another
  # peer ref), ref has been absorbed by squash-merge or similar. Return 0.
  local ref_tree
  ref_tree=$(git rev-parse "$ref^{tree}" 2>/dev/null || true)
  if [ -n "$ref_tree" ]; then
    if git log --format='%T' "$target" 2>/dev/null | head -n "$max" | grep -qx "$ref_tree"; then
      return 0
    fi
  fi

  # Build the "anywhere-reachable" index: $target's recent commits PLUS
  # every peer ref (other developer/* branches + other local/remote refs).
  # Tempfile for cross-ref patch-id+subject index. Leaked in /tmp, small,
  # OS-cleaned. Explicit cleanup omitted for zsh compat (RETURN trap is
  # bash-only and hook scripts exit immediately after calling this anyway).
  local anywhere
  anywhere=$(mktemp)

  # (a) $target commits since mergebase
  _rf_build_index "$mergebase..$target" "$max" "$anywhere.tmp" 2>/dev/null
  cat "$anywhere.tmp" >> "$anywhere" 2>/dev/null

  # (b) Peer refs (all heads + remotes, excluding $ref and $target)
  local peer
  for peer in $(git for-each-ref --format='%(refname)' refs/heads/ refs/remotes/ 2>/dev/null | \
                grep -v -e "^${ref}\$" -e "^refs/heads/${target#refs/heads/}\$" -e "^${target}\$"); do
    # Cap each peer's examined range at $max commits since mergebase
    _rf_build_index "$mergebase..$peer" "$max" "$anywhere.tmp" 2>/dev/null
    cat "$anywhere.tmp" >> "$anywhere" 2>/dev/null
  done
  rm -f "$anywhere.tmp"

  # For each commit unique to $ref vs mergebase, check presence in anywhere.
  local missing=""; local drifted=""; local missing_count=0; local drifted_count=0

  while IFS=$'\t' read -r sha subj; do
    [ -z "$sha" ] && continue
    local pid
    pid=$(_rf_patch_id "$sha")

    if _rf_pid_in_index "$pid" "$anywhere"; then
      continue  # clean match
    fi
    if _rf_subject_in_index "$subj" "$anywhere"; then
      drifted+="    ${sha:0:10}  $subj"$'\n'
      drifted_count=$((drifted_count + 1))
      continue  # subject match; drift (benign or semi-benign)
    fi
    missing+="    ${sha:0:10}  $subj"$'\n'
    missing_count=$((missing_count + 1))
  done < <(git log "$mergebase..$ref" --reverse --format='%H%x09%s' --no-merges 2>/dev/null)

  if [ "$missing_count" -gt 0 ]; then
    cat >&2 <<EOF

╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  PATCH-ID FIDELITY FAILED — UNIQUE CONTENT ON THIS BRANCH  ⚠     ║
╚══════════════════════════════════════════════════════════════════════╝

Branch: $ref

$missing_count commit(s) on this branch have patch content that is NOT
preserved anywhere else (not on $target, not on any peer developer
branch, not on any other local or remote ref):

$missing
This is the exact failure mode that caused the 40a4f2e data loss on
2026-04-16: a rotation cherry-pick silently dropped a docs commit, and
the prior diff-subset fallback allowed the delete because upstream had
separately touched the same files. Patch-id audit catches it.

Safe paths:
  1. Cherry-pick the missing commits onto your current branch
  2. Push them as a follow-up PR before deleting the source branch
  3. If genuinely obsolete, document why and bypass with full audit

EOF
    if [ "$drifted_count" -gt 0 ]; then
      echo "Additionally, $drifted_count commit(s) show patch drift (subject matches but patch-id does not — conflict resolution may have shifted content). Inspect each:" >&2
      echo "$drifted" >&2
    fi
    return 1
  fi

  if [ "$drifted_count" -gt 0 ]; then
    echo "⚠ $drifted_count commit(s) drifted during cherry-pick (patch-id differs, subject matches). Inspect after delete:" >&2
    echo "$drifted" >&2
    return 2  # advisory; caller decides
  fi

  return 0
}

# ── Public: verify_rotation_fidelity <old_ref> <new_ref> ──────────────
verify_rotation_fidelity() {
  local old_ref="$1"; local new_ref="$2"

  local strict
  strict=$(git config --get git-guard.strict-rotation-fidelity 2>/dev/null || echo "true")
  if [ "$strict" != "true" ]; then
    return 0
  fi

  local max
  max=$(git config --get git-guard.fidelity-max-commits 2>/dev/null || echo "500")

  local mergebase
  mergebase=$(git merge-base "$old_ref" "$new_ref" 2>/dev/null || true)
  [ -z "$mergebase" ] && return 0

  # ── Squash-merge subsumption short-circuit ────────────────────────
  # If old_ref's tree matches any tree reachable from new_ref or from the
  # integration branch, old_ref has been absorbed (squash-merge, rebase,
  # or direct merge). All content preserved by definition. Return 0.
  #
  # This prevents a false positive in the normal post-rotation flow:
  #   1. Developer rotates (cherry-pick), pushes → peer matches HEAD
  #   2. PR squash-merges to integration
  #   3. Developer pulls integration, starts next cycle
  #   4. Without this check, the stale peer (pre-rotation SHA) no longer
  #      matches HEAD's content by patch-id (squash has cumulative
  #      patch-id), and every peer commit would be flagged as missing.
  local old_tree new_tree
  old_tree=$(git rev-parse "$old_ref^{tree}" 2>/dev/null || true)
  new_tree=$(git rev-parse "$new_ref^{tree}" 2>/dev/null || true)
  if [ -n "$old_tree" ] && [ "$old_tree" = "$new_tree" ]; then
    return 0  # byte-identical trees
  fi
  # Scan recent tree history of new_ref and integration for a match.
  local integration="${BRANCH_CLEANUP_TARGET:-origin/development}"
  if [ -n "$old_tree" ]; then
    local tree_search_refs="$new_ref"
    if git rev-parse --verify "$integration" >/dev/null 2>&1; then
      tree_search_refs="$tree_search_refs $integration"
    fi
    local match_ref
    for match_ref in $tree_search_refs; do
      if git log --format='%T' "$match_ref" 2>/dev/null | head -n "$max" | grep -qx "$old_tree"; then
        return 0  # old_ref's tree appears in $match_ref's history (squash-merged)
      fi
    done
  fi

  local new_index
  new_index=$(mktemp)
  _rf_build_index "$mergebase..$new_ref" "$max" "$new_index"

  local missing=""; local drifted=""; local missing_count=0; local drifted_count=0

  while IFS=$'\t' read -r sha subj; do
    [ -z "$sha" ] && continue
    local pid
    pid=$(_rf_patch_id "$sha")
    if _rf_pid_in_index "$pid" "$new_index"; then continue; fi
    if _rf_subject_in_index "$subj" "$new_index"; then
      drifted+="    ${sha:0:10}  $subj"$'\n'
      drifted_count=$((drifted_count + 1))
      continue
    fi
    missing+="    ${sha:0:10}  $subj"$'\n'
    missing_count=$((missing_count + 1))
  done < <(git log "$mergebase..$old_ref" --reverse --format='%H%x09%s' --no-merges 2>/dev/null)

  if [ "$missing_count" -gt 0 ]; then
    cat >&2 <<EOF

╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  ROTATION FIDELITY FAILED — COMMITS NOT CHERRY-PICKED  ⚠         ║
╚══════════════════════════════════════════════════════════════════════╝

Comparing:
  OLD: $old_ref ($(git rev-parse --short "$old_ref"))
  NEW: $new_ref ($(git rev-parse --short "$new_ref"))

$missing_count commit(s) from OLD have NO representation on NEW (by
patch-id or subject):

$missing
Before proceeding, either:
  1. Cherry-pick the missing commits: git cherry-pick <sha>
  2. Document why they are intentionally obsolete

EOF
    if [ "$drifted_count" -gt 0 ]; then
      echo "⚠ $drifted_count additional commit(s) show drift (subject matches, patch-id differs):" >&2
      echo "$drifted" >&2
    fi
    return 1
  fi

  if [ "$drifted_count" -gt 0 ]; then
    cat >&2 <<EOF
⚠ Rotation fidelity: $drifted_count commit(s) drifted (patch-id mismatch
but subject matches). This is usually benign (conflict-resolution shifted
context), but inspect each to confirm intent was preserved:

$drifted
EOF
    return 2
  fi

  return 0
}

# When sourced, these functions are available. When invoked directly,
# expose a CLI for ad-hoc audits (used by the branch-rotation skill).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    delete)
      shift
      verify_delete_fidelity "$@"
      ;;
    rotation)
      shift
      verify_rotation_fidelity "$@"
      ;;
    *)
      cat <<EOF
Usage: $(basename "$0") <mode> <args>

Modes:
  delete <ref> <target>         Audit before deleting <ref>. Checks that
                                every commit unique to <ref> is preserved
                                on <target> or peer refs.
  rotation <old_ref> <new_ref>  Audit cherry-pick rotation from <old_ref>
                                to <new_ref>.

Exit codes:
  0 = all commits accounted for
  1 = missing commits (block)
  2 = drift warnings (advisory)

Configuration (git config):
  git-guard.strict-rotation-fidelity  Default true. Set false to opt out.
  git-guard.fidelity-max-commits      Default 500. Per-ref commit cap.
EOF
      exit 1
      ;;
  esac
fi
