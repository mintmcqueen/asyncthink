# Changelog

All notable changes to AsyncThink are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Packaging
- Add `.claude-plugin/marketplace.json` so the repo serves as a single-plugin marketplace; install via `claude plugin marketplace add <path>` + `claude plugin install asyncthink@asyncthink-local`.
- Commit `server/dist/` for plugin distribution (Claude Code's plugin manager does not run `npm install`). `.gitignore` updated so root `/dist/` stays ignored but `server/dist/` is tracked.
- Set plugin and marketplace author to `mintmcqueen`.
- GitHub default branch set to `develop` so plugin installs pull v2 code by default.

## [2.4.0] — 2026-05-15

Security hardening cycle. Triggered by a full dependency review against the 2025-2026 npm supply-chain compromise registry — chalk/debug (Sept 8 2025), Shai-Hulud worm (Sept 2025), Shai-Hulud 2.0 (Nov 24 2025 — 796 packages, 20M weekly downloads), axios (March 31 2026, 100M+ weekly downloads), TanStack + Mini Shai-Hulud (May 11-12 2026 — 170+ packages, dead-man's-switch wipes home dirs), node-ipc (May 14 2026 — 10M weekly downloads). Our installed versions were already past every compromise window, but the architectural defenses needed work: no lockfile committed, caret ranges resolving freshly, `npm install` instead of `npm ci`, and a vulnerable MCP SDK transitive in `@modelcontextprotocol/sdk@1.24.3`.

### Security
- **CVE-2026-25536 (high) closed** — upgraded `@modelcontextprotocol/sdk` to `^1.26.0` (`1.29.0` installed). The advisory describes a cross-client data leak via shared `StreamableHTTPServerTransport` reuse; AsyncThink uses stdio transport so the runtime exposure was nil, but the upgrade also cascades fixes for 10 transitive CVEs (`ajv` ReDoS, `brace-expansion` hang, `fast-uri` path traversal, `minimatch` ReDoS×3, `path-to-regexp` DoS, `picomatch` ReDoS, `qs` DoS×2, plus dev-only `rollup`/`vite`/`postcss`).
- **Lockfile committed**. `server/package-lock.json` is now tracked. Prior installs resolved caret ranges (`^x.y.z`) freshly each time; if a compromised minor release of any of our 89 runtime transitives hit npm, the next install would have picked it up automatically. The lockfile pins every transitive to an exact `resolved` URL + integrity hash.
- **Reinstall script uses `npm ci --omit=dev --ignore-scripts`** instead of `npm install --omit=dev --ignore-scripts`. `npm ci` refuses to resolve anything outside the lockfile; combined with `--ignore-scripts` (which blocks `preinstall`/`postinstall` hooks — the primary RCE vector in Shai-Hulud and node-ipc payloads), this gives a frozen + script-disabled install path.
- **`npm audit --omit=dev --audit-level=high` gated pre-push** via `git config git-guard.test-cmd "(cd server && npm run audit:runtime && npm test --silent)"`. Future high/critical advisories block push until acknowledged.

### Removed dependencies
- **`chalk`** (runtime, ^5.3.0) — used in 3 call sites in `src/asyncthink/thinking.ts` (`.yellow`, `.green`, `.blue`). Replaced with a 7-line inline ANSI helper. Eliminates a direct dep that was at the center of the Sept 8 2025 attack (we were on 5.6.2, one patch past the compromised 5.6.1, but every direct dep is an attack surface for the next campaign).
- **`dotenv`** (runtime, ^17.2.3) — zero imports across `src/` and `__tests__/`. Pure dead weight; removed.
- **`shx`** (dev, ^0.3.4) — used in 3 build-script commands (`chmod +x`, `mkdir -p`, `cp`). Replaced with direct bash equivalents in `package.json`. Project is darwin/linux only so cross-platform shimming wasn't load-bearing; eliminates `shelljs` transitive surface.

### Footprint
- **189 packages** (down from **216**). Runtime tree: 84 (down from 89); dev tree: 105 (down from 127).
- **0 vulnerabilities** at any severity (down from **11**: 7 high + 4 moderate).
- One direct dep added: none. Direct runtime deps now: `@modelcontextprotocol/sdk`, `zod`. Two.

### Build / tooling
- `npm run build` no longer routes through `shx`; uses bash `chmod`/`mkdir -p`/`cp` directly.
- New `npm run audit:runtime` script: `npm audit --omit=dev --audit-level=high`. Exits non-zero on any high/critical advisory in the runtime tree (ignores dev-only finds).

### Migration
- `cd server && npm run reinstall` after pulling v2.4.0 — the reinstall script handles the version bump, the `npm install`→`npm ci` switch is internal to step 6, and the bookmark refresh picks up the smaller dep set automatically.
- If you have local skill files using `chalk` directly: switch to your own ANSI escapes or inline `\x1b[XXm...\x1b[0m`.
- The `--ignore-scripts` flag means packages with legitimate postinstall steps (e.g. native bindings) won't auto-build. None of our current deps need scripts; if a future dep does, vendor the build artifact or pre-run scripts in CI before publishing.

### Why a minor bump, not a patch
- Install-flow semantics change (npm install→npm ci), lockfile becomes load-bearing, three direct deps removed. Patch bumps imply no surface change; this is a surface change even though no tool contract moved.

## [2.3.3] — 2026-05-15

Flexibility fix-pack. v2.3.0's pre-flight rate-limit refuse was correct but rigid: when the env-derived auth path misclassifies a caller's real route (e.g. `ANTHROPIC_API_KEY` set but the CLI actually uses subscription auth, or vice versa), there was no per-call escape hatch — the only way to widen the gate was to mutate env vars before spawning the parent session. v2.3.3 adds two opt-in levers AND closes a thread-leak in the async-delegate path.

### Added
- **`authPath` override** on `delegate`, `asyncthink` forks, skill frontmatter (`auth_path:`), and `TaskExecutorRequest`. When set, the rate-limit gate looks up `tierLimits.<tier>.rateLimit.byAuthPath[<override>]` instead of running `detectAuthPath(env)`. Affects ONLY the advisory lookup — actual adapter spawn argv/env routing is unchanged. Use cases:
  - Vertex / Bedrock callers whose env probe misfires.
  - A subscription-auth user with `ANTHROPIC_API_KEY` set as a fallback (the env probe would gate them to Tier-1 ITPM; subscription has higher caps).
  - Future per-call selection of provider route as v3 multi-tenant arrives.
- **`bypassRateLimit: true`** on the same four surfaces (skill frontmatter: `bypass_rate_limit:`). Opts out of the pre-flight refuse entirely; the call proceeds and the caller assumes 429 risk. Emits a `task.bypass_rate_limit` audit event with `taskId`, `adapter`, `authPath?`, `reason` so operators can correlate post-hoc 429s with bypass intent.
- New audit event `task.bypass_rate_limit` documented in CLAUDE.md (audit-log section).

### Fixed
- **Async-delegate thread leak**: `runTask` in `LocalInProcessTaskExecutor` now closes the child thread on every terminal transition (`completed` / `failed`) and also on the `cancel()` path. Previously, async delegates left their child thread open in `~/.local/share/asyncthink/threads/`; only the 6h idle sweeper would eventually close them. The sync `Delegate.run` path already closed threads on the `close: true` flag, so the gap was async-specific. New `thread.close` audit event paired 1:1 with task terminal events.

### Schema additions
- `AdapterInvocation.authPath?: string` and `AdapterInvocation.bypassRateLimit?: boolean` (core/adapter.ts).
- `TaskExecutorRequest.authPath?: string` and `TaskExecutorRequest.bypassRateLimit?: boolean` (core/taskExecutor.ts).
- `DelegateRequest`, `ForkRequest`, `Skill`, `ResolvedSkill` gain matching optional fields.
- Skill frontmatter accepts `auth_path: <string>` and `bypass_rate_limit: <bool>`.
- `auditLog.ts` adds `kind: 'task.bypass_rate_limit'` variant.

### Migration
- Fully backward compatible. Absent fields preserve v2.3.2 behavior (env-derived authPath + enforcement enabled). Skill files without the new keys are unaffected.

### Why this matters (PM lens)
- v2.2 playtest hit a 429 because claude haiku has a 50k input-tokens/minute cap on the API auth path. v2.3.0 added the pre-flight refuse so callers see a structured advisory instead of a 429. v2.3.0 also got the auth-path detection right MOST of the time — but "most" isn't "always", and the user's recovery instinct ("just don't send long prompts") meant the system was constraining their behavior to avoid a misclassification. v2.3.3 inverts that: when the gate is wrong, callers say so once per call (or once per skill) and proceed. The audit trail lets us tune `detectAuthPath` over time using real bypass patterns rather than guessing.

## [2.3.2] — 2026-05-15

Reinstall-script fix-pack. Two bugs surfaced when restarting Claude Code post-v2.3.1: (a) `claude plugin install` no-ops on existing bookmark instead of refreshing; (b) `claude plugin update` (the actual refresh command) doesn't run `npm install` in the new cache dir, so the v2.3.1 MCP server failed to boot with `Cannot find package 'dotenv'`. Both fixes land in `server/scripts/reinstall.sh`.

### Fixed
- `server/scripts/reinstall.sh` step 4 now captures the `claude plugin install` output and detects the `"already installed"` no-op signature; falls back to `claude plugin update asyncthink@asyncthink-local` automatically. Previously the script reported success and the bookmark stayed pinned to the old version.
- `server/scripts/reinstall.sh` gains step 6: reads `installPath` from `~/.claude/plugins/installed_plugins.json` and verifies `<installPath>/server/node_modules/` exists. If absent (the `update`-vs-`install` gap in the plugin manager), runs `npm install --omit=dev --ignore-scripts --silent` in the install path so the MCP server can actually boot post-restart.
- Script renumbered to 7 steps to accommodate the new node_modules guard.

### Migration
- No code or schema changes. Just rerun `cd server && npm run reinstall` after pulling v2.3.2 to pick it up. Future updates use the corrected flow automatically.

### Known gaps (v2.4 backlog)
- Long-term, the right fix is to bundle deps into `dist/index.js` via `tsup` so `node_modules/` is unnecessary at runtime. v2.3.2 keeps the current architecture and patches the install flow; v2.4 should revisit bundling.

## [2.3.1] — 2026-05-15

Review fix-pack from PR #5 (mintmcqueen). Four blockers + four high-impact gaps + several defensive polish items, all surfaced during code review of the v2.3.0 stack before merge.

### Fixed (blockers)
- **B1** — `mcpServers` is now first-class on `TaskExecutorRequest` and forwarded by ALL four invocation paths: sync delegate (`Delegate.run`), async delegate (`Delegate.runAsync` → executor.start → runTask), sync fork (`Council.runFork` — already wired in v2.3.0), async fork (executor.start → runTask). New integration test `__tests__/integration/mcpServersPropagation.test.ts` asserts the field reaches `adapter.invoke` from every path. Previously: async paths silently dropped the value.
- **B2** — Rate-limit pre-flight refuse math corrected (R6a-D.5):
  - Branches on `cap.dim` (`input` divides by estimated tokens; `requests`/`messages` use the cap as item count, NOT tokens; `output` is not gated). Fixes gemini high's `{tokens:250, windowSec:86400, dim:'requests'}` which v2.3.0 wrongly computed as 0 allowance → forced 1 fork/day.
  - Bucket window aligned with `cap.windowSec` (was named "per-minute" but spanned the full window).
  - Files included in the token estimate (uses `approxTokensWithFiles`, same byte heuristic as `checkContextLimit`).
  - Slot push deferred to AFTER the inflight Promise spawns so a failed step doesn't burn a phantom slot.
  - New unit tests `__tests__/unit/rateLimitRefuse.test.ts` (6 cases) cover all four dims and two window sizes.
- **B3** — The runtime sweeper (`delegate/sweeper.ts`) now delegates to `taskExecutor.sweepIdle()` so the in-memory `cancelling` set actually protects in-flight cancellations (R5-D.3) and the 30-minute hard ceiling (R5-D.4) fires `task.terminated{signal:'orphaned'}` (R5-D.5). v2.3.0 called `taskStore.cleanupStale()` directly with no skip set, making R5-D.3/D.4/D.5 dead on the sweep path. New integration test asserts both branches.
- **B4** — `detectAuthPath` is now an exhaustive `switch` over `AdapterId` with a `never`-typed default that throws on unknown ids. v2.3.0 had non-`else` if-chains that silently ran the codex branch for any non-claude/non-gemini adapter — the manifest validator accepts arbitrary ids, so this was a real footgun. Test covers the throw.

### Fixed (high-impact gaps)
- **H1 + H2** — Pre-flight gates now run on SYNC paths too:
  - `Delegate.run` (sync delegate) honors `preflight: 'auth'` and applies the R6a-D.5 rate-limit refuse, sharing the executor's `recentSpawns` and `authProbeCache` for state consistency.
  - `Council.runFork` (sync forks) does the same.
  - Both paths gain optional dependencies (`taskExecutor` for Delegate, `taskExecutor` + `manifests` for Council) so the gates run when wired via `app.ts` and remain inert in unit tests that build them directly.
  - The shared logic lives on two new public methods on `LocalInProcessTaskExecutor`: `applyAuthGate(adapter, principal, model)` and `applyRateLimitGate(req)` (returns a deferred-push closure).
  - Net effect: the v2.2 playtest 429 path (sync council forks at claude-haiku rate-limited tier) is now gated.
- **H3** — `detectClaudeError` no longer runs on `exitCode === 0` (or non-timeout success-shaped output). v2.3.0 ran the permissive substring detector unconditionally; a legitimate response mentioning "Rate limit reached" in prose would throw away as a fake rate-limit AdapterError. Gate semantics match gemini and codex now. New regression test asserts the success path.
- **H4** — `task.fail` audit event variant now carries `errorKind`, `errorActionable`, `errorDetails`. TaskState also persists `errorDetails`. Operators can bucket failure-shape distributions from the audit log without joining back to the task mirror.

### Fixed (defensive / fidelity)
- `LocalSubprocessExecutor.cancel(onExit)` now QUEUES the `onExit` callback when cancel arrives before spawn, then arms it on the real subprocess `close` event so `task.terminated` records actual `signal`/`exitCode` (instead of `null,null`). Includes a 5-second fallback timer for the rare case where the spawn never arrives (runTask aborts early).
- Gemini noise signature is now a prefix-match regex (`isNoiseOnlyResponse`) tolerant of trim, wording variants (`MCP issues found` / `MCP issues detected`), and case. v2.3.0's strict exact-match would regress to silent-failure on a trivial wording change in gemini-cli.
- Codex `preflightAuthProbe` now checks `~/.codex/auth.json` (subscription auth) in addition to `OPENAI_API_KEY`. v2.3.0 always returned `ok:true` for codex even when neither was present, breaking the "fails fast on missing auth" contract.

### Schema additions
- `TaskExecutorRequest.mcpServers?: string[]` and `TaskExecutorRequest.preflight?: 'auth' | 'none'` are now first-class.
- `TaskState.errorDetails?: Record<string, unknown>` (additive).
- `AuditEvent` `task.fail` variant gains `errorKind?`, `errorActionable?`, `errorDetails?` (additive).
- `LocalInProcessTaskExecutor.applyAuthGate(...)` and `.applyRateLimitGate(...)` are now public methods.
- `Council` constructor gains optional `gates?: CouncilGates` and `manifests?: ManifestRegistry` parameters.
- `Delegate` constructor gains an optional `manifests?: ManifestRegistry` parameter.

### Tests
- 250 unit + integration tests passing (was 234 in v2.3.0). New files: `rateLimitRefuse.test.ts` (6), `mcpServersPropagation.test.ts` (5), `sweeperCancellingSkip.test.ts` (2). Extensions to `authPath.test.ts` (B4), `adapters.test.ts` (H3), `jsonlAuditLog.test.ts` (H4).
- v2.3 acceptance: 24 offline + 26 live (regression check including real claude PONG).
- v2.2 acceptance: 23/23 (version-tolerant, regression check).

### Migration
- Additive at wire format. v2.3.0 → v2.3.1 callers see no breaking changes. `TaskState`/`AuditEvent` additions are optional fields; old readers ignore. The `Delegate` and `Council` constructor extensions are optional — existing tests that build them with the v2.3.0 signature still work.

## [2.3.0] — 2026-05-10

Fix-pack release from real-use playtest of v2.2 (2026-04-28). Five issue clusters addressed across 21 locked rulings; all amendments to v2.2 carry deprecation windows so wire-format stays backward-compatible. The framework doc with full rulings lives at `dev/research/v2-3-R7-framework.md` (gitignored per R2-D.4).

### Added — Gemini parser & spawn hardening (F3)
- **F3-D.1** `parseGeminiJson` rejects `obj.response === <noise prefix>` before returning. Closes the v2.1.1 F2 hole where gemini-cli's `UserFeedback` subscriber pollutes the response stream.
- **F3-D.2** Curated MCP-server allowlist on gemini spawn via `--allowed-mcp-server-names <list>`. Default: `["sequentialthinking", "context7"]`. Skills extend additively via `mcp_servers: [...]` frontmatter; callers extend via `mcpServers: [...]` arg. Skills/callers cannot REMOVE servers — keeps audit story one-way. Codex MCP allowlist is informational only in v2.3 (codex v0.125 has no flag-level surface; v2.4 will add `$CODEX_HOME` override).
- **F3-D.3** Gemini adapter throws `AdapterError({kind:'silent-failure', …})` instead of returning empty text when the parser yields `''` AND stdout matches the noise signature. Surfaces the v2.2 playtest's failure mode as a typed failure.
- **F3-D.4** Council classifies forks that throw AdapterError as `failed`, regardless of exitCode 0. Detector-driven; legitimate short responses pass through.

### Added — Adapter pre-flight & error envelope (R-DIAG)
- **R-DIAG-D.1** Typed `AdapterError` envelope (`server/src/core/adapterError.ts`). Eight kinds: `auth | rate-limit | context | network | binary-missing | timeout | silent-failure | unknown`. `.actionable` (one-sentence next step), `.summary` (one-line), `.raw` (preserved for debugging), `.details` (per-kind metadata). `toJSON()` strips raw for compact transport.
- **R-DIAG-D.2** Per-adapter detector functions: `detectClaudeError` (English substring matches incl. parsed cap), `detectGeminiError` (stderr JSON parse — gemini puts errors on stderr), `detectCodexError` (NDJSON scan for `turn.failed`/`error` lines), `detectBinaryMissing` (ENOENT). Each adapter's `invoke()` calls its own detector and throws on match.
- **R-DIAG-D.3** `list_adapters` gains optional `verify: true` arg. Default passive (env presence + binary path). With verify: cheap LOCAL probes per adapter (no paid API calls). Result fields: `authPath`, `authVerified`, `authVerifiedDetail`.
- **R-DIAG-D.4** Optional `preflight: 'auth'` on delegate / asyncthink forks. Off by default everywhere. When set, the executor runs the auth probe BEFORE allocating a task row; throws AdapterError with no state-row created. Skills can pin via frontmatter.
- **R-DIAG-D.5** Council fork output on failure carries `{ error: adapterError.toJSON(), raw: undefined }`. Raw stays on TaskState; council response stays bounded.
- **R-DIAG-D.6** `ContextLimitExceededError` from v2.2 R6a-D.2 becomes a typed subclass of `AdapterError` with `kind:'context'`. Existing `instanceof` checks keep working; the class gains the unified actionable/summary/raw surface.

### Changed — Tier-model amendments (R6a)
- **R6a-D.4** Replaces `tierLimits.<tier>.rateLimitClass: RateLimitClass` with `tierLimits.<tier>.rateLimit: { byAuthPath, default, lastVerified }`. v2.3 carries both fields during a deprecation window; v2.4 drops the legacy field. *(Amends R6a-D.1.)*
- **R6a-D.5** Pre-flight refuse over-budget forks at fork-spawn time. Skip individual over-limit forks with prominent warning; council continues. Derives `forks_allowed_per_minute = floor(cap.tokens / estTokens / (cap.windowSec / 60))`. *(Amends R6a-D.2 from advisory-only to enforcement.)*
- **R6a-D.6** Real per-cell assignments per the < 100k-ITPM-at-Tier-1 rule:
  - claude all 3 tiers via `api` → `rate-limited` (sonnet 30k ITPM, haiku 50k ITPM at Tier 1)
  - claude all tiers via `subscription`/`vertex`/`bedrock` → `standard`
  - gemini high via `ai-studio` → `rate-limited` (sparse public docs; conservative)
  - gemini med/low via `ai-studio` → `standard` (1M ITPM range)
  - codex all tiers across all paths → `standard` (500k+ ITPM on api; subscription path metered differently)
- **R6a-D.7** `lastVerified` staleness check: `list_adapters` emits stderr warning naming cells whose `lastVerified` is > 90 days old. Bootstrap value `2026-04-29` for all v2.3 cells.

### Added — Auth-path detection
- `server/src/adapters/authPath.ts` exports `detectAuthPath(adapter, opts)` returning the path string the adapter would use given current env. Supported paths:
  - **claude**: `subscription` (default), `api` (`ANTHROPIC_API_KEY`), `vertex` (`CLAUDE_CODE_USE_VERTEX=1`), `bedrock` (`CLAUDE_CODE_USE_BEDROCK=1`).
  - **gemini**: `ai-studio` (default), `vertex` (`GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT`).
  - **codex**: `subscription` (default), `api` (`OPENAI_API_KEY`), `azure` (Azure OpenAI env config).

### Added — Cancellation state-machine refinement (R5)
- **R5-D.1** Wire-level `cancelling` confirmed forbidden by MCP Tasks spec; state-flip-first preserved.
- **R5-D.2** `LocalInProcessTaskExecutor` gains private `cancelling: Set<string>` — in-memory shadow-state for taskIds whose subprocess hasn't confirmed exit. Not persisted, not on wire.
- **R5-D.3** `TaskStore.cleanupStale({skip})` honors the cancelling set; FsTaskStore defers deletion until subprocess close. *(Amends R-DUR-D.4 — TTL values unchanged; deletion check gains in-flight skip.)*
- **R5-D.4** `CANCELLING_HARD_CEILING_MS = 30 * 60_000`. Sweeper force-deletes past the ceiling and emits `task.terminated` with `signal: 'orphaned'`.
- **R5-D.5** New audit event `task.terminated` with `terminatedAt`, optional `signal`, optional `exitCode`. Reserves `signal: 'orphaned'` for v3 watchdog. Emitted exactly once per cancel, paired 1:1 with `task.cancel`.
- **R5-D.6** `tasks_result` blocker semantics preserved: unblocks immediately on cancel.
- **R5-D.7** Multi-tenant `waitpid` watchdog deferred to v3; documented gap in CLAUDE.md.

### Added — Plugin distribution (R-DIST)
- **R-DIST-D.1** `npm run reinstall` (in `server/`) — thin verifier script:
  1. Assert version triple agrees (`marketplace.json`, `plugin.json`, `server/package.json`).
  2. Warn on dirty/unpushed `origin/develop`.
  3. Run `claude plugin marketplace update asyncthink-local` + `claude plugin install asyncthink@asyncthink-local`.
  4. Print new bookmark (version, installPath, gitCommitSha).
  5. Bold restart reminder. NEVER auto-commits or auto-pushes.
- **R-DIST-D.2** `npm run cache:status` and `npm run cache:prune` companions. Status classifies cache dirs as `bookmarked` / `orphaned` / `stranded`. Prune removes non-bookmarked dirs; never touches the bookmark.
- **R-DIST-D.3** / **R-DIST-D.4** CLAUDE.md and README.md document the canonical install/update sequence; README's "Installing & updating" section + footgun callout for `origin/develop` clone behavior.

### Schema additions
- `AdapterInvocation.mcpServers?: string[]` — additive allowlist forwarded to adapter spawn.
- `Skill.mcpServers?: string[]` + `Skill.preflight?: 'auth' | 'none'` — parseable frontmatter fields.
- `ResolvedSkill.mcpServers` + `ResolvedSkill.preflight` — propagated through resolver.
- `TaskState.errorKind?: string` + `TaskState.errorActionable?: string` — persisted AdapterError details.
- `CouncilResult.errorKind?` + `CouncilResult.errorActionable?` — surfaced through asyncthink-tool response on failure.
- `AdapterManifest.tierLimits.<tier>.rateLimit` (new) — supplants `rateLimitClass` during the deprecation window.
- `AdapterManifest.mcp.allowlist` + `AdapterManifest.mcp.catalog` — per-adapter MCP-server curation.

### Tests
- New `adapterError.test.ts` (16 cases) — envelope shape + per-adapter detectors.
- New `authPath.test.ts` (12 cases) — env-permutation probe for all 3 adapters × supported paths.
- New `v2_3.acceptance.mjs` — end-to-end through stdio; 24 offline + 26 live assertions covering all the rulings above.
- Extensions: `skillRegistry.test.ts` (+3 mcp_servers + preflight cases), `fsTaskStore.test.ts` (+2 skip-filter + hard-ceiling cases), `jsonlAuditLog.test.ts` (+2 task.terminated cases), `taskExecutor.test.ts` (+3 cancellation + AdapterError persistence + preflight cases), `adapters.test.ts` (F3-D.3 throw assertion).
- v2.2 acceptance test (`v2_2.acceptance.mjs`) updated to be version-tolerant (matches any v2.x).
- Total: **234 unit + integration tests** (was 196 in v2.2) + 24 v2.3 acceptance + 26 v2.3 live acceptance. All passing.

### Migration
- v2.3.0 is **purely additive at the wire format**. No breaking tool-arg changes. Three internal amendments to v2.2 rulings (R6a-D.1, R6a-D.2, R-DUR-D.4) preserve behavior via deprecation windows / additive semantics.
- v2.2 manifests (with `rateLimitClass`) keep working — the loader prefers the new `rateLimit.byAuthPath` field when present, falls back to `rateLimitClass` otherwise. v2.4 will drop the legacy field.
- TaskState `errorKind`/`errorActionable` are optional new fields; old v2.2 readers ignore them.
- AuditEvent additions (`task.terminated`) are additive; old readers ignore unknown kinds.
- v2.1.1 F2 parser tests are intentionally rewritten in v2.3 to assert the new throw-AdapterError contract (F3-D.3) — the old "return empty" contract is gone.
- Rollback: revert the squash commit; no data migrations. v2.2 readers handle v2.3 state files (extra fields ignored).

## [2.2.0] — 2026-04-27

Background jobs (MCP Tasks primitive), tier-model rework with load-bearing `tierLimits`, skill-pinning successor-substitution policy, and per-delegate credentials wire-stub for v3. Purely additive at the source level. The full ruling set lives at `dev/research/R7-framework.md`.

### Added — Background Jobs (R2-D, R3-D, R-DUR-D)
- `TaskExecutor` interface (`server/src/core/taskExecutor.ts`) — lifecycle + progress hooks. Designed as the v3 swap point.
- `LocalInProcessTaskExecutor` (`server/src/exec/localInProcessTaskExecutor.ts`) — v2.2 in-process implementation. Spawns the adapter via Promise + `LocalSubprocessExecutor`, mirrors state into `FsTaskStore`, supports idempotency dedup, pre-flight context check, principal binding, and best-effort cancel. (R3-D.1, R3-D.2)
- Four new MCP tools: `tasks_get`, `tasks_list`, `tasks_cancel`, `tasks_result` (`server/src/tools/tasks.tool.ts`). Surface MCP Tasks RPC verbs (SEP-1686) as user-callable tools. (R2-D.1, R4-D.1)
- `delegate({async: true, ...})` returns `{taskId}` and runs the work in the background through the TaskExecutor. Sync path (`async: false` default) is unchanged. (R4-D)
- `asyncthink({forks[].async: true})` spawns detached forks that survive chain-end (R-DUR-D.1). The response surfaces detached task ids in `output.detachedTasks`.
- `asyncthink_config` gains `list_tasks` and `cancel_task` action aliases. (R4-D.2)
- Two new slash commands: `/asyncthink:delegate-async` and `/asyncthink:tasks`. (R4-D.3)
- `TaskState` schema extended with `detached`, `principal`, `idempotencyKey`, `taskTtlMs`, `lastUpdatedAt`, `parentChainId`, `sessionId`, `substitutedFrom`, `exitCode`. Backward-compatible: legacy v2.0 status strings (`pending|running|complete|failed`) still parse, alongside MCP spec strings (`working|input_required|completed|failed|cancelled`).
- `FsTaskStore.findByIdempotencyKey(key, principal)` — non-terminal dedup lookup. (R-DUR-D.3)
- `FsTaskStore.cleanupStale()` reaps tasks per category TTL (working/completed 60m, failed 10m, cancelled 5m). Caller `ttlMs` clamped to `[60s, 60m]`. (R-DUR-D.4)
- `FsTaskStore.list()` — full task enumeration for the executor's list method.
- `LocalSubprocessExecutor.cancel(taskId)` + `bindNextSpawn(taskId)` — caller-initiated cancel via SIGTERM (SIGKILL after 1s grace). Pre-spawn cancellation is queued and applied as soon as the subprocess exists. (R-DUR-D.5)
- `Council.endChain` skips detached tasks; awaits non-detached via `Promise.allSettled` with the existing 180s timeout. Detached forks are queryable via `tasks_get` past chain-end. (R1-D.2)
- Sweeper extends to also reap stale tasks (`server/src/delegate/sweeper.ts`). Same 30s rate-limit semantics as the thread sweep.

### Added — Tier-model rework (R6a-D)
- `AdapterManifest.tierLimits` schema in `server/src/core/manifests.ts`. Per-tier facts: `maxContext`, `rateLimitClass` ('standard'|'rate-limited'|'unlimited'), `expectedLatencyMsP50`. Validated on manifest load.
- Real values shipped for claude/gemini/codex (`server/src/adapters/manifests/*.json`):
  - claude: 200k maxContext (all tiers), standard rate-limit class.
  - gemini: 1M maxContext (all tiers), standard rate-limit class.
  - codex: 400k maxContext (high/med), 128k (low), standard rate-limit class.
- Pre-flight context-size check (`tierResolver.checkContextLimit`) runs in `LocalInProcessTaskExecutor.start()` and rejects with `ContextLimitExceededError` before spawning. Heuristic: ~4 chars/token over `prompt + files` byte size.
- Documented within-adapter ordinal framing: "intelligence is a within-adapter ordinal, not a cross-adapter SLA." Surfaces in CLAUDE.md tier section.

### Added — Skill-pinning policy (R6b-D)
- `Skill.pinsModel` and `Skill.pinIsCurrent` fields surfaced via `asyncthink_config({action:"list_skills"})`. (R6b-D.3)
- `FsSkillRegistry` accepts an optional `manifests: ManifestRegistry` constructor argument; when supplied, `pinIsCurrent` is derived from the adapter's current `tiers` map.
- `resolveSkill` accepts an optional context (`SkillResolutionContext`) with `manifests` and `auditLog`. When the context provides manifests, a skill that pins a raw `model:` not in the adapter's current tier map triggers R6b-D.2 successor substitution: the skill's model is rewritten to the adapter's `defaultTier` model, a stderr warning is emitted, and a `model.substitute` audit event is recorded with `from`, `to`, `tier`, and `reason: "skill-pin-stale (skill=...)"`. Caller's raw `model` override always wins (no substitution). (R6b-D.1, R6b-D.2)
- `tierResolver.resolveModel` now returns `ResolveModelResult { model, tier, substitutedFrom?, limits? }` instead of a bare string. Adapters updated. Default behavior preserves v2.1.1 semantics — raw model overrides pass through verbatim unless `substituteStaleSkillPin: true` is opted in (currently used only via the skill resolver).

### Added — Per-delegate credentials wire-stub (R-CRED-D)
- `credentials: string` field on `delegate` args, `asyncthink` forks, and skill frontmatter. Wire-only in v2.2 (R-CRED-D.1).
- v2.2 stub: any non-default profile is rejected with `CredentialsNotSupportedError` pointing at v3 (R-CRED-D.2). The literal `"default"` (or absent/empty) is accepted.
- `cred.use` audit event kind reserved (R-CRED-D.4) — not emitted in v2.2.

### Added — Audit log enhancements (R1-D.1)
- New event kinds: `task.create`, `task.complete`, `task.fail`, `task.cancel`, `task.expire`, `model.substitute`. All emitted from the corresponding lifecycle points.
- 90-day rolling window with daily rotation. On startup and once per 24h, the active log is rotated to `audit.jsonl.YYYY-MM-DD` if its oldest entry is older than a day. Archives older than 90 days are pruned.

### Tests
- New `taskExecutor.test.ts` (24 tests): lifecycle, idempotency, cancel, TTL, cross-principal rejection, cred-stub, pre-flight context check.
- New `tasksProtocol.test.ts` (4 tests): end-to-end Tasks tool surface flow.
- New `delegateAsync.test.ts` (4 tests): delegate({async:true}) lifecycle.
- New `tierResolver.test.ts` (12 tests): conflict detection, successor substitution opt-in, pre-flight context check.
- New `tasks.live.test.ts` (1 test, RUN_LIVE=1): real claude PONG via TaskExecutor.
- Extensions: `skillRegistry.test.ts` (+5 tests), `skillResolver.test.ts` (+6 tests), `fsTaskStore.test.ts` (+7 tests), `jsonlAuditLog.test.ts` (+4 tests), `localSubprocess.test.ts` (+2 tests).
- Total: **196 unit + integration tests passing** (was 128). All idempotent — every test sets up and tears down its own state under tmp dirs.

### Migration
- v2.2.0 is purely additive at the source level. No breaking changes to tool args, schema, or wire format. Existing v2.1.1 user state under `~/.local/share/asyncthink/` reads cleanly:
  - On-disk task records are augmented with new fields on next update (`detached`, `principal`, `idempotencyKey`, `taskTtlMs`, `lastUpdatedAt` default to safe values for any pre-v2.2 entries).
  - Audit log rotation kicks in on first startup if `audit.jsonl` is older than a day; the first archive is created and the active log starts fresh.
- Rollback: `v2.2.0` ships as a single squash commit on develop. `git revert <squash>` restores v2.1.1 state. User XDG state survives rollback.

## [2.1.1] — 2026-04-26

Fix-pack from real-use of v2.1.0. No new features; four bugs surfaced during real council/delegate testing, fixed in parallel with the v2.2 background-jobs research kickoff.

### Fixed
- **F1: tier/model conflict-detect.** When a caller (or skill frontmatter) supplies BOTH `intelligence` and `model` AND they resolve to different model ids, the system now throws `TierModelConflictError` instead of silently using `model`. Same-id is still allowed. This catches the silent cost-overrun foot-gun gemini's earlier critique flagged: e.g., `{intelligence: "low", model: "claude-opus-4-7"}` is now rejected. New cross-registry validator at `server/src/skills/conflictValidator.ts` runs at startup and surfaces conflicting skills as stderr warnings before any caller hits them.
- **F2: gemini parser stderr-leak.** Modern `gemini-cli` prepends operational noise to stdout (e.g. "MCP issues detected. Run /mcp list for status.") that collides with the JSON output. The adapter now locates the first valid JSON object via brace-matching (handles nested braces and escaped strings) and extracts `response`/`error.message` fields cleanly. Returns empty when no JSON is present rather than echoing the noise as the response.
- **F3: claude tier remap.** Anthropic's org-level cap of 30k input tokens/minute on `claude-opus-4-7` makes opus unreliable for non-trivial council forks. Demoted: `high` and `med` both map to `claude-sonnet-4-6` (high/med collapse temporarily); `low` stays at `claude-haiku-4-5-20251001`. Users with higher rate limits can pin the raw `model: "claude-opus-4-7"` or edit `server/src/adapters/manifests/claude.json`. R6a (tier-model rework) in the v2.2 research plan will revisit the abstraction more thoroughly.
- **F4: default timeout bump.** Sonnet doing real codebase analysis was getting SIGTERM at the 120s default. Bumped: claude → 300s, gemini → 180s (was 60s), codex → 180s (was 120s). Captured in both manifest JSONs and adapter-impl fallbacks.

### Tests
- 4 new tier-resolution tests (conflict throws; same-id allowed; error message clarity).
- 4 new gemini-parser tests (noisy-prefix JSON; no-JSON noise; nested braces + escapes; structured error surface).
- 5 new validator tests (no-conflict cases; flagged conflict shape; unknown-adapter skip; error formatting).
- 128 unit + integration tests passing in CI mode (was 113); live PONG green for claude (11.8s) and gemini (18.7s).

## [2.1.0] — 2026-04-26

### Added — intelligence tier abstraction

Models are now selected by tier (`high` / `med` / `low`) rather than raw model id. Adapter manifests own the tier-to-model mapping; callers and skills pin to tiers and stay stable as model names evolve.

- `IntelligenceTier` type (`'high' | 'med' | 'low'`) added to `core/manifests.ts`.
- `AdapterManifest` now requires a `tiers: { high, med, low }` map and a `defaultTier`. The free-form `defaultModel` field is gone.
- `AdapterInvocation` accepts `intelligence?: IntelligenceTier`; raw `model?` is preserved as an escape hatch and wins.
- New `tierResolver` (`server/src/adapters/tierResolver.ts`) with explicit precedence: raw `model` > caller `intelligence` > adapter `defaultTier`.
- All three adapters refactored to take `tiers` + `defaultTier` constructor opts. Built-in tier maps:
  - claude: `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`
  - gemini: `gemini-3.1-pro-preview` / `gemini-2.5-flash` / `gemini-2.5-flash-lite`
  - codex: `gpt-5.5` / `gpt-5-codex` / `gpt-5-mini`
- `Skill` interface adds `intelligence?: IntelligenceTier`; frontmatter parser reads `intelligence: high|med|low`.
- `SkillResolver` threads tier through with caller > skill > adapter precedence.
- Tool schemas (`delegate`, `asyncthink` fork shape) accept `intelligence: 'high'|'med'|'low'`.
- `asyncthink_config({action:"list_adapters"})` now returns the full `tiers` map and `defaultTier` per adapter.
- 3 reference skills migrated to `intelligence:` (code-review/architecture-critique → high; test-design → med).
- 4 new adapter unit tests covering tier resolution and override precedence.
- Manifest validator enforces shape: tiers must be `{high, med, low}` strings; defaultTier must be a valid tier.
- 117 unit + integration tests passing.

### Changed
- Default codex model bumped from `gpt-5.4` to `gpt-5.5` (now via `tiers.high`).
- Default gemini model bumped to `gemini-3.1-pro-preview` (`tiers.high`); `med` tier kept at `gemini-2.5-flash`.

## [2.0.1] — 2026-04-26

### Fixed
- Gemini adapter now passes `--skip-trust` so `--approval-mode plan` works outside "trusted" folders. Modern gemini-cli (≥ v0.39) blocks approval-mode overrides in untrusted directories by default, which broke headless invocation from any cwd. Documented minimum gemini-cli version. Live PONG test passes against gemini-cli 0.39.1.
- Updated golden-argv test for gemini to assert `--skip-trust`.

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
