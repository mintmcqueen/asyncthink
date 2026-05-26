# AsyncThink MCP Server — Developer Documentation

> **Status:** v2.9.0 released. **Council refactored to task-based polling (SEP-1686 native).** The previous shared-timeout race (`Promise.race([allForks, timeout(180_000)])`) cut off healthy long-running forks — surfaced in the v2.8.0 playtest when claude-haiku panel reviewers took 200-400s. Now each fork waits independently via `taskExecutor.result(taskId)`; one slow fork doesn't starve the chain. New `defaults.chainEndTimeoutMs` setting (default 15 min) is a safety ceiling, not the expected wait. Council constructor down from 7 deps to 2 (`new Council(taskExecutor, taskStore)`); `~150 LOC` removed (gates, runFork, in-flight tracking — all subsumed by `TaskExecutor.runTask`). 378 tests pass including a new regression spec proving a 500ms fork completes under a 5s ceiling (which the old 180ms hardcode would have failed). v2.8.1: **Security fix.** Path-traversal in `FsSubagentRegistry`: any `subagent` id that didn't match the slugify shape (e.g. `"../../../etc/passwd"`) was passed to `path.join` which normalizes traversal sequences, then `readFile`'d. If the target file contained valid JSON with `id`+`name` keys, it became a live `Subagent` injected into the `--agents` flag. Fixed by validating ids match `slugifyName` output at every filesystem entry point (centralized in `pathFor()` + symmetric `isValidSubagentId()` helper exported from `core/subagent.ts`). 30 new regression specs in `__tests__/unit/subagentRegistry.test.ts` cover path-traversal, absolute paths, leading-dash, uppercase, and the full attack scenario (malicious JSON placed outside storageDir). **Discovered by AsyncThink's own `security-review` subagent during a `/asyncthink:review-pr` panel run against the v2.8.0 diff** — the persona caught exactly the kind of bug it's designed to catch, proving the v2.6/v2.7/v2.8 subagent system end-to-end. 377 tests total. v2.8.0: Subagent injection pivot: removed the v2.6/v2.7 auth-path gate (`detectAuthPath === 'subscription'`) in favor of explicit `defaults.injectSubagent` setting (default `true`). Reason: the heuristic was fragile — users with `ANTHROPIC_API_KEY` as a fallback (but actually using subscription auth) silently got NO injection. The `--agents` claude-CLI flag applies at the session-config layer pre-model-call, so injection works identically across subscription / api / vertex / bedrock paths. **Empirically validated**: live test now passes on api path (marker phrase steered response with `ANTHROPIC_API_KEY` set). Audit event `claude.subagent.spawn` still surfaces the detected `authPath` for diagnostic clarity even though it no longer gates the decision. v2.7.2: **Boot-blocker fix.** v2.4 dropped `dotenv` from `package.json` but left a side-effect `import 'dotenv/config';` at line 11 of `src/index.ts`. The grep used in v2.4 cleanup matched `from 'dotenv'` and `dotenv.` but missed the side-effect form. Tests never imported `src/index.ts` so vitest passed; the MCP server crashed at boot with `ERR_MODULE_NOT_FOUND` on every Claude Code restart from v2.4 through v2.7.1. Fixed: removed the import. Added `__tests__/integration/bootSmoke.test.ts` which spawns `node dist/index.js` as a subprocess and asserts clean boot — permanent regression guard for the "entry-point silently broken" class of bug. 353 tests total. v2.7.1: Test-only patch: adds `__tests__/integration/subagentPropagation.test.ts` (8 specs covering all 4 invocation paths + skill-frontmatter resolution + caller-wins precedence + claude argv shape) and `__tests__/live/subagentSpawn.live.test.ts` (live `claude --print` with marker-phrase subagent, gated on `RUN_LIVE=1 + no ANTHROPIC_API_KEY`). 352 tests total, no behavior change. v2.7.0: Discoverable configuration + four-reviewer code-review panel. (1) **`/asyncthink:config` slash command** wraps all eight `asyncthink_config` actions in natural-language UX — `/asyncthink:config switch default to gemini`, `/asyncthink:config create a security subagent`, etc. (2) **Four built-in code-review subagents** bootstrap alongside `asyncthink-delegate`: `security-review` (adversarial OWASP), `simplify-review` (anti-bloat), `test-coverage-review` (behavioral gaps), `correctness-review` (races + edges). All read-only. (3) **Per-call subagent override** on `delegate`, `asyncthink` forks, and skill frontmatter — single chain can now spawn forks with DIFFERENT personas. (4) **`/asyncthink:review-pr` rebuilt as a panel** — 4 parallel claude forks (security/simplify/test-coverage/correctness) against the branch diff, aggregated security-first. v2.6.0: Settings layer + Subagent registry. (1) **Settings**: `~/.config/asyncthink/settings.toml` (TOML, user scope) + `.claude/asyncthink.local.md` (YAML frontmatter, project scope) with layered resolution chain (per-call > skill > project > user > built-in). Built-in default `defaults.adapter = "claude"`. (2) **Subagent registry**: persistent JSON files at `~/.local/share/asyncthink/subagents/<id>.json`; built-in `asyncthink-delegate` bootstrapped on first run. (3) **Claude adapter subscription-path subagent injection**: on `detectAuthPath('claude') === 'subscription'` the adapter spawns `claude --print --agents '<inline-json>' --agent <id>`, so delegate work runs as a dedicated persona separate from the parent Claude Code session. New `claude.subagent.spawn` audit event. (4) **Tool surface**: `asyncthink_config` gains eight new actions — `get_settings`, `set_setting`, `unset_setting`, `subagent_list/get/create/update/delete`. (5) **Removed**: `ASYNCTHINK_DEFAULT_ADAPTER` env var (one-week-old stop-gap); migrate via `asyncthink_config({action:"set_setting", key:"defaults.adapter", value:"gemini"})`. v2.5.0: Two v2.4 follow-ups: (1) **codex MCP-allowlist enforcement** (F3-D.2 close) — codex spawned with `CODEX_HOME=<slim-overlay>` per AsyncThink threadId; overlay's `config.toml` contains only the allowlisted `[mcp_servers.<name>]` tables. Default allowlist `[sequentialthinking, context7]` matches gemini; skill/caller additive merge via `mcpServers: [...]`. Hardlinks `auth.json` from real `~/.codex` so token refresh propagates. Reaped on every thread close + idle sweep. New `codex.overlay.materialize` audit event. (2) **Supply-chain IOC monitor** — `npm run audit:supply-chain` walks the lockfile against a committed JSON of 2,345 known-bad `name@version` tuples (Cobenian + Wiz, refreshed weekly via GitHub Action), plus Bun-bootstrapper filename glob, plus install-script presence audit (warning). Chained into pre-push gate. Catches Shai-Hulud / Mini Shai-Hulud / axios / node-ipc / Bitwarden / SAP compromises the moment the IOC list is refreshed, independent of `npm audit`'s GHSA lag. v2.4.0: security-hardening cycle in response to the 2025-2026 npm supply-chain wave — upgraded `@modelcontextprotocol/sdk` to ≥1.26.0 (closes CVE-2026-25536), dropped `chalk`/`dotenv`/`shx`, committed `package-lock.json`, switched `reinstall.sh` to `npm ci --omit=dev --ignore-scripts`. 189 packages, 0 vulnerabilities. v2.3.3: flexibility fix-pack — `authPath` override + `bypassRateLimit` + async-delegate thread close. v2.3.2: reinstall-script fixes. v2.3.1: PR #5 review fix-pack. v2.3.0: gemini parser hardening (F3), typed AdapterError envelope, auth pre-flight, auth-path-aware rate-limit advisories, curated MCP-server allowlist, cancellation post-exit confirmation. v2.0.0 onwards is the modular refactor; v1.1.9 git tag remains the historical pin for v1 behavior.

