#!/bin/bash
#
# git-guard Claude Code PostToolUse hook — branch health and rotation reminders.
#
# Single hook handling two triggers:
#   1. After a successful PR merge to the integration branch: remind to rotate/prune
#   2. After git fetch/pull: report divergence from the integration branch
#
# Uses a timestamp marker (.git-guard/last-rotation-reminder) to avoid firing
# both triggers in the same workflow (merge → fetch → double noise).
#
# Protocol:
#   Stdin:  JSON { "tool_name": "Bash", "tool_input": { "command": "..." }, "tool_output": "..." }
#   Exit 0: always (advisory, never blocks)
#   Stderr: reminder/report shown to Claude

set -e

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$tool_name" = "Bash" ] || exit 0

command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$command" ] && exit 0

output=$(printf '%s' "$input" | jq -r '.tool_output // empty' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$PROJECT_ROOT" ] && exit 0
cd "$PROJECT_ROOT" || exit 0

# ── git-guard config ────────────────────────────────────────────────
gg_config() {
  local value
  value=$(git config --get "git-guard.$1" 2>/dev/null || true)
  if [ -n "$value" ]; then echo "$value"; else echo "$2"; fi
}

gg_integration_branch() {
  local explicit
  explicit=$(gg_config integration-branch "")
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  if git rev-parse --verify origin/development >/dev/null 2>&1; then
    echo "development"
  elif git rev-parse --verify origin/develop >/dev/null 2>&1; then
    echo "develop"
  fi
}

gg_github_repo() {
  local explicit
  explicit=$(gg_config github-repo "")
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  local url
  url=$(git remote get-url origin 2>/dev/null || true)
  [ -z "$url" ] && return
  echo "$url" | sed -E 's|^git@github\.com:||; s|^https?://github\.com/||; s|\.git$||'
}

INTEGRATION_BRANCH=$(gg_integration_branch)
[ -z "$INTEGRATION_BRANCH" ] && exit 0

PROTECTED_BRANCHES_RE=$(gg_config protected-branches '^(develop|development|staging|production|master|main)$')
MARKER_FILE=".git-guard/last-rotation-reminder"
COOLDOWN_SECONDS=120

recently_fired() {
  [ -f "$MARKER_FILE" ] || return 1
  local last=$(cat "$MARKER_FILE" 2>/dev/null || echo "0")
  local now=$(date +%s)
  [ $((now - last)) -lt $COOLDOWN_SECONDS ]
}

mark_fired() {
  mkdir -p .git-guard 2>/dev/null
  date +%s > "$MARKER_FILE"
}

current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Skip protected branches and detached HEAD
if [[ "$current_branch" =~ $PROTECTED_BRANCHES_RE ]] || [ "$current_branch" = "HEAD" ] || [ "$current_branch" = "unknown" ]; then
  exit 0
fi

# ── Trigger 1: Merge to integration branch ───────────────────────────

if ([[ "$command" =~ (gh-api|gh[[:space:]]+api).*pulls/[0-9]+/merge ]] || [[ "$command" =~ gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+ ]]) \
&& [[ "$output" == *'merged'* ]]; then
  if [[ "$output" == *'"merged":true'* ]] || [[ "$output" == *'"merged": true'* ]] \
  || [[ "$output" == *'merged=True'* ]] || [[ "$output" == *'successfully merged'* ]]; then

    pr_number=$(printf '%s' "$command" | grep -oE 'pulls/[0-9]+/merge' | grep -oE '[0-9]+' || true)
    [ -z "$pr_number" ] && pr_number=$(printf '%s' "$command" | grep -oE 'gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+' | grep -oE '[0-9]+$' || true)
    [ -z "$pr_number" ] && exit 0

    github_repo=$(gg_github_repo)
    pr_base=""
    pr_head=""

    if [ -n "$github_repo" ]; then
      if command -v gh >/dev/null 2>&1; then
        pr_base=$(gh pr view "$pr_number" --repo "$github_repo" --json baseRefName -q .baseRefName 2>/dev/null || true)
        pr_head=$(gh pr view "$pr_number" --repo "$github_repo" --json headRefName -q .headRefName 2>/dev/null || true)
      fi
      if [ -z "$pr_base" ] && [ -x "$HOME/.local/bin/gh-api" ]; then
        pr_json=$(bash "$HOME/.local/bin/gh-api" "repos/$github_repo/pulls/$pr_number" 2>/dev/null || true)
        if [ -n "$pr_json" ] && command -v python3 >/dev/null 2>&1; then
          pr_base=$(printf '%s' "$pr_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('base',{}).get('ref',''))" 2>/dev/null || true)
          pr_head=$(printf '%s' "$pr_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('head',{}).get('ref',''))" 2>/dev/null || true)
        fi
      fi
    fi

    [ -z "$pr_base" ] && exit 0
    [[ "$pr_base" =~ ^(develop|development)$ ]] || exit 0
    [ "$current_branch" = "$pr_head" ] || exit 0

    next_hint=""
    if [[ "$current_branch" =~ ^developer/(.+)_(a|b)$ ]]; then
      initials="${BASH_REMATCH[1]}"
      if [ "${BASH_REMATCH[2]}" = "a" ]; then next="b"; else next="a"; fi
      next_hint="developer/${initials}_${next}"
    fi

    if [ -n "$next_hint" ]; then
      new_branch_line="git checkout -b ${next_hint} origin/${pr_base}"
    else
      new_branch_line="git checkout -b <new-branch> origin/${pr_base}"
    fi

    unpushed="0"
    if git rev-parse --verify "origin/${current_branch}" >/dev/null 2>&1; then
      unpushed=$(git rev-list --count "origin/${current_branch}..HEAD" 2>/dev/null || echo "0")
    fi
    dirty=$(git status --porcelain 2>/dev/null | head -1)

    cat >&2 <<EOF

  POST-MERGE: '${current_branch}' was squash-merged to ${pr_base}.
  Do not continue committing here — prune and start fresh:

    git fetch origin ${pr_base}
    ${new_branch_line}
    git branch -D ${current_branch}
    git push origin --delete ${current_branch}

EOF

    if [ "$unpushed" != "0" ] || [ -n "$dirty" ]; then
      cat >&2 <<EOF
  WARNING: ${unpushed} unpushed commit(s), uncommitted changes: $([ -n "$dirty" ] && echo "yes" || echo "no")
  Cherry-pick or re-implement this work on the new branch.

EOF
    fi

    mark_fired
    exit 0
  fi
fi

# ── Trigger 2: Fetch/pull from integration branch ────────────────────

if [[ "$command" =~ git[[:space:]]+(fetch|pull) ]]; then
  git rev-parse --git-dir >/dev/null 2>&1 || exit 0
  git rev-parse --verify "origin/${INTEGRATION_BRANCH}" >/dev/null 2>&1 || exit 0

  recently_fired && exit 0

  merge_base=$(git merge-base HEAD "origin/${INTEGRATION_BRANCH}" 2>/dev/null || true)
  [ -z "$merge_base" ] && exit 0

  dev_ahead=$(git rev-list --count "$merge_base..origin/${INTEGRATION_BRANCH}" 2>/dev/null || echo "0")
  [ "$dev_ahead" = "0" ] && exit 0

  branch_ahead=$(git rev-list --count "$merge_base..HEAD" 2>/dev/null || echo "0")

  unpushed="0"
  if git rev-parse --verify "origin/${current_branch}" >/dev/null 2>&1; then
    unpushed=$(git rev-list --count "origin/${current_branch}..HEAD" 2>/dev/null || echo "0")
  fi
  dirty=$(git status --porcelain 2>/dev/null | head -1)

  cat >&2 <<EOF

  BRANCH HEALTH: '${current_branch}' has diverged from ${INTEGRATION_BRANCH}.
    ${INTEGRATION_BRANCH}: +${dev_ahead} | this branch: +${branch_ahead} | unpushed: ${unpushed} | dirty: $([ -n "$dirty" ] && echo "yes" || echo "no")

  Option A (PR was merged): rotate to fresh branch, cherry-pick new work
  Option B (PR not merged): git rebase origin/${INTEGRATION_BRANCH}

EOF

  mark_fired
fi

exit 0
