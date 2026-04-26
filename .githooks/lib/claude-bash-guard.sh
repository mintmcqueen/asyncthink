#!/bin/bash
#
# git-guard Claude Code PreToolUse hook — intercepts dangerous Bash tool calls.
#
# Guards against agent commands that can silently destroy work:
#   (1) git branch -[dD] <name>       — local branch delete with unmerged work
#       git push ... --delete <name>  — remote branch delete with unmerged work
#   (2) git merge -X theirs|ours      — wholesale conflict clobber
#   (3) git checkout --theirs|--ours <file>  — per-file conflict clobber
#   (4) git reset --hard <ref>        — destructive history rewrite
#   (5) git push -f / --force[-with-lease] to protected branches
#   (6) git push origin {protected branch}  — direct push bypasses PR loop
#   (7) Looped/automated rebase or merge --continue (silent conflict resolution)
#   (8) Wrong merge method per target branch (squash for integration, merge for promotions)
#
# Protocol:
#   Stdin:  JSON { "tool_name": "Bash", "tool_input": { "command": "..." } }
#   Exit 0: allow the Bash call through
#   Exit 2: block, stderr shown to Claude
#
# Universal bypass (all checks):
#   Prefix the command with the phrase-as-env-var below. The env var name IS
#   the audit confirmation phrase — long enough that typing it is a
#   deliberate, auditable act. See per-check warnings for the audit
#   discipline required to justify using it.
#
#     I_HAVE_FULLY_AUDITED_THE_RISKY_DECISION_TO_BYPASS_THIS_WARNING=1 <cmd>

set -e

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$PROJECT_ROOT" ] && exit 0

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$tool_name" = "Bash" ] || exit 0
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$command" ] && exit 0

# ── Universal bypass ─────────────────────────────────────────────────
# Anchored: must be a leading env var assignment, not a substring in a comment or string.
if [[ "$command" =~ ^[[:space:]]*I_HAVE_FULLY_AUDITED_THE_RISKY_DECISION_TO_BYPASS_THIS_WARNING=1[[:space:]] ]]; then
  exit 0
fi

# ── git-guard config helpers ────────────────────────────────────────
gg_config() {
  local value
  value=$(cd "$PROJECT_ROOT" && git config --get "git-guard.$1" 2>/dev/null || true)
  if [ -n "$value" ]; then echo "$value"; else echo "$2"; fi
}

# Detect integration branch: explicit override → origin/development → origin/develop
gg_integration_branch() {
  local explicit
  explicit=$(gg_config integration-branch "")
  if [ -n "$explicit" ]; then
    echo "$explicit"
    return
  fi
  if (cd "$PROJECT_ROOT" && git rev-parse --verify origin/development >/dev/null 2>&1); then
    echo "development"
  elif (cd "$PROJECT_ROOT" && git rev-parse --verify origin/develop >/dev/null 2>&1); then
    echo "develop"
  fi
}

# Detect GitHub owner/repo: explicit override → parse from origin remote URL
gg_github_repo() {
  local explicit
  explicit=$(gg_config github-repo "")
  if [ -n "$explicit" ]; then
    echo "$explicit"
    return
  fi
  local url
  url=$(cd "$PROJECT_ROOT" && git remote get-url origin 2>/dev/null || true)
  [ -z "$url" ] && return
  # SSH form: git@github.com:owner/repo.git
  # HTTPS form: https://github.com/owner/repo.git
  echo "$url" | sed -E 's|^git@github\.com:||; s|^https?://github\.com/||; s|\.git$||'
}

INTEGRATION_BRANCH=$(gg_integration_branch)
TARGET="${BRANCH_CLEANUP_TARGET:-origin/${INTEGRATION_BRANCH:-development}}"
PROTECTED_BRANCHES_RE=$(gg_config protected-branches '^(develop|development|staging|production|master|main)$')