## Quick install / update

```sh
# First time (from this repo):
git clone https://github.com/mintmcqueen/asyncthink.git
cd asyncthink
claude plugin marketplace add .
claude plugin install asyncthink@asyncthink-local
# Then: restart Claude Code. /clear is insufficient.

# Updating after a version bump:
npm run reinstall          # in server/; verifies version triple, runs marketplace update + install, prints restart reminder
```

**Important footgun:** `claude plugin install` clones from `origin/develop` on GitHub. Unpushed local commits are invisible to install. Use `claude --plugin-dir <repo>` for the source-loop alternative during development. See README.md "Installing & updating" for the full runbook.

## Purpose

AsyncThink is an MCP server for sequential thinking with optional parallel forks to subordinate model CLIs. The central orchestrator (Claude Code, in practice) reasons step-by-step and can convene a "council" of independent perspectives — each fork is a fire-and-forget invocation of a different subordinate adapter (claude, gemini, codex). It also exposes a `delegate` tool for single-subordinate threaded conversations and (v2.2) a four-verb async tasks tool surface for long-running work that survives request boundaries. All subordinates are **read-only**: they may navigate files but never edit, exec, or write.

## Tools (ten)

| Tool | Purpose |
| --- | --- |
| `asyncthink` | Sequential thinking + parallel forks (council). Auto-closes chain on `nextThoughtNeeded:false`. v2.2: `forks[].async` for detached fire-and-forget. v2.3: `forks[].mcpServers` + `forks[].preflight`. |
| `delegate` | Open or continue a single-subordinate thread. Inline `close: true` for one-round-trip. v2.2: `async`, `idempotencyKey`, `ttlMs`, `credentials`. v2.3: `mcpServers` (additive allowlist), `preflight: 'auth'` (opt-in local probe). v2.3.3: `authPath` (override advisory), `bypassRateLimit` (opt out of pre-flight refuse). |
| `delegate_close` | Close a thread. Idempotent. |
| `delegate_close_all` | End-of-session safety net. |
| `delegate_list_threads` | Introspection: open threads, adapter, idle time. |
| `asyncthink_config` | View config: adapters (with tierLimits, authPath, mcp), skills (with pinsModel/pinIsCurrent), tasks. v2.2 actions: `list_tasks`, `cancel_task`. v2.3: optional `verify: true` arg runs local auth probes. |
| `tasks_get` (v2.2) | Snapshot a task's status. Idempotent. |
| `tasks_list` (v2.2) | Cursor-paginated list of tasks; principal-bound. |
| `tasks_cancel` (v2.2) | Best-effort cancel (SIGTERM + state flip). Idempotent. |
| `tasks_result` (v2.2) | Block until terminal; return the underlying response. |

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ MCP Tool Layer                                                     │  stable v1→v3
│   asyncthink, delegate{,_close,_close_all,_list_threads},          │
│   asyncthink_config, tasks_{get,list,cancel,result}                │
├────────────────────────────────────────────────────────────────────┤
│ Orchestration                                                      │  stable
│   AsyncThinkingServer  Council  Delegate  TaskExecutor (v2.2)      │
├────────────────────────────────────────────────────────────────────┤
│ Adapters                                                           │  stable interface,
│   impl/{claude,gemini,codex}.ts (TS impls)                         │  TS impl per CLI
│   manifests/{claude,gemini,codex}.json (metadata + tierLimits v2.2)│
├────────────────────────────────────────────────────────────────────┤
│ Storage                                                            │  swap point for v3
│   ThreadStore (JsonlThreadStore)                                   │
│   TaskStore   (FsTaskStore — idempotency index + TTL sweep v2.2)   │
│   AuditLog    (JsonlAuditLog — task.* events + 90d rotation v2.2)  │
│   SkillRegistry (FsSkillRegistry — credentials, pinsModel v2.2)    │
├────────────────────────────────────────────────────────────────────┤
│ Executor                                                           │  swap point for v3
│   LocalSubprocessExecutor (cancel(taskId) v2.2)                    │
│   LocalInProcessTaskExecutor (v2.2 — wraps subprocess + state)     │
└────────────────────────────────────────────────────────────────────┘
```

Storage and Executor are the swap points for the eventual hosted/SOC2/Vertex v3 — the tool surface and orchestration code stay identical when the cloud port lands. The `TaskExecutor` interface (`server/src/core/taskExecutor.ts`) is v2.2's principal v3 swap point: `LocalInProcessTaskExecutor` ships in v2.2; v3 will substitute `RemoteCompanionTaskExecutor` (OAuth-authed companion daemon) without touching tools/orchestration.

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
intelligence: high            # optional — high|med|low (preferred over model)
files_glob: src/**/*.ts       # optional
model: gpt-5.5                # optional escape hatch — pin a raw model id
timeout_ms: 240000            # optional
credentials: default          # v2.2 — wire-stub for v3 per-delegate creds (R-CRED-D.1)
auth_path: subscription       # v2.3.3 — override the rate-limit advisory path lookup
bypass_rate_limit: false      # v2.3.3 — when true, skip the pre-flight refuse for this skill
---
```

