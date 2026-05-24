---
description: Run a multi-perspective code review panel against the current branch's diff vs the integration branch. Spawns 4 parallel claude subagents (security, simplify, test-coverage, correctness) for non-overlapping perspectives.
---

# /asyncthink:review-pr $ARGUMENTS

You are about to run a **multi-perspective code review panel** of the current branch's changes. Four reviewer personas spawn in parallel against the same diff, each focused on a distinct axis — so the user gets four non-overlapping perspectives rather than one generic "looks fine" pass.

## Prep

1. **Determine the integration branch.**
   - First try: `git config git-guard.integration-branch`
   - Fallback chain: `develop` → `main` (test with `git rev-parse --verify <name>` before settling)
2. **Compute the diff.**
   - Diff: `git diff <integration-branch>...HEAD`
   - Changed files: `git diff --name-only <integration-branch>...HEAD`
3. **Filter the file list** to source code only. Drop docs (`*.md`, `*.txt`), lockfiles (`*-lock.json`, `*.lock`), generated dirs (`dist/`, `build/`, `coverage/`, `node_modules/`), and binary assets. Keep the diff text whole — reviewers can ignore noise but missing context is fatal.
4. If `$ARGUMENTS` is non-empty, treat it as an additional focus directive ("focus on the auth module", "the change to retry logic"). Append it to each reviewer's prompt.

## Spawn the panel

Use the `asyncthink` MCP tool with **four parallel forks**, one per reviewer subagent. All four use the claude adapter and rely on the subscription auth path so the v2.7 subagent injection fires.

```json
{
  "thought": "Spawning 4-reviewer code-review panel for branch <branch-name> vs <integration-branch>. Each reviewer has a distinct focus; their findings will be aggregated.",
  "thoughtNumber": 1,
  "totalThoughts": 2,
  "nextThoughtNeeded": true,
  "forks": [
    {
      "id": "security",
      "adapter": "claude",
      "subagent": "security-review",
      "prompt": "<diff + focus directive>",
      "files": [<changed source files>]
    },
    {
      "id": "simplify",
      "adapter": "claude",
      "subagent": "simplify-review",
      "prompt": "<diff + focus directive>",
      "files": [<changed source files>]
    },
    {
      "id": "test-coverage",
      "adapter": "claude",
      "subagent": "test-coverage-review",
      "prompt": "<diff + focus directive>",
      "files": [<changed source files>]
    },
    {
      "id": "correctness",
      "adapter": "claude",
      "subagent": "correctness-review",
      "prompt": "<diff + focus directive>",
      "files": [<changed source files>]
    }
  ]
}
```

On the second (and final) thought, close the chain with `nextThoughtNeeded: false`. This auto-waits for all four forks, closes their child threads, and returns aggregated `researchResults`.

```json
{
  "thought": "All four reviewers complete; aggregating findings.",
  "thoughtNumber": 2,
  "totalThoughts": 2,
  "nextThoughtNeeded": false
}
```

## Aggregating + presenting findings

Render the four reviewers' outputs in this order:

1. **Security** (read first — security issues take priority).
2. **Correctness** (logic bugs, race conditions, edge cases).
3. **Test Coverage** (gaps that should be filled before merge).
4. **Simplify** (anti-bloat — separated so the user can choose to defer to a follow-up PR).

For each section:
- Quote the reviewer's findings verbatim. Don't paraphrase; their precision matters.
- Flag any **critical/high severity** items with a clear marker at the very top of the response.
- Note when reviewers AGREE on something (high signal) versus when they disagree (worth investigating).
- If a reviewer says "no issues found in this area", surface that — it's useful negative evidence.

End with a one-paragraph synthesis the user can act on:
- Top 3 blocking issues to address before merge.
- Anything load-bearing the reviewers flagged as low confidence but worth checking.
- Whether the diff is ready to merge (your judgment, not theirs).

## Failure modes

- **Subscription auth not available** (user has `ANTHROPIC_API_KEY` set, so they're on api path): the `claude.subagent.spawn` audit event won't fire and the spawn falls back to default Claude Code persona — reviewers will be less focused but still functional. Note this in your response if you see it in the audit log.
- **One or more forks fail**: continue with the survivors. Don't block the whole panel because one reviewer 429'd. Surface the failed-fork ids and reasons in your aggregation.
- **No diff against integration branch**: tell the user the branch is at parity; nothing to review. Don't manufacture work.

## Notes

- The four subagents are bootstrapped on plugin install (v2.7.0+); they're always available.
- If the user wants a single-reviewer perspective instead of the panel, use `/asyncthink:critique` (architecture-only) or call `delegate({adapter: 'claude', subagent: '<id>', prompt: ...})` directly.
- The `code-review` skill (codex-based, single-perspective) still exists for users with `OPENAI_API_KEY` who prefer codex's tendency toward terse bug-finding — invoke explicitly via `delegate({skill: "code-review"})`.
