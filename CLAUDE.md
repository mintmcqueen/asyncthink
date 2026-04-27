# AsyncThink MCP Server — Developer Documentation

> **Status:** v2.0.0 released. All five refactor phases complete. The v1.1.9 git tag remains the historical pin for v1 behavior.

## Purpose

AsyncThink is an MCP server for sequential thinking with optional parallel forks to subordinate model CLIs. The central orchestrator (Claude Code, in practice) reasons step-by-step and can convene a "council" of independent perspectives — each fork is a fire-and-forget invocation of a different subordinate adapter (claude, gemini, codex). It also exposes a `delegate` tool for single-subordinate threaded conversations. All subordinates are **read-only**: they may navigate files but never edit, exec, or write.

## Tools (six)

| Tool | Purpose |
| --- | --- |
| `asyncthink` | Sequential thinking + parallel forks (council). Auto-closes chain on `nextThoughtNeeded:false`. |
| `delegate` | Open or continue a single-subordinate thread. Inline `close: true` for one-round-trip. |
| `delegate_close` | Close a thread. Idempotent. |
| `delegate_close_all` | End-of-session safety net. |
| `delegate_list_threads` | Introspection: open threads, adapter, idle time. |
| `asyncthink_config` | View config; list adapters/skills (full action set lands in Phase 5). |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ MCP Tool Layer                                           │  stable v1→v3
│   asyncthink, delegate, delegate_close, *_list, _config  │
├──────────────────────────────────────────────────────────┤
│ Orchestration                                            │  stable
│   AsyncThinkingServer  Council  Delegate                 │
├──────────────────────────────────────────────────────────┤
│ Adapters                                                 │  stable interface,
│   impl/{claude,gemini,codex}.ts (TS impls)               │  TS impl per CLI
│   manifests/{claude,gemini,codex}.json (metadata only)   │
├──────────────────────────────────────────────────────────┤
│ Storage                                                  │  swap point for v3
│   ThreadStore (JsonlThreadStore)                         │
│   TaskStore   (FsTaskStore)                              │
│   AuditLog    (Phase 5)                                  │
│   SkillRegistry (Phase 4)                                │
├──────────────────────────────────────────────────────────┤
│ Executor (LocalSubprocessExecutor)                       │  swap point for v3
└──────────────────────────────────────────────────────────┘
```

Storage and Executor are the swap points for the eventual hosted/SOC2/Vertex v3 — the tool surface and orchestration code stay identical when the cloud port lands.

## Adapters

Three subordinates ship in v2: `claude`, `gemini`, `codex`. Each is a TypeScript impl that knows its CLI's argv shape and session-resume convention; manifests in `server/src/adapters/manifests/*.json` carry only metadata (binary, default model, env requirements, default timeout). New adapter = new TS file under `server/src/adapters/impl/` plus a JSON manifest.

**Why not pure JSON manifests:** flag-shape variance across CLIs (gemini's `--include-directories`, codex's inline-files-in-prompt, native vs replay session resume) cannot be cleanly templated as JSON. Metadata templates well; execution doesn't.

**Read-only enforcement** is per-adapter:
- `claude` — invoked with `claude --print <prompt>`. Print mode runs without edit/exec tools.
- `gemini` — invoked with `--approval-mode plan` (planning agent, read-only navigation).
- `codex` — invoked with `--sandbox read-only`. v0.47 dropped `--ask-for-approval`; sandbox mode now governs both access and approval flow.

**Session continuation** is declared per-adapter via `Adapter.resumeStrategy`:
- `'native'` (codex) — orchestrator passes the prior turn's `sessionId`; the CLI resumes via `codex exec resume <thread_id>`. The adapter extracts `thread_id` from the `{"type":"thread.started"}` event in the `--json` stream.
- `'replay'` (claude, gemini) — orchestrator serializes prior turns into the prompt itself before each call. Adapters echo `inv.sessionId` back (or mint a uuid) for stable thread ids.

Codex env: `OPENAI_API_KEY` (or `codex login`). Gemini env: `GEMINI_API_KEY` or `GOOGLE_API_KEY`. Claude: uses the user's authenticated CLI session.

## Threading + Delegate

Threads are durable, append-only JSONL transcripts. The `delegate` tool dispatches one turn per call, persisting both user and assistant turns. Threads survive server restart (validated by `__tests__/integration/restartSurvival.test.ts`).

**Storage layout:**
- `~/.local/share/asyncthink/threads/<threadId>.jsonl` — open
- `~/.local/share/asyncthink/threads/closed/<threadId>.jsonl` — closed
- Each line is one JSON object: a `{kind:"meta"}` header on open or a `{kind:"turn", ...}` body line. Atomic via `fs.appendFileSync` (`O_APPEND`).
- Read tolerates corrupted/truncated lines: it parses what it can and skips the rest.

**Defense-in-depth against thread leakage** (no `Stop` hook in v1; deferred to v2.x):
1. Inline `close: true` on `delegate` for one-round-trip closure.
2. Explicit `delegate_close` / `delegate_close_all` tools with reminder fields baked into every response.
3. Idle sweeper at 6h (`server/src/delegate/sweeper.ts`) — runs on every tool call, rate-limited to once per 30s. On next session start, the sweeper hits any leftover stale threads.

## Skills

Skills are markdown-with-frontmatter delegation templates. They bind a specific adapter to a curated prompt body so that callers can invoke a workflow by name (`delegate({skill: "code-review"})`) instead of hand-crafting both the adapter and the prompt every time.

**Storage:**
- `<plugin-root>/skills/<name>/SKILL.md` — built-ins (committed to the plugin)
- `~/.config/asyncthink/skills/<name>.md` — user-defined; overrides plugin skills with the same id

**Frontmatter (YAML, line-oriented `key: value`):**
```yaml
---
adapter: codex                # required
description: Adversarial code review focusing on bugs and security
files_glob: src/**/*.ts       # optional
model: gpt-5.4                # optional
timeout_ms: 240000            # optional
---
```

The body of the markdown file is the **prompt prefix** — the system context that orients the subordinate before the caller's per-invocation prompt.

**Resolution rules** (`server/src/skills/resolver.ts`):
- Adapter from frontmatter is authoritative. If the caller passes a different adapter, the call errors (`SkillAdapterMismatchError`).
- Caller's `model` and `timeoutMs` override the skill's defaults.
- `prompt = skill.promptBody + "\n\n---\n\n" + caller.prompt`.

**Built-in skills (Phase 4):**
- `code-review` (codex) — adversarial review focused on bugs, security, concurrency, contract clarity. Globs to source extensions.
- `architecture-critique` (gemini) — independent design critique of coupling, failure modes, scaling pressure points, evolution paths. Globs to docs and architecture markdown.
- `test-design` (claude) — coverage analysis focused on intended behavior, weak assertions, missing acceptance tests at system boundaries.

**Slash commands (Phase 4):**
- `/asyncthink:critique` — wraps `delegate` with the architecture-critique skill.
- `/asyncthink:review-pr` — wraps `delegate` with the code-review skill against the current branch's diff vs the integration branch.

## Audit log

`JsonlAuditLog` (`server/src/stores/jsonlAuditLog.ts`) records every adapter invocation and thread-lifecycle event to `~/.local/share/asyncthink/audit.jsonl`. Each line is a JSON object: `{ts, pid, event}`. `event` is either `{kind:"invoke", adapter, durationMs, threadId?, error?}` or `{kind:"thread.open"|"thread.close", threadId, adapter}`.

Built from day 1 even though v1 isn't SOC2-attested — capturing logs early means real audit data is available when the v3 cloud port pursues SOC2 Type 1. Failure-isolated: write errors log to stderr but do not break tool calls.

## Council (asyncthink forks)

Each `asyncthink` chain has a `chainThreadId`. Forks within a thought are children threads named `<chainThreadId>::<forkId>`. Tasks in `FsTaskStore` use the same scoping so concurrent chains do not collide.

Forks are fire-and-forget: `Council.fork()` registers the in-flight promise and returns immediately. The caller collects results later via `waitFor` or `readResearch`, or lets the final thought (`nextThoughtNeeded:false`) auto-collect everything via `Council.endChain()`. End-of-chain:
1. Awaits any remaining in-flight forks, up to a per-call timeout (default 180s).
2. Closes all child threads.
3. Prunes the chain's tasks from `FsTaskStore`.
4. Returns aggregated results to the tool handler for inclusion in the response.

## Repo layout

```
/                                    # plugin root
├── .claude-plugin/plugin.json
├── .mcp.json
├── commands/
├── skills/                          # Phase 4
├── agents/
├── hooks/
├── README.md
├── CHANGELOG.md
├── CLAUDE.md
└── server/
    ├── package.json
    ├── tsconfig.json
    ├── vitest.config.ts
    ├── src/
    │   ├── index.ts                 # MCP wiring, tool registration
    │   ├── app.ts                   # singletons (registry, executor, stores, delegate, council, thinking)
    │   ├── core/                    # interfaces only (adapter, executor, *Store, *Registry, manifests, config)
    │   ├── adapters/
    │   │   ├── manifests/{claude,gemini,codex}.json
    │   │   ├── impl/{claude,gemini,codex}.ts
    │   │   ├── registry.ts          # FsManifestRegistry
    │   │   └── index.ts             # AdapterRegistry.withDefaults()
    │   ├── stores/
    │   │   ├── jsonlThreadStore.ts
    │   │   ├── fsTaskStore.ts
    │   │   └── jsonlAuditLog.ts     # Phase 5
    │   ├── exec/localSubprocess.ts
    │   ├── asyncthink/
    │   │   ├── thinking.ts
    │   │   ├── council.ts
    │   │   └── prompts.ts
    │   ├── delegate/
    │   │   ├── delegate.ts
    │   │   └── sweeper.ts
    │   └── tools/
    │       ├── asyncthink.tool.ts
    │       ├── delegate.tool.ts
    │       ├── config.tool.ts
    │       └── _stub.ts
    └── __tests__/
        ├── contracts/               # *.spec.json acceptance fixtures
        ├── unit/                    # interface unit tests, fake Executor
        ├── integration/             # in-process MCP, fake adapters
        ├── live/                    # real CLIs, RUN_LIVE=1
        ├── _helpers/recordingExecutor.ts
        └── runContract.ts           # spec runner for delegate flows
