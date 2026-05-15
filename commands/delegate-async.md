---
description: Spawn a background delegate task that survives this turn. Returns a taskId you can poll via /asyncthink:tasks or tasks_get/tasks_result.
---

# /asyncthink:delegate-async $ARGUMENTS

You are about to start a fire-and-forget delegate task. The work runs in the background — control returns immediately with a `taskId` and the orchestrator can check on it later via `tasks_get`, block on it via `tasks_result`, or cancel it via `tasks_cancel`.

If `$ARGUMENTS` looks like a JSON object, treat it as the full delegate args. Otherwise treat the entire string as the prompt and pick a reasonable default adapter for an audit-style task (`claude` for codebase navigation, `codex` for code-specific review, `gemini` for fast metacognition).

Call the `delegate` MCP tool with `async: true` and an `idempotencyKey` derived from the prompt + adapter (so re-issuing the same command does not spawn duplicate tasks). Optional fields:
- `intelligence`: `"high" | "med" | "low"` — prefer this over a raw model id.
- `ttlMs`: caller TTL clamp (60s minimum, 60m default).
- `files`: absolute paths the subordinate may read.

Print the returned `taskId` clearly, along with the reminder field. The user can copy the taskId into a subsequent `/asyncthink:tasks` invocation or call `tasks_result({taskId})` directly when they are ready for the answer.

Do NOT block on the result inside this slash command. The whole point is to keep the foreground free.
