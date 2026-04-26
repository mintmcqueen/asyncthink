# Changelog

All notable changes to AsyncThink are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-04-26

Ground-up refactor: subordinate-CLI adapter framework, threaded delegate tool, parallel council, skills, audit log. v1 reference code deleted; `@google/genai` dependency dropped. See per-phase entries below for implementation detail.

The v2 refactor is underway on `developer/jb_a`. v1 source is preserved at `server/src.v1/` for reference and will be deleted in Phase 3. See `/Users/jb/.claude/plans/quiet-cooking-feigenbaum.md` for the full plan.

### Phase 0 — scaffold (this commit)

- Restructured repo as a Claude Code plugin: `.claude-plugin/plugin.json`, `.mcp.json`, plus `commands/`, `skills/`, `agents/`, `hooks/` directories at the root.
- Relocated v1 server code to `server/src.v1/` and v1 tests to `server/__tests__.v1/`.
- Added `server/src/core/` with eight interface-only modules: `adapter.ts`, `executor.ts`, `taskStore.ts`, `threadStore.ts`, `auditLog.ts`, `skillRegistry.ts`, `manifests.ts`, `config.ts`.
- Added `server/src/tools/` with stub registrations for `asyncthink`, `delegate`, `delegate_close`, `delegate_close_all`, `delegate_list_threads`, `asyncthink_config`. Every stub returns a `v2 in progress` notice; pin v1.1.9 for stable behavior.
- Added test scaffold: `server/__tests__/runContract.ts` skeleton, placeholder JSON acceptance specs, and a sanity test wiring vitest.
- Configured vitest to scope coverage to `server/src/**` and exclude v1 paths.
- Installed `git-guard` hooks (per-repo, `.githooks/`) with develop as the integration branch and `mintmcqueen/asyncthink` as the GitHub repo.

### Phase 1 — adapter framework

- Implemented `LocalSubprocessExecutor` (`server/src/exec/localSubprocess.ts`) with timeout, tree-kill on expiry (SIGTERM grace then SIGKILL), separate stdout/stderr capture, and stdin support. 8 unit tests covering exit codes, stdin, cwd, env, timeout-kill, and missing-binary rejection.
- Implemented `FsManifestRegistry` (`server/src/adapters/registry.ts`) with strict validation (required fields, string-array `requiredEnv`, positive `defaultTimeoutMs`, no duplicate ids). 7 unit tests.
- Authored three adapter manifests at `server/src/adapters/manifests/{claude,gemini,codex}.json`.
- Implemented three adapter impls at `server/src/adapters/impl/{claude,gemini,codex}.ts`. Read-only enforcement per adapter: claude `--print`, gemini `--approval-mode plan`, codex `--sandbox read-only`. Codex uses native session resume (extracts `thread_id` from `thread.started` JSON events); claude/gemini use replay strategy.
- Codex adapter targets v0.47 (dropped `--ask-for-approval`; sandbox mode governs approval; `thread.started` event provides session id). Updated CLAUDE.md with the rationale.
- `AdapterRegistry.withDefaults()` (`server/src/adapters/index.ts`) registers the three built-ins.
- `RecordingExecutor` test helper (`server/__tests__/_helpers/recordingExecutor.ts`) is the test double at the OS-process boundary — captures argv/env/stdin without spawning a process. 16 adapter unit tests assert each CLI's argv shape.
- Live test scaffolding at `server/__tests__/live/adapters.live.test.ts`, gated on `RUN_LIVE=1`. PONG tests for all three adapters plus a 2-turn codex resume test.
- 33 unit tests passing in CI mode.

### Phase 2 — delegate tool + threading