```

## Test policy (two-tier)

CI runs `*.test.ts` end-to-end against MCP tool contracts with a fake `Executor` injected at the OS-process boundary. This is dependency injection, not mocking the system under test — the MCP server itself is unmocked. Live tests (`*.live.test.ts`) hit real `gemini`, `codex`, `claude` binaries; gated on `RUN_LIVE=1`, executed locally by developers and via a nightly cron.

Acceptance specs live as JSON fixtures under `__tests__/contracts/`. The delegate spec is replayed by `runContract.ts` in both modes (same spec, two execution backends).

## Persistence (XDG)

```
~/.local/share/asyncthink/
├── threads/                                    # active conversation transcripts
│   ├── <threadId>.jsonl
│   └── closed/<threadId>.jsonl                 # closed transcripts retained for inspection
├── tasks/<sanitizedTaskId>/state.json          # in-flight worker state mirror (debug/audit)
└── audit.jsonl                                 # Phase 5
```

## Logging conventions

All logs go to **stderr** (stdout is reserved for MCP protocol).

| Prefix | Source |
| --- | --- |
| `[AsyncThink]` | top-level server |
| `[Council]` | parallel-fork orchestration |
| `[Delegate]` | single-subordinate handoff |
| `[ThreadStore]` | transcript persistence |
| `[TaskStore]` | in-flight task state |
| `[Adapter:<id>]` | per-adapter execution |

## Environment variables

```bash
# Required per adapter (only adapters you use):
GEMINI_API_KEY=...      # or GOOGLE_API_KEY for gemini
OPENAI_API_KEY=...      # or `codex login` for codex
# claude inherits the user's authenticated Claude Code session