**Model selection — intelligence is a within-adapter ordinal, not a cross-adapter SLA.** Adapters expose three tiers per their manifest. Tiers are ordinals within a single adapter — they do not promise that "claude high" is comparable to "gemini high" on cost, latency, or capability. Read the per-tier facts in `tierLimits` for the concrete numbers.

| Tier | claude | gemini | codex |
| --- | --- | --- | --- |
| `high` | claude-sonnet-4-6 † | gemini-3.1-pro-preview | gpt-5.5 |
| `med` | claude-sonnet-4-6 † | gemini-2.5-flash | gpt-5-codex |
| `low` | claude-haiku-4-5-20251001 | gemini-2.5-flash-lite | gpt-5-mini |

† Anthropic's 30k input-tokens/minute org cap on `claude-opus-4-7` made opus unreliable for non-trivial council forks (v2.1.1 finding). Claude's `high` and `med` both map to sonnet-4-6 in v2.2; users with higher opus rate limits can pin the raw model id via `model: "claude-opus-4-7"` or edit `server/src/adapters/manifests/claude.json`.

**`tierLimits` (v2.2, R6a-D.1)** — each manifest now carries optional per-tier facts surfaced via `asyncthink_config({action:"list_adapters"})`:

```json
"tierLimits": {
  "high": { "maxContext": 200000, "rateLimitClass": "standard", "expectedLatencyMsP50": 12000 },
  "med":  { "maxContext": 200000, "rateLimitClass": "standard", "expectedLatencyMsP50": 12000 },
  "low":  { "maxContext": 200000, "rateLimitClass": "standard", "expectedLatencyMsP50": 4000  }
}
```

`maxContext` is **load-bearing** (R6a-D.2): `LocalInProcessTaskExecutor.start()` runs a pre-flight token check (~4 chars/token heuristic over `prompt + files`) and rejects with `ContextLimitExceededError` before spawning the subprocess. `rateLimitClass` and `expectedLatencyMsP50` are advisory and surface in error envelopes / introspection.

**Conflict detection (v2.1.1, F1):** if a caller or skill supplies BOTH `intelligence` AND `model` AND they resolve to different ids, the adapter throws `TierModelConflictError` rather than silently honoring the raw `model`. Skill frontmatter that pins both fields with conflicting values is reported as a stderr warning at startup via the `conflictValidator`.

Callers pin to **tiers**, not model ids: `delegate({adapter: "gemini", intelligence: "high", prompt: "..."})`. Skills and tool calls stay stable as model names evolve — only the manifest's `tiers` map needs updating.

Resolution precedence (highest → lowest):
1. Caller's raw `model` (escape hatch — wins over everything)
2. Caller's `intelligence` tier
3. Skill's frontmatter `intelligence`
4. Adapter's `defaultTier` (currently `med` for all built-ins)

### Skill-pinning policy (v2.2, R6b-D)

Skills may pin a raw `model:` in frontmatter. Two cases:

- **`pinIsCurrent: true`** — pinned id is in the adapter's current `tiers` map. Pass through verbatim, no warning.
- **`pinIsCurrent: false`** — pinned id has been retired from the manifest. At dispatch time the SkillResolver substitutes the adapter's `defaultTier` model, emits a stderr warning, and records a `model.substitute` audit event with `from`, `to`, `tier`, and `reason: "skill-pin-stale"`. The skill keeps working through model churn instead of failing loudly.

