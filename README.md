# AsyncThink

A Claude Code plugin (and MCP server) for sequential thinking with parallel forks to subordinate model CLIs (claude, gemini, codex). Convene a "council" of independent perspectives during a deliberation, or hand a focused task to a single subordinate via a threaded conversation. All subordinates are read-only — they may navigate files but never edit, exec, or write.

## Features

- **Sequential thinking** with structured thoughts, branching, and revision tracking.
- **Parallel council** — fan out fire-and-forget forks to multiple subordinate adapters within a single thought; collect results later.
- **Background jobs (v2.2)** — MCP Tasks primitive (SEP-1686) baked in. Spawn long-running adapter work via `delegate({async:true})`, poll via `tasks_get`, block via `tasks_result`, cancel via `tasks_cancel`. Idempotency keys, category-wise TTLs, and principal binding ready for v3 cloud.
- **Threaded delegation** — open a `delegate` thread with one subordinate, persist transcripts, continue across multiple calls. Codex uses native session resume; claude and gemini use replay strategy.
- **Skill registry** — bind adapter + prompt prefix to a named skill (`code-review`, `architecture-critique`, `test-design` ship in v2.0.0). v2.2 adds successor-model substitution: skills survive model-name churn automatically.
- **Tier-based model selection** — pin to `intelligence: high|med|low` instead of raw model ids. Manifests carry `tierLimits` (max context, rate-limit class, latency hints) that gate dispatch.
- **Read-only enforcement** per adapter (`claude --print`, `gemini --approval-mode plan`, `codex --sandbox read-only`).
- **Audit log** — append-only JSONL of every adapter invocation, thread lifecycle event, task lifecycle event, and model substitution. Daily rotation with 90-day retention.
- **XDG-compliant persistence** at `~/.local/share/asyncthink/` (threads, tasks, audit log).

## Install

### As a Claude Code plugin (development)

From a directory containing this repo:
```sh
claude --plugin-dir ./asyncthink
```

This loads the plugin and exposes its tools and slash commands in your Claude Code session.

### As a standalone MCP server

```sh
cd server
npm install
npm run build
```

Then point your MCP client at `server/dist/index.js`.

## Prerequisites

You need at least one of the subordinate CLIs installed and authenticated:

| Adapter | Binary | Auth |
| --- | --- | --- |
| `claude` | `claude` (Claude Code CLI) | inherits user's authenticated session |
| `gemini` | `gemini` (Google Gemini CLI) | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `codex` | `codex` (OpenAI Codex CLI) | `codex login` or `OPENAI_API_KEY` |

The adapter manifests target current upstream flag sets (gemini-cli with `--output-format`, `--approval-mode`, `--include-directories`, `--resume`; codex v0.47+). Older CLI versions may not work with the modern flag set.

## Tools

| Tool | Purpose |
| --- | --- |
| `asyncthink` | Sequential thinking + parallel forks. Auto-closes chain on `nextThoughtNeeded:false`. v2.2: `forks[].async` for detached fire-and-forget. |
| `delegate` | Open or continue a single-subordinate thread. Inline `close: true` for one-round-trip. v2.2: `async`, `idempotencyKey`, `ttlMs`, `credentials`. |
| `delegate_close` | Close a thread (idempotent). |
| `delegate_close_all` | End-of-session safety net. |
| `delegate_list_threads` | List open threads with adapter and idle time. |
| `asyncthink_config` | `list_adapters`, `list_skills`, `reload_skills`, `list_tasks` (v2.2), `cancel_task` (v2.2). |
| `tasks_get` | (v2.2) Snapshot a task's status. Idempotent. |
| `tasks_list` | (v2.2) Cursor-paginated list of tasks. |
| `tasks_cancel` | (v2.2) Best-effort cancel (SIGTERM + state flip). Idempotent. |
| `tasks_result` | (v2.2) Block until terminal; return the underlying response. |

### Slash commands (Claude Code)

- `/asyncthink:critique [topic]` — independent architectural critique via gemini.
- `/asyncthink:review-pr [focus]` — adversarial code review of the current branch's diff via codex.
- `/asyncthink:delegate-async [prompt]` — (v2.2) fire-and-forget delegate; returns a `taskId` immediately.
- `/asyncthink:tasks [taskId?]` — (v2.2) list async tasks with status; pass an id for detail.

### Background jobs example

```jsonc
// 1. Kick off a long-running audit; control returns immediately.
delegate({
  adapter: "codex",
  prompt: "Audit this monorepo for security issues. Be exhaustive.",
  async: true,
  intelligence: "high",
  idempotencyKey: "monorepo-security-audit-v1",
  ttlMs: 1800000  // 30 minutes
})
// → { taskId: "tsk-...", status: "working", reminder: "Async task created..." }

// 2. Later, check status without blocking.
tasks_get({ taskId: "tsk-..." })
// → { status: "working" | "completed" | ... }

// 3. When ready, harvest the answer.
tasks_result({ taskId: "tsk-..." })
// → { status: "completed", result: { text: "...", durationMs, sessionId } }
```

## Authoring a skill

Drop a markdown file under `~/.config/asyncthink/skills/<name>.md`:

```markdown
---
adapter: codex
intelligence: high
description: What this skill is for and when to use it
files_glob: src/**/*.ts
timeout_ms: 240000
---

You are <persona>. Your job is to <task>.

(prompt prefix that orients the subordinate)
```

`intelligence` is one of `high`, `med`, `low` — adapters map tiers to current model ids in their manifest, so skills stay stable as model names evolve. Override with a raw `model:` field if you need a specific id.

User skills override plugin-shipped skills with the same id. After editing, run `asyncthink_config({action: "reload_skills"})` to pick up the change.

## Persistence

```
~/.local/share/asyncthink/
├── threads/<threadId>.jsonl                    # active conversation transcripts
├── threads/closed/<threadId>.jsonl             # closed transcripts (retained for inspection)
├── tasks/<sanitizedTaskId>/state.json          # in-flight worker state (debug)
└── audit.jsonl                                 # append-only audit log
```

## Test mode

CI runs unit and integration tests with a fake `Executor` injected at the OS-process boundary. Live tests hit real CLIs and are gated:

```sh
cd server
npm test                  # unit + integration (fast, no API keys needed)
RUN_LIVE=1 npm test       # also runs live/* tests against real CLIs
```

Live tests exercise PONG round-trips, multi-turn conversations (codex native resume; claude/gemini replay), and a 3-fork council. They require the relevant CLIs installed and authenticated.

## Architecture

See `CLAUDE.md` for the developer-facing architecture document covering adapters, threading, council, the storage interfaces (`ThreadStore`, `TaskStore`, `AuditLog`, `SkillRegistry`), and the v3 cloud port plan.

## v1 → v2 migration

If you ran a previous v1.x install, your old `~/.local/share/asyncthink/ledger.json` will be renamed to `ledger.v1.json.bak` on first v2 startup. v2 uses a different state layout under `tasks/`. In-flight v1 tasks were stale by definition after a server restart; nothing is lost.

## License

MIT.