# ── Shared warning footer ────────────────────────────────────────────
emit_footer() {
  local example_cmd="$1"
  cat >&2 <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your responsibility as an agent is to yourself, to other developers, and
— above all — to the QUALITY, INTEGRITY, and SECURITY of the code. Not
to speed, convenience, or the ambient pressure to ship. Treat the risk
above as what it is: an irreversible decision landing on everyone who
depends on this code.

DO NOT bypass based on "probably fine" reasoning. Only with UTMOST CARE
and HIGHEST DEGREE OF CONFIDENCE, derived from:

  • File-by-file, diff-by-diff audit of every at-risk change
  • Confirmed each change is obsolete, superseded, or intentionally
    discarded — with a specific pointer for why
  • Explicit acknowledgement, disclosure to the user, and reconciliation
    of ANY uncertainty or ambiguity before bypassing (no "probably")

Destructive bypass (only after the audit above, disclosed to the user):
  Prefix the command with the phrase env var below. Its NAME is the
  audit confirmation phrase — typing it is a deliberate act.

    I_HAVE_FULLY_AUDITED_THE_RISKY_DECISION_TO_BYPASS_THIS_WARNING=1 $example_cmd

EOF
}

# ═════════════════════════════════════════════════════════════════════
# Check 1: branch delete (local + remote) — block if work would be lost
# ═════════════════════════════════════════════════════════════════════
candidate_branch=""
op_kind=""
if [[ "$command" =~ git[[:space:]]+branch[[:space:]]+-[dD][[:space:]]+([A-Za-z0-9_./-]+) ]]; then
  candidate_branch="${BASH_REMATCH[1]}"; op_kind="local-delete"
elif [[ "$command" =~ git[[:space:]]+push[[:space:]]+([A-Za-z0-9_./-]+)[[:space:]]+(--delete|-d)[[:space:]]+([A-Za-z0-9_./-]+) ]]; then
  candidate_branch="${BASH_REMATCH[3]}"; op_kind="remote-delete"
elif [[ "$command" =~ git[[:space:]]+push[[:space:]]+(--delete|-d)[[:space:]]+([A-Za-z0-9_./-]+)[[:space:]]+([A-Za-z0-9_./-]+) ]]; then
  candidate_branch="${BASH_REMATCH[3]}"; op_kind="remote-delete"
fi

if [ -n "$candidate_branch" ]; then
  if [[ "$candidate_branch" =~ $PROTECTED_BRANCHES_RE ]]; then
    cat >&2 <<EOF
BLOCKED: Attempt to delete protected branch '$candidate_branch'.