The substitution is **opt-in** at the resolver layer (driven by passing a `ManifestRegistry` into `resolveSkill`'s context). Direct adapter calls with raw `model` overrides do NOT trigger substitution — escape-hatch overrides are preserved verbatim. F1 conflict-detect still wins: a skill with both `intelligence: low` and `model: <not-low-tier>` is still rejected at registry-load by `conflictValidator`.

`asyncthink_config({action:"list_skills"})` surfaces `pinsModel` (raw id or null) and `pinIsCurrent` (true|false|undefined) per skill (R6b-D.3). `undefined` means the registry was loaded without manifest awareness and the field could not be derived.

The body of the markdown file is the **prompt prefix** — the system context that orients the subordinate before the caller's per-invocation prompt.

**Resolution rules** (`server/src/skills/resolver.ts`):
- Adapter from frontmatter is authoritative. If the caller passes a different adapter, the call errors (`SkillAdapterMismatchError`).
- Caller's `model` and `timeoutMs` override the skill's defaults.
- `prompt = skill.promptBody + "\n\n---\n\n" + caller.prompt`.

**Built-in skills (Phase 4):**
- `code-review` (codex) — adversarial review focused on bugs, security, concurrency, contract clarity. Globs to source extensions.
- `architecture-critique` (gemini) — independent design critique of coupling, failure modes, scaling pressure points, evolution paths. Globs to docs and architecture markdown.
- `test-design` (claude) — coverage analysis focused on intended behavior, weak assertions, missing acceptance tests at system boundaries.

**Slash commands:**
- `/asyncthink:critique` — wraps `delegate` with the architecture-critique skill.
- `/asyncthink:review-pr` — wraps `delegate` with the code-review skill against the current branch's diff vs the integration branch.
- `/asyncthink:delegate-async` (v2.2) — fire-and-forget delegate that returns a `taskId` immediately.
- `/asyncthink:tasks` (v2.2) — list async tasks with status, or detail one by id.

## Background Jobs (v2.2)

v2.2 adds support for adapter invocations that survive the request boundary. The architecture follows the **MCP Tasks primitive** (SEP-1686, 2025-11-25 spec, R2-D.1) and ships an in-process executor that's swappable for v3 cloud companion.

### Tool surface

```
delegate({async: true, prompt, ...})  → {taskId, status: "working", reminder}
tasks_get({taskId})                   → state snapshot (non-blocking)
tasks_list({cursor?, limit?})         → paginated list, principal-bound
tasks_cancel({taskId})                → best-effort SIGTERM + state flip
tasks_result({taskId})                → blocks until terminal, returns full state
```

`asyncthink_config` adds `list_tasks` and `cancel_task` action aliases (R4-D.2). The `asyncthink` tool's `forks[]` accepts `async: true` to spawn detached forks that survive chain-end (R-DUR-D.1).

### Lifecycle states

The `LocalInProcessTaskExecutor` uses MCP Tasks spec statuses (`server/src/core/taskExecutor.ts`):

```
working → completed
working → failed
working → cancelled
working → input_required (reserved; not emitted in v2.2)
```

Terminal states are sticky — a cancelled task stays cancelled even if its underlying subprocess finishes after the kill signal arrived. (`MUST remain cancelled` per spec.) `tasks_get` and `tasks_result` against terminal tasks return the same state.

### Idempotency (R-DUR-D.3)

Callers may pass `idempotencyKey` on `delegate({async:true})` (or via `_meta["io.asyncthink/idempotency-key"]` on the wire). Repeat calls with the same `(idempotencyKey, principal)` while the original is non-terminal return the original `taskId` instead of spawning a duplicate. After the original reaches a terminal state, the same key is free to spawn a fresh task — there is no transcript replay.

### TTL retention (R-DUR-D.4)

The sweeper runs on every tool call (rate-limited to once per 30s) and reaps tasks per category:

| Status | TTL |
| --- | --- |
| `working` / `input_required` | 60 minutes |
| `completed` | 60 minutes |
| `failed` | 10 minutes |
| `cancelled` | 5 minutes |

Caller-supplied `ttlMs` is clamped to `[60s, 60m]`. Reaped tasks emit a `task.expire` audit event and are deleted from the FsTaskStore mirror.

### Cancellation (R-DUR-D.5 + v2.3 R5)

`tasks_cancel({taskId})` flips the state to `cancelled` immediately and signals SIGTERM to the registered subprocess group via `LocalSubprocessExecutor.cancel(taskId)`. SIGKILL follows after a 1s grace. Cancellation is best-effort: the underlying subprocess may take milliseconds to actually exit, but the protocol-visible state flips synchronously. Cancelling a task that hasn't yet spawned (cancellation arrived between `start()` and the subprocess `spawn`) is queued — applied as soon as the process exists.

**v2.3 internal refinement (R5-D.2 … R5-D.5):** wire-level status is `cancelled` immediately (MCP Tasks spec forbids a `cancelling` value). Internally, the executor tracks an in-memory `Set<string>` of taskIds whose subprocess hasn't confirmed exit. The sweeper (`cleanupStale`) honors this set and skips deletion until the `proc.on('close')` listener fires — at which point a `task.terminated` audit event is emitted with `terminatedAt`, optional `signal`, optional `exitCode`. The 5-minute `cancelled` TTL is preserved.

**30-minute hard ceiling (R5-D.4):** if a subprocess truly hangs and never exits, the sweeper force-deletes the row past `CANCELLING_HARD_CEILING_MS = 30 * 60_000` and emits `task.terminated` with `signal: 'orphaned'`. Bounds the in-memory protection so a permanently-wedged subprocess can't pin the FsTaskStore mirror indefinitely.

**Multi-tenant gap (v3):** v2.3 is single-tenant local; an unreaped subprocess is bounded by the user's own machine. v3 will add a `waitpid` watchdog with bounded reap deadline before declaring the slot freed — the `task.terminated` audit event in v2.3 seeds the observability that v3 watchdog needs.

### Ownership / principal binding (R-DUR-D.2)

Every `TaskState` carries a `principal` field. v2.2 single-tenant local: `principal: null` for everything. v3 will populate from the OAuth subject claim on inbound requests; cross-principal `tasks_get` / `tasks_cancel` already throw `TaskOwnerMismatchError` so the contract is wire-stable.

### v3 trajectory

`server/src/core/taskExecutor.ts` defines the `TaskExecutor` interface. v2.2 ships `LocalInProcessTaskExecutor`. v3 will ship `RemoteCompanionTaskExecutor` — same interface, but execution dispatches via OAuth-authenticated companion daemon. The tool surface, lifecycle states, idempotency semantics, TTL policy, and audit event shapes all stay identical.

## Adapter Failure Diagnostics (v2.3)

Adapter failures surface as a typed `AdapterError` envelope (see `server/src/core/adapterError.ts`) instead of opaque stdout/stderr strings. Kinds:

| `kind` | Trigger | Where to look |
| --- | --- | --- |
| `auth` | claude `Invalid API key`/`Please run /login`; gemini stderr `GEMINI_API_KEY environment variable` or `API_KEY_INVALID`; codex NDJSON `401 Unauthorized`/`Missing bearer` | Run `claude /login`, set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY`, or `codex login` |
| `rate-limit` | claude `Rate limit reached ... 50,000 tokens per minute`; gemini `RESOURCE_EXHAUSTED`; codex NDJSON `429`/`Too Many Requests` | Wait per advisory, pin a different tier, or upgrade provider quota |
| `context` | Pre-flight prompt+files token estimate exceeds tier `maxContext` | Smaller prompt or higher-context tier |
| `network` | `ECONNRESET`/`ENOTFOUND`/`failed to connect` (no auth context) | Check internet + provider status page |
| `binary-missing` | `ENOENT` on adapter spawn | Install the CLI; ensure on PATH |
| `timeout` | Subprocess exit 124 + executor's `[timeout after Xms]` marker | Reduce prompt or raise `timeoutMs` |
| `silent-failure` | Adapter exited 0 but parser yielded only known noise (e.g. gemini's `MCP issues detected. Run /mcp list for status.`) | Check `~/.gemini/settings.json` for unhealthy MCP servers; F3-D.3 throws this typed kind so the orchestrator gets a structured failure instead of empty `output` |
| `unknown` | Catch-all; raw output preserved on `state.raw` | Inspect via `tasks_get` for the raw envelope |

**Where the envelope lives:**
- TaskState gets `errorKind` + `errorActionable` fields (R-DIAG-D.1) — persisted to disk in `~/.local/share/asyncthink/tasks/<id>/state.json`.
- Council fork output in the asyncthink-tool response carries the envelope when the fork failed (R-DIAG-D.5).
- `tasks_get` / `tasks_result` reveal the full envelope to clients.

**Pre-flight (R-DIAG-D.3, R-DIAG-D.4):**
- `asyncthink_config({action:"list_adapters", verify:true})` runs cheap LOCAL probes (env-var + binary presence; never paid API calls). Result fields per adapter: `authPath` (which path the env probe selected), `authVerified` (`true`|`false`|`'env-present-not-validated'`|`'not-checked'`).
- `delegate`/`asyncthink fork` accepts `preflight: 'auth'` — runs the same probe before allocating a task row. Default OFF (back-compat). Skills can pin via frontmatter (`preflight: auth`).

## MCP-server allowlist for adapter spawns (v2.3 F3-D.2)

Gemini and codex are spawned with a curated MCP-server allowlist instead of inheriting the user's full `~/.gemini/settings.json` (or codex equivalent). This was added after the v2.2 playtest found a 60s hang triggered by an unhealthy user-MCP server.

**Default:** `["sequentialthinking", "context7"]` for both gemini and codex (see `mcp.allowlist` in `server/src/adapters/manifests/{gemini,codex}.json`). Claude is included for consistency; claude's MCP system uses a separate `~/.claude.json` config that the adapter doesn't currently filter.

**Extending:**
- Per-skill: add `mcp_servers: [foo, bar]` to skill frontmatter — merged additively over the default.
- Per-call: pass `mcpServers: ["foo", "bar"]` to `delegate` or `forks[]`.
- The merge is union-only — skills/callers MAY extend but MAY NOT remove a default server. This keeps the audit story one-way ("which servers did this fork have access to?").

**Per-adapter flag mapping:**
- gemini: `--allowed-mcp-server-names <comma-list>` (verified against gemini-cli v0.39.x).
- codex: **enforced as of v2.5.0** via a slim `$CODEX_HOME` overlay (codex v0.125 has no flag-level allowlist; the apparent shortcut `-c 'mcp_servers={}'` is broken upstream per [openai/codex#16045](https://github.com/openai/codex/issues/16045)). On every spawn the codex adapter materializes a per-thread overlay at `tmpdir()/asyncthink/codex-overlay/<sanitized-threadId>/` containing `config.toml` with only the allowlisted `[mcp_servers.<name>]` tables, then spawns codex with `CODEX_HOME=<overlay>`. Hardlinks `auth.json` from the user's real `~/.codex` so token refresh propagates back. Reaped on every thread close + idle sweep. The overlay is per-thread (not per-spawn) so codex `resumeStrategy: 'native'` retains `sessions/<id>.jsonl` continuity for multi-turn resume. Emits a `codex.overlay.materialize` audit event with the allowlist + source-config-present + auth-linked flags. Implementation: `server/src/adapters/codexOverlay.ts`.

## Auth-path-aware rate-limit advisories (v2.3 R6a-D.4)

Each adapter can reach its model provider through multiple auth paths with materially different rate-limit semantics:

| Adapter | Auth paths supported |
| --- | --- |
| claude | `subscription` (default, Claude Code session); `api` (`ANTHROPIC_API_KEY`); `vertex` (`CLAUDE_CODE_USE_VERTEX=1`); `bedrock` (`CLAUDE_CODE_USE_BEDROCK=1`) |
| gemini | `ai-studio` (default; `GEMINI_API_KEY` or `GOOGLE_API_KEY`); `vertex` (`GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT`) |
| codex | `subscription` (default; `codex login`); `api` (`OPENAI_API_KEY`); `azure` (Azure OpenAI env config) |

`detectAuthPath(adapter, env)` (in `server/src/adapters/authPath.ts`) probes the env to pick a path. The selected path keys into `tierLimits.<tier>.rateLimit.byAuthPath` for the right advisory. Example: a user with `ANTHROPIC_API_KEY` set on claude `low` tier sees the Tier-1 ITPM cap of 50,000 input-tokens/minute (the playtest's 429); a Vertex user sees a `standard` advisory because their cap is governed by GCP project quotas (not Anthropic's org-wide cap).

**Pre-flight refuse (R6a-D.5):** at fork-spawn, the executor computes `forks_allowed_per_minute = floor(cap.tokens / estimatedPromptTokens / (cap.windowSec / 60))`. If the council already burned that budget, the over-limit fork is skipped with a typed `kind: 'rate-limit'` AdapterError envelope and the council continues with the remaining forks. The advisory was informational in v2.2; it is enforcement in v2.3.

**Caller flexibility levers (v2.3.3):**
- `authPath: <string>` on `delegate`, `asyncthink` forks, or skill frontmatter (`auth_path:`) overrides the env-derived path used to look up `byAuthPath[...]`. Use when the env probe misclassifies the real route (e.g. `ANTHROPIC_API_KEY` set as fallback but the CLI actually uses subscription auth). Affects ONLY the advisory lookup — actual adapter spawn argv/env routing is unchanged.
- `bypassRateLimit: true` on the same surfaces (skill frontmatter: `bypass_rate_limit:`) opts out of the pre-flight refuse entirely. Emits a `task.bypass_rate_limit` audit event with `taskId`, `adapter`, `authPath?`, `reason` so post-hoc 429s can be correlated with bypass intent. Use sparingly — the gate exists because un-gated 429s burn the entire chain rather than just the over-limit fork.

**Staleness tripwire (R6a-D.7):** `list_adapters` walks every cell's `rateLimit.lastVerified` and emits a stderr warning for cells older than 90 days. Bootstrap value is `2026-04-29` for all v2.3 cells.

## Per-Delegate Credentials (v3 contract; v2.2 wire-only)

`delegate`, `asyncthink` forks, and skill frontmatter accept an optional `credentials: <profile-name>` field (R-CRED-D.1). v2.2 is wire-only: the field is parsed and forwarded through resolution, but only the literal value `"default"` (or absent/empty) is accepted at dispatch time. Any other profile name is rejected with `CredentialsNotSupportedError` pointing at v3 (R-CRED-D.2). The `cred.use` audit event kind is reserved for v3 (R-CRED-D.4) — not emitted in v2.2.

v3 will ship two profile resolvers:
- `StaticEnvProfileResolver` — reads named env-var bags from a config file (`~/.config/asyncthink/profiles/<name>.env`).
- `CloudOAuthProfileResolver` — exchanges the request's OAuth token for provider-specific credentials.

This contract lets users plan multi-tenant or per-task credential isolation without taking a runtime dependency on it today.

## Supply-chain IOC monitor (v2.5.0)

`npm run audit:supply-chain` walks `server/package-lock.json` against a committed list of 2,345 known-compromised `name@version` tuples (`server/scripts/ioc/compromised-packages.json`). Closes the lag between "compromised version published to npm" and "advisory entered in the GitHub DB that `npm audit` queries" — a window that, in the 2025-2026 attack wave, has run hours to days.

**Detection layers:**
1. **Exact `name@version` match** against the IOC Map → failure (exit 1).
2. **Bun-bootstrapper filename glob** over `node_modules` (`setup_bun.js`, `bun_environment.js`, `bw_setup.js` — IOCs from Shai-Hulud 2.0, Bitwarden CLI, SAP cap-js campaigns) → failure (exit 1).
3. **Install-lifecycle script presence** in installed `package.json` files → warning (not failure; `--ignore-scripts` defang already neutralizes execution, but the diary entry is useful).

**Sources** (`server/scripts/ioc/SOURCES.md`):
- `Cobenian/shai-hulud-detect` (MIT) — 2,112 entries; aggregates Sept-2025 Qix chalk/debug + Shai-Hulud + Shai-Hulud 2.0 + axios + node-ipc + Bitwarden + SAP cap-js + Mini Shai-Hulud TanStack.
- `wiz-sec-public/wiz-research-iocs` Shai-Hulud 2.0 CSV — 795 entries.
- Optional local enrichment: Aikido feed (~125k entries, MALWARE-only) via `npm run audit:supply-chain:refresh -- --with-aikido`. Written to `scripts/ioc/aikido-enrichment.json` (gitignored). Audit picks it up automatically when present.

**Refresh cadence:** weekly Monday 03:00 UTC via `.github/workflows/refresh-ioc.yml` which runs the refresh script and PRs the diff. Pre-push hook reads ONLY the committed file — never hits the network. On-incident: `npm run audit:supply-chain:refresh` manually.

**Pre-push integration:** `git config git-guard.test-cmd "(cd server && npm run audit:runtime && npm run audit:supply-chain && npm test --silent)"`. The supply-chain gate runs after `npm audit` (which covers GHSA-listed CVEs) and before tests.

## Settings layer (v2.6.0)

Two file-backed layers + built-in defaults. Edit by hand or via `asyncthink_config({action: "set_setting", key, value, scope})`.

```
Resolution chain (highest precedence first):
  1. Per-call arg          delegate({adapter: 'gemini'})
  2. Skill frontmatter     (skill pins adapter)
  3. Project settings      .claude/asyncthink.local.md in cwd/ancestors (YAML frontmatter)
  4. User settings         ~/.config/asyncthink/settings.toml (TOML)
  5. Built-in default      defaults.adapter = "claude", defaults.subagent = "asyncthink-delegate"
```

**Tool actions** (via `asyncthink_config`):
- `get_settings` — returns `{effective, layers}` so you can see WHICH layer set each value.
- `set_setting` — `{key, value, scope: 'user' | 'project'}`. Persists + invalidates cache.
- `unset_setting` — `{key, scope}`. Reverts that scope to lower layer.

**Whitelisted keys:**
- `defaults.adapter` — `claude` | `gemini` | `codex`.
- `defaults.subagent` — id of a Subagent in the registry; consumed by the claude adapter for every spawn (when injection enabled).
- `defaults.injectSubagent` (v2.8.0) — boolean, default `true`. When `false`, claude adapter skips subagent injection globally. Explicit opt-out replaces the v2.6/v2.7 auth-path heuristic.

**Example user file** (`~/.config/asyncthink/settings.toml`):
```toml
[defaults]
adapter = "gemini"
subagent = "asyncthink-delegate"
```

**Example project file** (`.claude/asyncthink.local.md`):
```markdown
---
defaults:
  adapter: "codex"
---
```

## Subagent registry (v2.6.0)

Persistent personas for the claude adapter's subscription-path spawn. Stored as JSON files at `~/.local/share/asyncthink/subagents/<sanitized-id>.json` — same filesystem-backed pattern as ThreadStore/TaskStore.

**Built-ins (v2.6 + v2.7):**

| id | Purpose | Tools |
| --- | --- | --- |
| `asyncthink-delegate` | Default delegate persona (v2.6) | `Read, Grep, Glob` |
| `security-review` | Adversarial OWASP-focused review (v2.7) | `Read, Grep, Glob, WebSearch` |
| `simplify-review` | Anti-bloat / clarity (v2.7) | `Read, Grep, Glob` |
| `test-coverage-review` | Behavioral coverage gaps (v2.7) | `Read, Grep, Glob` |
| `correctness-review` | Logic + concurrency + edges (v2.7) | `Read, Grep, Glob` |

All five bootstrap on first server boot via `bootstrapBuiltins(BUILTIN_SUBAGENTS)`. User customizations win on subsequent boots (idempotent — only creates missing built-ins). The four review-panel subagents are spawned together by `/asyncthink:review-pr` for multi-perspective code review.

**Per-call subagent override (v2.7):** `delegate({adapter: 'claude', subagent: '<id>', ...})` and `asyncthink({forks: [{subagent: '<id>'}, ...]})` accept a per-call/per-fork subagent. Skill frontmatter accepts `subagent:` for default binding. Precedence: caller > skill > settings `defaults.subagent` > built-in `asyncthink-delegate`.

**Tool actions** (via `asyncthink_config`):
- `subagent_list` — all subagents.
- `subagent_get` — `{subagentId}` → full definition.
- `subagent_create` — `{subagent: {name, description, prompt, tools?, model?}}` — id is derived from `slugifyName(name)`.
- `subagent_update` — `{subagentId, subagent: <patch>}` — any subset.
- `subagent_delete` — `{subagentId}`.

**Spawn mechanism (v2.8.0):** the claude adapter passes `--agents '<inline-json>' --agent <id>` to `claude --print` on EVERY spawn (when `defaults.injectSubagent !== false`). The agent JSON shape (from `claude --help`):
```json
{ "<id>": { "description": "...", "prompt": "...", "tools": [...], "model": "..." } }
```
v2.8.0 lifted the v2.6/v2.7 auth-path gate (`detectAuthPath === 'subscription'` only). The `--agents` flag applies at the claude-CLI session-config layer pre-model-call, so injection works identically across subscription / api / vertex / bedrock paths. Live-validated in `__tests__/live/subagentSpawn.live.test.ts` on api path. Disable globally via `asyncthink_config({action: "set_setting", key: "defaults.injectSubagent", value: false})`.

## Audit log

`JsonlAuditLog` (`server/src/stores/jsonlAuditLog.ts`) records every adapter invocation, thread lifecycle, task lifecycle, and model-substitution event to `~/.local/share/asyncthink/audit.jsonl`. Each line is a JSON object: `{ts, pid, event}`. Recognized `event.kind` values:

| `kind` | Fields | Origin |
| --- | --- | --- |
| `invoke` | `adapter, durationMs, threadId?, error?` | every adapter call |
| `thread.open` / `thread.close` | `threadId, adapter` | Delegate / Council lifecycle |
| `task.create` (v2.2) | `taskId, adapter, detached, principal, idempotencyKey?` | TaskExecutor.start |
| `task.complete` / `task.fail` (v2.2) | `taskId, adapter, durationMs, error?` | TaskExecutor terminal transition |
| `task.cancel` / `task.expire` (v2.2) | `taskId, adapter, reason?` | tasks_cancel / sweeper |
| `task.terminated` (v2.3) | `taskId, adapter, terminatedAt, signal?, exitCode?` | Paired 1:1 with `task.cancel`; emitted from the subprocess `close` listener (or immediately if no subprocess existed). Reserves `signal: 'orphaned'` for v3 watchdog. |
| `task.bypass_rate_limit` (v2.3.3) | `taskId, adapter, authPath?, reason?` | Caller passed `bypassRateLimit: true` on `delegate`/`asyncthink` fork (or skill frontmatter `bypass_rate_limit: true`). Reasons: `caller-opt-out` (async), `sync-delegate-opt-out`, `council-fork-opt-out`. |
| `codex.overlay.materialize` (v2.5.0) | `threadId, overlayPath, allowedServers[], emittedServers, sourceConfigPresent, authLinked` | Emitted on every codex spawn that uses the `$CODEX_HOME` overlay (F3-D.2). Answers "which MCP servers did this codex subprocess have access to?". |
| `claude.subagent.spawn` (v2.6.0) | `subagentId, subagentName, authPath, model` | Emitted when the claude adapter injects a subagent via `--agents`/`--agent` on the subscription auth path. Answers "which persona ran this delegate spawn?". |
| `model.substitute` (v2.2) | `adapter, from, to, tier, reason` | SkillResolver R6b-D.2 substitution |
| `cred.use` (reserved) | (deferred to v3 per R-CRED-D.4) | — |

**Rotation (v2.2, R1-D.1)** — on startup and once per 24h, the log is rotated to `audit.jsonl.YYYY-MM-DD` if its oldest entry is more than a day old. Archives older than 90 days are pruned. Built from day 1 even though v1 isn't SOC2-attested — capturing logs early means real audit data is available when the v3 cloud port pursues SOC2 Type 1. Failure-isolated: write errors log to stderr but do not break tool calls.

## Council (asyncthink forks)

Each `asyncthink` chain has a `chainThreadId`. Forks within a thought are children threads named `<chainThreadId>::<forkId>`. Tasks in `FsTaskStore` use the same scoping so concurrent chains do not collide.

Forks are fire-and-forget: `Council.fork()` registers the in-flight promise and returns immediately. The caller collects results later via `waitFor` or `readResearch`, or lets the final thought (`nextThoughtNeeded:false`) auto-collect everything via `Council.endChain()`. End-of-chain:
1. Awaits any remaining **non-detached** in-flight forks, up to a per-call timeout (default 180s) (R1-D.2).
2. Closes child threads for non-detached forks.
3. Prunes the chain's non-detached tasks from `FsTaskStore`.
4. Returns aggregated results to the tool handler for inclusion in the response.

**Detached forks (v2.2, R-DUR-D.1)** — `forks[].async: true` spawns the fork through `LocalInProcessTaskExecutor` instead of `Council`. Detached forks bypass chain-end cleanup entirely: they survive past the final thought, are queryable via `tasks_get` / `tasks_result`, and are reaped only by category TTL (working/completed 60m). Their child threads also survive chain-end. Use detached forks when the orchestrator wants research that outlives the conversation turn — e.g. firing a long codex review at the start of a planning chain and harvesting it later. The asyncthink response surfaces detached task ids in `output.detachedTasks` so the caller has the handles to follow up.

## Plugin distribution

The repo is its own single-plugin marketplace. `.claude-plugin/marketplace.json` declares one plugin (`asyncthink`) with `source: { source: "url", url: "https://github.com/mintmcqueen/asyncthink.git", branch: "develop" }`. Install path:

```sh
claude plugin marketplace add /path/to/asyncthink   # registers as a directory marketplace
claude plugin install asyncthink@asyncthink-local
```

Claude Code's plugin manager clones the github URL on install (HTTPS, no SSH keys needed) and copies the snapshot into `~/.claude/plugins/cache/asyncthink-local/asyncthink/<sha>/`. The manager does not run `npm install` or build steps, so **`server/dist/` is committed** (collaborative-canvas does the same with its prebuilt `dist/bundle.cjs`). Root-level `/dist/` stays gitignored — only `server/dist/` is tracked.

GitHub default branch is `develop` so plugin installs pull v2 code. Cutting `develop → main` happens at major releases via merge-commit per branch-rotation methodology.

For dev iteration without reinstall, start a session with `claude --plugin-dir /path/to/asyncthink` — the plugin loads directly from the source tree on each restart.

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
├── tasks/<sanitizedTaskId>/state.json          # task mirror; v2.2 schema includes
│                                               # detached, principal, idempotencyKey,
│                                               # taskTtlMs, lastUpdatedAt
├── audit.jsonl                                 # active log (rotates daily v2.2)
└── audit.jsonl.YYYY-MM-DD                      # daily archives, 90-day retention (v2.2)
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
XDG_CONFIG_HOME=/custom/path   # override XDG config root (settings.toml location)
RUN_LIVE=1                     # opt into live test suites
```

(`ASYNCTHINK_DEFAULT_ADAPTER` was removed in v2.6.0; use the settings layer instead.)

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
