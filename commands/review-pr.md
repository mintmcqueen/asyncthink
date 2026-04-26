---
description: Run an adversarial code review (codex) against the current branch's diff vs the integration branch.
---

# /asyncthink:review-pr $ARGUMENTS

You are about to run an adversarial code review of the current branch's changes.

Steps:
1. Determine the integration branch (try `git config git-guard.integration-branch`; default to `develop` if unset, falling back to `main`).
2. Compute the diff: `git diff <integration-branch>...HEAD` and the list of changed files: `git diff --name-only <integration-branch>...HEAD`.
3. Filter file paths to source code (drop docs, lockfiles, generated dirs).
4. Invoke the `delegate` MCP tool with `skill: "code-review"`, passing the diff/file list as the prompt and the changed source files as `files`. Optional focus passed as `$ARGUMENTS` should be appended to the prompt.
5. Quote the reviewer's findings, organized by severity. Flag any security issues immediately.
6. Close the delegate thread with `delegate_close` when done.

Use the integration branch from git-guard config when present; do not assume `main`.
