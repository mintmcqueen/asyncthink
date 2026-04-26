# Changelog

All notable changes to AsyncThink are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v2.0.0 in progress

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

### Planned

- Phase 2: `JsonlThreadStore`, `delegate` and close tools, idle sweeper.
- Phase 3: `FsTaskStore`, council refactor, deletion of `server/src.v1/` and `@google/genai`.
- Phase 4: `SkillRegistry`, three reference skills, slash command wrappers.
- Phase 5: `JsonlAuditLog`, config tool refactor, migration, smoke tests, `v2.0.0` tag.

## [1.1.9] — Prior release

The last shipped v1 tag. See `git log v1.1.9` for v1 history.