Protected branches must never be deleted by agents. There is no bypass —
escalate to a human if you believe this is necessary.
EOF
    exit 2
  fi

  cd "$PROJECT_ROOT" || exit 0
  git rev-parse --verify "$TARGET" >/dev/null 2>&1 || exit 0  # fresh clone or no integration branch

  if [ "$op_kind" = "local-delete" ]; then
    ref="refs/heads/$candidate_branch"
  else
    ref="refs/remotes/origin/$candidate_branch"
  fi
  git rev-parse --verify "$ref" >/dev/null 2>&1 || exit 0  # ref gone: let git error

  # Clean ancestry → safe
  if git merge-base --is-ancestor "$ref" "$TARGET" 2>/dev/null; then exit 0; fi

  commits_ahead=$(git log "$TARGET..$ref" --pretty='format:%H %s' --no-merges 2>/dev/null || true)
  [ -z "$commits_ahead" ] && exit 0

  unmatched=""; unmatched_count=0; total_count=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    total_count=$((total_count + 1))
    sha="${line%% *}"; subject="${line#* }"
    short_sha="${sha:0:7}"; short_subject=$(echo "$subject" | head -c 50)
    # LC_ALL=C: default macOS sed errors on multi-byte UTF-8 ("illegal
    # byte sequence") when commit subjects contain em-dashes. Empty
    # $escaped would make grep match everything → falsely allow deletes.
    escaped=$(echo "$short_subject" | LC_ALL=C sed 's/[][\.*^$+?(){}|/\\]/\\&/g')
    # Squash-merge subject match?
    git log "$TARGET" --oneline --grep="$escaped" 2>/dev/null | grep -q . && continue
    # Reachable from any other ref?
    other_refs=$(git for-each-ref --contains="$sha" --format='%(refname)' 2>/dev/null | grep -v "^${ref}\$" || true)
    [ -n "$other_refs" ] && continue
    unmatched_count=$((unmatched_count + 1))
    unmatched+="    $short_sha $short_subject"$'\n'
  done <<< "$commits_ahead"

  [ "$unmatched_count" -eq 0 ] && exit 0

  # ────────────────────────────────────────────────────────────────────
  # Content preservation fallback: the SHA-reachability and subject-match
  # checks above can't see squash-merges or cherry-pick rotations because
  # the content-preserving commits on $TARGET have different SHAs and
  # different subject lines than the originals. Two cheaper proofs of
  # content preservation:
  #
  #   (1) Byte-identical tree — the branch's tree is literally the same
  #       as $TARGET (or some other reachable ref). Unambiguous proof.
  #
  #   (2) Diff subset — every file that differs between the branch and
  #       $TARGET was also modified by a later commit on $TARGET since
  #       the merge base. If that's true, the differences are fully
  #       explained by upstream evolution, not by content unique to the
  #       branch. This catches the common squash-merge-plus-upstream
  #       case where the branch was absorbed into $TARGET via squash
  #       and later upstream commits further modified those same files.
  # ────────────────────────────────────────────────────────────────────

  # (1) Fast path: byte-identical tree vs $TARGET
  if git diff --quiet "$ref" "$TARGET" 2>/dev/null; then
    echo "⚠ Branch '$candidate_branch' tree is byte-identical to '$TARGET' — content preserved (likely squash-merged); allowing delete despite SHA mismatch." >&2
    exit 0
  fi

  # Also try other reachable refs — catches branches that were merged
  # into a sibling feature branch rather than directly into $TARGET.
  for other_ref in $(git for-each-ref --format='%(refname)' refs/heads/ refs/remotes/origin/ 2>/dev/null | grep -v -e "^${ref}\$" -e "^${TARGET}\$" || true); do
    if git diff --quiet "$ref" "$other_ref" 2>/dev/null; then
      echo "⚠ Branch '$candidate_branch' tree is byte-identical to '$other_ref' — content preserved; allowing delete." >&2
      exit 0
    fi
  done

  # (3) Patch-id fidelity audit — sourced library, authoritative check.
  #     REPLACED the prior "diff subset" fallback (removed 2026-04-17),
  #     which only verified that differing files were *touched* by
  #     upstream — not that their content was *preserved*. That hole
  #     caused a silently dropped commit during a rotation when the
  #     squash commit on $TARGET coincidentally also touched the same
  #     file (CLAUDE.md). Only per-commit patch-id audit catches that.
  FIDELITY_LIB="$(dirname "${BASH_SOURCE[0]}")/rotation-fidelity.sh"
  if [ -r "$FIDELITY_LIB" ]; then
    # shellcheck disable=SC1090
    source "$FIDELITY_LIB"
    if declare -f verify_delete_fidelity >/dev/null 2>&1; then
      # Use if/else to capture return without `set -e` aborting on rv=1
      # (we must reach the explicit `exit 2` below to signal BLOCK; `set -e`
      # would make the script exit 1, which Claude Code treats as "hook
      # error" rather than "block").
      if verify_delete_fidelity "$ref" "$TARGET"; then
        fidelity_rv=0
      else
        fidelity_rv=$?
      fi
      if [ "$fidelity_rv" = "0" ]; then
        echo "⚠ Branch '$candidate_branch' — all unique commits verified content-preserved elsewhere by patch-id audit." >&2
        exit 0
      elif [ "$fidelity_rv" = "2" ]; then
        echo "⚠ Branch '$candidate_branch' — drift warnings above (subject match, patch-id differs). Allowing delete; verify drift preserved intent." >&2
        exit 0
      fi
      # fidelity_rv=1 → missing commits, fall through to block
    fi
  fi

  cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — DELETING THIS BRANCH WOULD DESTROY UNMERGED WORK  ⚠   ║
╚══════════════════════════════════════════════════════════════════════╝

Branch:  $candidate_branch
Target:  $TARGET

$unmatched_count of $total_count unmerged commit(s) on '$candidate_branch' exist
ONLY on this branch — not in $TARGET (directly or via squash-merge)
AND not reachable from any other local/remote ref:

$unmatched
Deleting this branch will PERMANENTLY destroy those commits. Git reflog
may retain them ~90 days, but recovery is MANUAL and requires exact
SHAs — in practice, this is DATA LOSS.