# Optional overrides:
DISABLE_THOUGHT_LOGGING=true   # suppress formatted thought boxes on stderr
XDG_DATA_HOME=/custom/path     # override XDG data root
RUN_LIVE=1                     # opt into live test suites
```

## Development

```bash
cd server
npm install
npm run build         # tsc + chmod +x dist/index.js
npm test              # vitest, coverage scoped to src/
npm run watch         # tsc --watch

# Live tests (requires gemini, codex, claude installed + authenticated):
RUN_LIVE=1 npm test
```

## Methodology (per `/Users/jb/.claude/plans/quiet-cooking-feigenbaum.md`)

- `/git-guard` — installed in Phase 0; personal-branch gitflow hooks govern the entire refactor.
- `/rigorous-refactor` — task-list discipline starting Phase 1.
- `/doc-guard` — at the end of every phase: CLAUDE.md and CHANGELOG.md must be in sync with the phase's changes.
- `/branch-rotation` — at the end of every phase, after `/doc-guard`. (Bundled until end of refactor for this round, per user direction.)

## Live-test status on this dev environment

- **claude** PONG live test passes.
- **gemini** — verified live PONG against gemini-cli v0.39.x with the modern flag set (`--output-format json`, `--approval-mode plan`, `--include-directories`, `-r/--resume`, `--skip-trust`). Adapter passes `--skip-trust` because modern gemini-cli refuses `--approval-mode` overrides outside "trusted" folders, and we invoke from arbitrary cwds. Minimum version: gemini-cli ≥ 0.39.
- **codex** — installed `codex` v0.47.0; auth currently shows 401 Unauthorized. Run `codex login` or set `OPENAI_API_KEY` to enable live tests.

These are environmental, not code. Unit tests prove adapter argv correctness.
