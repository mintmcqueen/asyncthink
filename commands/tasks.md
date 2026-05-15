---
description: List async tasks and their current status. Pass a taskId to get details on a specific task.
---

# /asyncthink:tasks $ARGUMENTS

If `$ARGUMENTS` is a single token that looks like a task id (`tsk-...`), call the `tasks_get` MCP tool with that id and print the full state record.

If `$ARGUMENTS` is empty, call the `tasks_list` MCP tool with `limit: 20` (no cursor). Render the result as a compact table with columns:
- `taskId`
- `adapter`
- `status` (working | completed | failed | cancelled)
- `lastUpdatedAt` (ISO short form)
- `error` if non-empty (truncate to one line)

After the table, remind the user of the next-step actions:
- `tasks_result({taskId})` — block until terminal, get the underlying response.
- `tasks_cancel({taskId})` — best-effort cancellation; flips state to `cancelled` immediately.
- `/asyncthink:tasks <taskId>` — focused detail view.

If `$ARGUMENTS` is `clear`, `wipe`, or `reset`, do NOT do anything destructive — these tasks expire on their own per category TTL (working/completed 60m, failed 10m, cancelled 5m). Print the TTL policy and stop.