- Implemented `JsonlThreadStore` (`server/src/stores/jsonlThreadStore.ts`): append-only JSONL transcripts at `~/.local/share/asyncthink/threads/`, with separate `closed/` subdir. Atomic per-line writes via `O_APPEND`. Tolerant of corrupted/truncated lines on read. 11 unit tests including round-trip, concurrent burst, idempotent open/close, sweepIdle by mtime, unsafe-id rejection.
- Added `Adapter.resumeStrategy` (`'native' | 'replay'`) so the delegate handler routes continuation correctly per adapter. Codex is `native` (uses `exec resume <thread_id>`); claude and gemini are `replay` (orchestrator serializes prior turns into the prompt).
- Implemented `Delegate` (`server/src/delegate/delegate.ts`): opens or continues a thread, persists user + assistant turns, optionally closes inline. 9 unit tests cover thread lifecycle, replay vs native routing, parameter forwarding, error handling.
- Implemented `sweepIdleOnce` (`server/src/delegate/sweeper.ts`): rate-limited (30s) idle-thread sweeper, runs on every tool invocation. Default threshold 6h.
- Wired four tools through `server/src/tools/delegate.tool.ts` against real handlers (formerly Phase 0 stubs): `delegate`, `delegate_close`, `delegate_close_all`, `delegate_list_threads`. Tool descriptions and response `reminder` fields keep close-discipline visible to callers.
- Built singleton wiring at `server/src/app.ts` (AdapterRegistry, LocalSubprocessExecutor, JsonlThreadStore, Delegate).
- Implemented contract spec runner (`server/__tests__/runContract.ts`): walks JSON specs, resolves `@from:steps[N].field` refs, supports `@nonempty`/`@string`/`@contains:` predicates. Same spec runs offline (CI) or live (RUN_LIVE=1) by swapping the adapter lookup.
- Authored `server/__tests__/contracts/delegate.spec.json` — 3-step open / follow-up / close flow exercising replay strategy.
- Restart-survival integration tests at `server/__tests__/integration/restartSurvival.test.ts`: 3 tests covering replay history, native sessionId recovery, closed-stay-closed.
- Live multi-turn tests at `server/__tests__/live/delegate.live.test.ts` — gated on `RUN_LIVE=1`. Includes 3-turn codex native-resume test (highest-risk behavior) and 2-turn claude/gemini replay tests.
- 57 unit + integration tests passing in CI mode.

### Phase 3 — asyncthink council + TaskStore + v1 deletion

- Implemented `FsTaskStore` (`server/src/stores/fsTaskStore.ts`): in-memory primary with disk mirror at `~/.local/share/asyncthink/tasks/<sanitizedId>/state.json`. Replaces v1 `ledger.json`'s role for in-flight worker state. 8 unit tests covering create/update/delete, status filtering, disk persistence + reload, sanitization, idempotent delete.
- Extended `TaskState` with `adapter` and `durationMs` so council results carry attribution.
- Implemented `Council` (`server/src/asyncthink/council.ts`): chain-scoped fork registration (`<chainThreadId>::<forkId>`), fire-and-forget dispatch through `Adapter.invoke()`, parallel waitFor, status introspection, and an `endChain` that drains in-flight forks (timeout-bounded), closes all child threads, and prunes tasks. 9 unit tests including parallel-execution timing and chain isolation.
- Ported `AsyncThinkingServer` (`server/src/asyncthink/thinking.ts`) verbatim from v1, with 8 vitest tests asserting unchanged behavior.
- Simplified `prompts.ts` from v1's 142-LOC organizer (workerType branches dropped) to a small `wrapWithCouncilContext` helper.
- Wired `asyncthink.tool.ts` to the real Council + AsyncThinkingServer: chains auto-open on first thought, auto-end on `nextThoughtNeeded:false`, expose `forks` (parallel array), `waitFor`, `readResearch`, and `chainEnded` in responses.
- Added singleton wiring for `Council`, `AsyncThinkingServer`, and `FsTaskStore` in `server/src/app.ts`.
- Authored end-to-end chain integration test (`server/__tests__/integration/asyncthinkChain.test.ts`): scripted 4-thought session with 2 forks at t2, collection at t3, auto-end at t4.
- Authored `server/__tests__/contracts/asyncthink.spec.json` documenting the chain contract; live 3-fork council test at `server/__tests__/live/council.live.test.ts` (RUN_LIVE=1).
- **Audited `server/src.v1/lib/gemini-client.ts`** for retry/timeout logic worth porting; nothing non-trivial. Deleted `server/src.v1/` and `server/__tests__.v1/` directories.
- **Removed `@google/genai` dependency** from `server/package.json`. `npm ls @google/genai` empty; no source references remain in `server/src/`.
- **Rewrote CLAUDE.md** as a fully v2 document. v1 sections deleted; v1 history retained in this CHANGELOG only.
- 85 unit + integration tests passing in CI mode.