Safe paths:
  1. Push the branch + open a PR to land the missing commits
  2. Cherry-pick the commits to another branch, then re-attempt cleanup
  3. Escalate to a human for review
EOF
  emit_footer "git branch -D $candidate_branch"
  exit 2
fi

# ═════════════════════════════════════════════════════════════════════
# Check 2: git merge -X theirs|ours  (wholesale conflict clobber)
# ═════════════════════════════════════════════════════════════════════
if [[ "$command" =~ git[[:space:]]+merge[[:space:]]+.*(-X[[:space:]]*|--strategy-option[[:space:]]*=?)(theirs|ours) ]] \
|| [[ "$command" =~ git[[:space:]]+merge[[:space:]]+.*-X(theirs|ours) ]]; then
  side=$(printf '%s\n' "$command" | grep -oE '(-X[[:space:]]*|--strategy-option[[:space:]]*=?)(theirs|ours)|-X(theirs|ours)' | grep -oE 'theirs|ours' | head -1)
  cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — WHOLESALE CONFLICT CLOBBER  ⚠                         ║
╚══════════════════════════════════════════════════════════════════════╝

You are passing \`-X $side\` to git merge. This tells git to resolve
EVERY conflict by taking the '$side' side, silently. No prompt, no
per-file review, no visibility into what you are discarding.

This pattern has caused multi-file work-drop incidents. Recovery requires
file-by-file three-way diffs against the merge base and is expensive.

Safe paths:
  1. Run \`git merge <ref>\` without -X. When conflicts appear, resolve
     them per-file after actually reading the diff.
  2. If you really want "prefer theirs" as a hint, use per-file
     \`git checkout --theirs <file>\` ONLY after auditing the specific
     file (and then audit THAT decision — see Check 3 below).
  3. Use \`git merge-tree\` to preview conflicts before merging.
EOF
  emit_footer "git merge -X $side <ref>"
  exit 2
fi

# ═════════════════════════════════════════════════════════════════════
# Check 3: git checkout --theirs|--ours <file>  (per-file clobber)
# ═════════════════════════════════════════════════════════════════════
if [[ "$command" =~ git[[:space:]]+checkout[[:space:]]+.*(--theirs|--ours)[[:space:]]+[^[:space:]]+ ]]; then
  side=$(printf '%s' "$command" | grep -oE -- '--theirs|--ours' | head -1 | sed 's/^--//')
  cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — PER-FILE CONFLICT CLOBBER  ⚠                          ║
╚══════════════════════════════════════════════════════════════════════╝

You are running \`git checkout --$side <file>\` during conflict resolution.
This discards every change on the OTHER side for that file — without
examining what's being discarded.

Before using this command, you MUST have:
  • Opened the file and read BOTH sides of each conflict hunk
  • Confirmed the side you are dropping contributes nothing unique
    (not "probably nothing unique" — CONFIRMED nothing unique)
  • Understood that git will not warn you if you were wrong

Safe paths:
  1. Open the conflicted file in an editor. Resolve hunks manually,
     keeping the parts of each side that matter.
  2. Use \`git diff --merge <file>\` or \`git log --merge -p <file>\`
     to see the three-way picture explicitly.
  3. Ask the user which side is canonical when you are uncertain.
EOF
  emit_footer "git checkout --$side <file>"
  exit 2
fi

# ═════════════════════════════════════════════════════════════════════
# Check 4: git reset --hard <ref>  (destructive history rewrite)
# ═════════════════════════════════════════════════════════════════════
if [[ "$command" =~ git[[:space:]]+reset[[:space:]]+--hard[[:space:]]+([^[:space:];&|]+) ]]; then
  target_ref="${BASH_REMATCH[1]}"
  cd "$PROJECT_ROOT" || exit 0
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  # If resetting to HEAD (no rewrite) or target is unresolvable, let git handle it.
  if [ "$target_ref" = "HEAD" ] || ! git rev-parse --verify "$target_ref" >/dev/null 2>&1; then
    exit 0
  fi

  # Check whether current HEAD has commits not reachable from target_ref.
  lost=$(git log "${target_ref}..HEAD" --pretty='format:%H %s' --no-merges 2>/dev/null || true)
  [ -z "$lost" ] && exit 0  # no commits ahead → reset is harmless

  # For each lost commit, check if reachable from another ref.
  truly_lost=""; truly_lost_count=0; total=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    total=$((total + 1))
    sha="${line%% *}"; subject="${line#* }"
    short_sha="${sha:0:7}"; short_subject=$(echo "$subject" | head -c 50)
    other_refs=$(git for-each-ref --contains="$sha" --format='%(refname)' 2>/dev/null | grep -v "^refs/heads/${current_branch}\$" || true)
    [ -n "$other_refs" ] && continue
    truly_lost_count=$((truly_lost_count + 1))
    truly_lost+="    $short_sha $short_subject"$'\n'
  done <<< "$lost"

  [ "$truly_lost_count" -eq 0 ] && exit 0

  cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — HARD RESET WOULD DROP COMMITS  ⚠                      ║
╚══════════════════════════════════════════════════════════════════════╝

\`git reset --hard $target_ref\` moves HEAD of '$current_branch' to
'$target_ref', abandoning the commits currently ahead of that ref.

$truly_lost_count of $total commit(s) would be dropped AND are not reachable
from any other ref:

$truly_lost
Safe paths:
  1. \`git branch backup-$current_branch\` before resetting (preserves
     the old tip so commits remain reachable)
  2. \`git reset --soft $target_ref\` keeps changes staged instead of
     discarding them
  3. \`git rebase $target_ref\` replays your commits onto the target
     instead of abandoning them
EOF
  emit_footer "git reset --hard $target_ref"
  exit 2
fi

# ═════════════════════════════════════════════════════════════════════
# Check 5: git push -f / --force / --force-with-lease to protected
# ═════════════════════════════════════════════════════════════════════
if [[ "$command" =~ git[[:space:]]+push[[:space:]]+.*(--force|--force-with-lease|(^|[[:space:]])-f($|[[:space:]])) ]]; then
  # Extract destination branch (crude: last non-flag token after "origin")
  force_target=$(printf '%s' "$command" | grep -oE 'origin[[:space:]]+[^[:space:]]+(:[^[:space:]]+)?' | awk '{print $2}' | awk -F: '{print $NF}' | head -1)
  if [ -z "$force_target" ]; then
    force_target=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
  fi
  if [[ "$force_target" =~ $PROTECTED_BRANCHES_RE ]]; then
    cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — FORCE-PUSH TO PROTECTED BRANCH  ⚠                     ║
╚══════════════════════════════════════════════════════════════════════╝

You are force-pushing to '$force_target' — a protected branch.

Force-pushing rewrites remote history. Collaborators (including every
deployed service watching this branch) whose local refs point to the
old history WILL be broken, and their in-flight work may conflict in
ways that look like phantom commits.

This is almost never what an agent should do to a protected branch.

Safe paths:
  1. If you need to undo a bad commit on '$force_target', create a
     revert commit: \`git revert <sha>\` + \`git push origin $force_target\`
  2. If you need to re-shape history, do it on a personal branch and
     open a PR
  3. Escalate to a human — some operations (tag cleanup, branch
     protection exceptions) legitimately need force-push, but they
     warrant human sign-off
EOF
    emit_footer "git push --force origin $force_target"
    exit 2
  fi
fi

# ═════════════════════════════════════════════════════════════════════
# Check 6: git push origin <protected branch>  (direct push bypasses PR)
# Only blocks pushes to protected branches. Force pushes to ALL protected
# branches are caught by Check 5 above; this catches the non-force case.
# ═════════════════════════════════════════════════════════════════════
if [[ "$command" =~ git[[:space:]]+push[[:space:]] ]] \
&& [[ ! "$command" =~ (--force|--force-with-lease|(^|[[:space:]])-f($|[[:space:]])) ]]; then
  push_target=""
  # Strip flags to find positional args after "push"
  push_args=$(printf '%s' "$command" | sed 's/git[[:space:]]*push//' | sed 's/--[a-zA-Z-]*//g' | sed 's/[[:space:]]-[a-zA-Z]//g' | tr -s ' ' | sed 's/^ //')
  push_remote=$(echo "$push_args" | awk '{print $1}')
  push_refspec=$(echo "$push_args" | awk '{print $2}')
  if [ -n "$push_refspec" ]; then
    push_target=$(echo "$push_refspec" | awk -F: '{print $NF}')
  fi
  if [ -z "$push_target" ] && [ -n "$push_remote" ]; then
    push_target=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
  fi

  if [[ "$push_target" =~ $PROTECTED_BRANCHES_RE ]]; then
    cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — DIRECT PUSH TO '$push_target'  ⚠                      ║
╚══════════════════════════════════════════════════════════════════════╝

You are pushing directly to '$push_target' — this bypasses the PR loop.

All changes to protected branches MUST go through pull requests:
  • feature/developer → integration: squash merge via PR
  • integration → staging (if applicable): merge commit via PR
  • staging → production (if applicable): merge commit via PR

Agents must NEVER push directly to any of these branches.

Safe path:
  1. Push your changes to the feature/developer branch
  2. Open a PR targeting the appropriate branch
  3. Merge via GitHub (squash for integration, merge commit for promotions)
EOF
    emit_footer "git push origin $push_target"
    exit 2
  fi
fi

# ═════════════════════════════════════════════════════════════════════
# Check 7: Automated/looped rebase or merge conflict resolution (BLOCK)
#
# Rebasing and merging require manual inspection of each conflict.
# Automating resolution in a loop (while/for + git rebase/merge --continue)
# skips the human/agent judgment step and risks silent data loss.
#
# ALL files — including CLAUDE.md — must be resolved manually.
#
# SOLE EXCEPTION: CHANGELOG.md-only conflicts during rebase/merge are safe
# to auto-resolve because CHANGELOG entries are append-only and the
# resolution is always "keep both sides, upstream first." Use the
# CHANGELOG_ONLY_REBASE=1 env var to signal this intent. The script MUST
# verify that ONLY CHANGELOG.md is conflicting and abort if any other file
# has conflicts.
# ═════════════════════════════════════════════════════════════════════
if [[ "$command" =~ ^[[:space:]]*(while|for)[[:space:]].*git[[:space:]]+(rebase|merge)[[:space:]]+--continue ]] \
|| [[ "$command" =~ \;[[:space:]]*(while|for)[[:space:]].*git[[:space:]]+(rebase|merge)[[:space:]]+--continue ]] \
|| [[ "$command" =~ \|[[:space:]]*(while|for)[[:space:]].*git[[:space:]]+(rebase|merge)[[:space:]]+--continue ]]; then
  if [[ "$command" == *"CHANGELOG_ONLY_REBASE=1"* ]]; then
    exit 0  # Explicit exception — script MUST verify only CHANGELOG.md conflicts
  fi
  cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — AUTOMATED REBASE/MERGE LOOP DETECTED  ⚠               ║
╚══════════════════════════════════════════════════════════════════════╝

You are running \`git rebase/merge --continue\` inside a loop.
Conflict resolution requires manual, per-conflict inspection.
Automating this step risks silently dropping changes.

EVERY file must be resolved manually — including CLAUDE.md, code,
tests, and configuration files. No exceptions except CHANGELOG.md.

CHANGELOG.md EXCEPTION: If ALL conflicts across ALL remaining rebase
steps are ONLY in CHANGELOG.md (append-only entries), you may use:

  CHANGELOG_ONLY_REBASE=1 bash -c '<your loop>'

The loop script MUST:
  1. Check \`git diff --name-only --diff-filter=U\` at each step
  2. ABORT if ANY file other than CHANGELOG.md is conflicting
  3. Only resolve CHANGELOG.md conflicts (keep both sides, HEAD first)

For any non-CHANGELOG conflicts, resolve manually one at a time.
EOF
  exit 2
fi

# ═════════════════════════════════════════════════════════════════════
# Check 8: Merge method enforcement per target branch (BLOCK)
#
# GitHub merge method settings are repo-wide, not per-branch.
# This hook enforces the correct method when merging via the GitHub API:
#   - integration (develop/development): squash only
#   - staging/production: merge commit only (squash severs ancestry)
#
# Detects gh-api / gh CLI calls to /pulls/*/merge with a merge_method,
# resolves the PR base branch via the GitHub API (using whatever wrapper
# is available), and blocks if the method is wrong for the base.
# ═════════════════════════════════════════════════════════════════════
if [[ "$command" =~ (gh-api|gh[[:space:]]+api).*pulls/[0-9]+/merge ]] \
|| [[ "$command" =~ gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+ ]]; then
  # Extract merge_method from the JSON body or gh CLI flags
  merge_method=$(printf '%s' "$command" | grep -oE '"merge_method"\s*:\s*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' || true)
  if [ -z "$merge_method" ]; then
    if [[ "$command" =~ gh[[:space:]]+pr[[:space:]]+merge.*--squash ]]; then
      merge_method="squash"
    elif [[ "$command" =~ gh[[:space:]]+pr[[:space:]]+merge.*--merge ]]; then
      merge_method="merge"
    elif [[ "$command" =~ gh[[:space:]]+pr[[:space:]]+merge.*--rebase ]]; then
      merge_method="rebase"
    fi
  fi

  # Extract PR number
  pr_number=$(printf '%s' "$command" | grep -oE 'pulls/[0-9]+/merge' | grep -oE '[0-9]+' || true)
  if [ -z "$pr_number" ]; then
    pr_number=$(printf '%s' "$command" | grep -oE 'gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+' | grep -oE '[0-9]+$' || true)
  fi

  github_repo=$(gg_github_repo)
  pr_base=""

  if [ -n "$merge_method" ] && [ -n "$pr_number" ] && [ -n "$github_repo" ]; then
    # Try gh CLI first (most portable)
    if command -v gh >/dev/null 2>&1; then
      pr_base=$(gh pr view "$pr_number" --repo "$github_repo" --json baseRefName -q .baseRefName 2>/dev/null || true)
    fi
    # Fall back to ~/.local/bin/gh-api wrapper if available
    if [ -z "$pr_base" ] && [ -x "$HOME/.local/bin/gh-api" ]; then
      pr_json=$(bash "$HOME/.local/bin/gh-api" "repos/$github_repo/pulls/$pr_number" 2>/dev/null || true)
      if [ -n "$pr_json" ]; then
        if command -v jq >/dev/null 2>&1; then
          pr_base=$(printf '%s' "$pr_json" | jq -r '.base.ref // empty' 2>/dev/null || true)
        elif command -v python3 >/dev/null 2>&1; then
          pr_base=$(printf '%s' "$pr_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('base',{}).get('ref',''))" 2>/dev/null || true)
        fi
      fi
    fi
  fi

  if [ -n "$merge_method" ] && [ -n "$pr_number" ]; then
    if [ -z "$pr_base" ]; then
      # Advisory: the check itself couldn't run. Surface this once so the user
      # knows the merge-method rule wasn't enforced on this call.
      echo "⚠ git-guard merge-method check skipped for PR #$pr_number (could not resolve base branch — missing gh CLI / gh-api / jq, or no github-repo configured). Verify merge method manually: integration=squash, staging/production=merge." >&2
    else
      # Integration branch: must use squash
      if [[ "$pr_base" =~ ^(develop|development)$ ]] && [ "$merge_method" != "squash" ]; then
        cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — WRONG MERGE METHOD FOR '$pr_base'  ⚠                  ║
╚══════════════════════════════════════════════════════════════════════╝

PR #$pr_number targets '$pr_base' but uses merge_method="$merge_method".

  develop/development: MUST use "squash" (one commit per feature)
  staging/production:  MUST use "merge" (preserve ancestry)

Fix: change merge_method to "squash".
EOF
        exit 2
      fi

      # Staging/production: must use merge commit
      if [[ "$pr_base" =~ ^(staging|production)$ ]] && [ "$merge_method" != "merge" ]; then
        cat >&2 <<EOF
╔══════════════════════════════════════════════════════════════════════╗
║   ⚠  BLOCKED — WRONG MERGE METHOD FOR '$pr_base'  ⚠                  ║
╚══════════════════════════════════════════════════════════════════════╝

PR #$pr_number targets '$pr_base' but uses merge_method="$merge_method".

  develop/development: MUST use "squash" (one commit per feature)
  staging/production:  MUST use "merge" (preserve ancestry)

Squash-merging promotions severs ancestry and causes phantom conflicts
on every subsequent promotion. Always use merge commits for promotions.

Fix: change merge_method to "merge".
EOF
        exit 2
      fi
    fi
  fi
fi

exit 0