### Phase 4 — SkillRegistry + reference skills + slash commands

- Implemented `FsSkillRegistry` (`server/src/stores/skillRegistry.ts`) with markdown-frontmatter loader supporting two locations: directory-style for plugin-shipped skills (`<plugin-root>/skills/<name>/SKILL.md`) and flat-style for user skills (`~/.config/asyncthink/skills/<name>.md`). User skills override plugin skills on id collision.
- Added a small line-oriented YAML frontmatter parser (`parseFrontmatter`) supporting scalar strings, integers, floats, and booleans without pulling in a third-party YAML dependency. 6 parser unit tests + 6 registry unit tests.
- `SkillResolver` (`server/src/skills/resolver.ts`) composes the resolved invocation: adapter from frontmatter (authoritative), prompt = body + `---` + caller's prompt, caller overrides for model/timeout. Errors via `SkillAdapterMismatchError` if caller passes a conflicting adapter, `SkillNotFoundError` for unknown skill ids. 6 resolver unit tests.
- Wired `delegate` and `asyncthink` (forks) tool handlers to consult the registry when `skill` is supplied. `adapter` is now optional on both schemas — callers can pick by name alone.
- Authored three reference skills:
  - `skills/code-review/SKILL.md` (codex) — adversarial code review.
  - `skills/architecture-critique/SKILL.md` (gemini) — independent architectural critique.
  - `skills/test-design/SKILL.md` (claude) — coverage and behavior-test analysis.
- Authored two slash commands wrapping these skills:
  - `commands/critique.md` → `/asyncthink:critique`.
  - `commands/review-pr.md` → `/asyncthink:review-pr`.
- Integration test (`server/__tests__/integration/shippedSkills.test.ts`) verifies the production path-resolution loads all three shipped skills with valid adapter ids.
- 106 unit + integration tests passing in CI mode.

### Phase 5 — audit log, config refactor, migration, release

- Implemented `JsonlAuditLog` (`server/src/stores/jsonlAuditLog.ts`): append-only JSONL at `~/.local/share/asyncthink/audit.jsonl`. Records every adapter invocation and thread lifecycle event with timestamp and pid. Failure-isolated: write errors log to stderr but do not break tool calls. 4 unit tests.
- Wired audit log through `Council` and `Delegate` (optional 5th constructor arg; defaults to no-op for tests).
- Refactored `asyncthink_config` tool with real actions: `list_adapters` (manifests + binary availability via `which` + env-readiness check), `list_skills` (Skill[] from registry with metadata), `reload_skills` (force re-scan). General `get`/`set`/`reset` reserved for v2.1.
- Implemented v1→v2 migration check (`server/src/migrate.ts`): renames `~/.local/share/asyncthink/ledger.json` to `ledger.v1.json.bak` on first v2 startup, with one-line stderr warning. Idempotent. 3 unit tests.
- Bumped plugin and server version to **2.0.0** (dropped `-alpha`).
- README rewrite: install paths, adapter prerequisites, persistence layout, test mode (`RUN_LIVE=1`), skill authoring, migration notes.
- Final CLAUDE.md pass.
- 113 unit + integration tests passing in CI mode.

## [1.1.9] — Prior release
- Phase 3: `FsTaskStore`, council refactor, deletion of `server/src.v1/` and `@google/genai`.
- Phase 4: `SkillRegistry`, three reference skills, slash command wrappers.
- Phase 5: `JsonlAuditLog`, config tool refactor, migration, smoke tests, `v2.0.0` tag.

## [1.1.9] — Prior v1 release

The last shipped v1 tag. See `git log v1.1.9` for v1 history.
