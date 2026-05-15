/**
 * LocalInProcessTaskExecutor — v2.2 implementation of the TaskExecutor
 * interface (R3-D.1).
 *
 * Spawns adapter invocations in-process as Promises. Each task is mirrored
 * into the FsTaskStore for debug/audit visibility (R3-D.3). Cancellation
 * goes through `LocalSubprocessExecutor.cancel(taskId)` which sends SIGTERM
 * to the subprocess group (R-DUR-D.5).
 *
 * Implements:
 *   - Idempotency dedup via `(idempotencyKey, principal)` (R-DUR-D.3).
 *   - Pre-flight context-size check per `tierLimits[tier].maxContext`
 *     (R6a-D.2).
 *   - Successor-model substitution for stale pinned models (R6b-D.2).
 *   - Per-tenant principal binding (R-DUR-D.2; v2.2 single-tenant: principal=null).
 *   - Caller-supplied TTLs clamped to category limits (R-DUR-D.4).
 *   - v3-stub: any non-default `credentials` profile is rejected with the
 *     R-CRED-D.2 error.
 *
 * Lifecycle states map to MCP TaskSchema spec strings:
 *   working → completed | failed | cancelled.
 *
 * v3 swap point: RemoteCompanionTaskExecutor with the same interface but
 * dispatching via OAuth-authenticated companion daemon.
 */
import { randomUUID } from 'crypto';
import { AdapterError } from '../core/adapterError.js';
import { CredentialsNotSupportedError, TaskNotFoundError, TaskOwnerMismatchError, clampTtl, } from '../core/taskExecutor.js';
import { isTerminal as isTerminalTaskStatus } from '../core/taskStore.js';
import { LocalSubprocessExecutor } from './localSubprocess.js';
import { checkContextLimit, resolveModel } from '../adapters/tierResolver.js';
import { detectAuthPath } from '../adapters/authPath.js';
const TERMINAL_STATUSES = new Set([
    'completed',
    'failed',
    'cancelled',
]);
export class LocalInProcessTaskExecutor {
    adapters;
    subExec;
    taskStore;
    threadStore;
    auditLog;
    manifests;
    now;
    inflight = new Map();
    progressListeners = new Map();
    /**
     * v2.3 (R5-D.2): in-memory shadow-state. Holds taskIds whose status='cancelled'
     * on disk but whose subprocess hasn't yet confirmed exit. Used to defer
     * sweeper deletion (R5-D.3) and to ensure `task.terminated` audit events fire
     * exactly once per cancel.
     */
    cancelling = new Set();
    /**
     * v2.3 (R6a-D.5): per-(adapter,model,authPath,principal) ring buffer of recent
     * spawn timestamps for pre-flight refuse. Each value is an array of epoch-ms
     * timestamps; entries older than the relevant `cap.windowSec` are pruned at
     * lookup time.
     */
    recentSpawns = new Map();
    /**
     * v2.3 (R-DIAG-D.4): cached auth-probe results. Key: `(adapter, principal)`.
     * Value: `{ok, at}`. TTL 60s; cleared on a failed real call.
     */
    authProbeCache = new Map();
    constructor(opts) {
        this.adapters = opts.adapters;
        this.subExec = opts.executor;
        this.taskStore = opts.taskStore;
        this.threadStore = opts.threadStore;
        this.auditLog = opts.auditLog;
        this.manifests = opts.manifests;
        this.now = opts.now ?? (() => new Date());
    }
    async start(req) {
        // 1. Cred-stub gate (R-CRED-D.2): reject any non-default profile.
        if (req.credentials !== undefined && req.credentials !== '' && req.credentials !== 'default') {
            throw new CredentialsNotSupportedError(req.credentials);
        }
        // 2. Adapter lookup.
        const adapter = this.adapters.get(req.adapter);
        if (!adapter) {
            const known = this.adapters
                .list()
                .map((a) => a.id)
                .join(', ');
            throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
        }
        // 3. Idempotency dedup (R-DUR-D.3).
        const principal = req.principal ?? null;
        if (req.idempotencyKey && this.taskStore.findByIdempotencyKey) {
            const existing = await this.taskStore.findByIdempotencyKey(req.idempotencyKey, principal);
            if (existing) {
                return projectState(existing);
            }
        }
        // 4. Pre-flight context check (R6a-D.2). Resolve model first so we know the tier.
        const manifest = this.manifests ? await this.manifests.get(req.adapter) : undefined;
        let resolvedModel;
        let resolvedTier;
        let resolvedLimits;
        if (manifest) {
            const resolved = resolveModel({
                prompt: req.prompt,
                intelligence: req.intelligence,
                model: req.model,
                files: req.files,
            }, manifest.tiers, manifest.defaultTier, {
                adapterId: req.adapter,
                tierLimits: manifest.tierLimits,
                auditLog: this.auditLog,
            });
            resolvedModel = resolved.model;
            resolvedTier = resolved.tier;
            resolvedLimits = resolved.limits;
            await checkContextLimit({ prompt: req.prompt, files: req.files }, resolved.tier, req.adapter, resolved.limits);
        }
        // 4.5. v2.3 (R-DIAG-D.4): optional auth pre-flight. Throws AdapterError on
        // failure BEFORE any task row is created.
        if (req.preflight === 'auth') {
            this.applyAuthGate(req.adapter, principal, resolvedModel);
        }
        // 4.6. v2.3 (R6a-D.5): pre-flight rate-limit refuse. Look up the
        // auth-path-aware advisory; if rate-limited and we've already burned the
        // budget for this window, throw AdapterError with kind:'rate-limit'.
        //
        // v2.3.1 (B2) fixes: branch on cap.dim, align bucket window, include
        // files, defer slot push. The shared logic lives on `applyRateLimitGate`
        // so Council (sync forks, H1) and Delegate.run (sync, H2) can reuse it.
        let rateLimitSlotPush;
        if (manifest && resolvedLimits?.rateLimit && resolvedTier) {
            rateLimitSlotPush = await this.applyRateLimitGate({
                adapter: req.adapter,
                prompt: req.prompt,
                files: req.files,
                principal,
                resolvedModel,
                resolvedTier,
                rateLimit: resolvedLimits.rateLimit,
                // v2.3.3: thread caller flexibility levers through.
                authPathOverride: req.authPath,
                bypassRateLimit: req.bypassRateLimit,
                // taskId is allocated below; bypass audit gets it after the row exists.
            });
        }
        // 5. Allocate task id and TaskState row.
        const taskId = newTaskId();
        const ttlMs = clampTtl(req.ttlMs);
        const startedAt = this.now().toISOString();
        await this.taskStore.create(taskId, req.prompt);
        await this.taskStore.update(taskId, {
            status: 'working',
            adapter: req.adapter,
            startTime: startedAt,
            lastUpdatedAt: startedAt,
            detached: req.detached ?? false,
            principal,
            idempotencyKey: req.idempotencyKey,
            taskTtlMs: ttlMs,
            parentChainId: req.parentChainId,
            forkThought: undefined,
        });
        await this.recordAudit({
            kind: 'task.create',
            taskId,
            adapter: req.adapter,
            detached: req.detached ?? false,
            principal,
            idempotencyKey: req.idempotencyKey,
        });
        // v2.3.3: bypass audit event fires after the task row exists so it has a
        // valid taskId to reference. Skipped when bypass wasn't requested.
        if (req.bypassRateLimit) {
            await this.recordAudit({
                kind: 'task.bypass_rate_limit',
                taskId,
                adapter: req.adapter,
                authPath: req.authPath,
                reason: 'caller-opt-out',
            });
        }
        // 6. Spawn the inflight Promise.
        const handle = {
            taskId,
            cancelled: false,
            promise: this.runTask(adapter, taskId, req).catch(() => {
                /* swallowed; runTask records all errors into the store */
            }),
        };
        this.inflight.set(taskId, handle);
        handle.promise.finally(() => {
            this.inflight.delete(taskId);
        });
        // v2.3.1 (B2): record the rate-limit slot only AFTER all prior steps
        // succeed. A failed step 5 (taskStore.create) or earlier-thrown step would
        // otherwise burn a phantom slot.
        if (rateLimitSlotPush)
            rateLimitSlotPush();
        const state = await this.taskStore.get(taskId);
        return projectState(state);
    }
    async get(taskId, principal = null) {
        const state = await this.taskStore.get(taskId);
        if (!state)
            throw new TaskNotFoundError(taskId);
        this.assertPrincipal(state, principal);
        return projectState(state);
    }
    async result(taskId, principal = null) {
        let state = await this.taskStore.get(taskId);
        if (!state)
            throw new TaskNotFoundError(taskId);
        this.assertPrincipal(state, principal);
        if (!isTerminalTaskStatus(state.status)) {
            const inflight = this.inflight.get(taskId);
            if (inflight)
                await inflight.promise;
            state = await this.taskStore.get(taskId);
            if (!state)
                throw new TaskNotFoundError(taskId);
        }
        return projectState(state);
    }
    async cancel(taskId, principal = null) {
        const state = await this.taskStore.get(taskId);
        if (!state)
            throw new TaskNotFoundError(taskId);
        this.assertPrincipal(state, principal);
        if (isTerminalTaskStatus(state.status))
            return projectState(state);
        const handle = this.inflight.get(taskId);
        if (handle)
            handle.cancelled = true;
        const adapterId = state.adapter ?? 'unknown';
        // v2.3 (R5-D.2): mark in-flight cancellation BEFORE signalling the
        // subprocess. Sweeper sees the flag and defers deletion until exit
        // confirms (R5-D.3).
        this.cancelling.add(taskId);
        if ('cancel' in this.subExec &&
            typeof this.subExec.cancel === 'function') {
            // Subprocess executor: signal SIGTERM + 1s grace + SIGKILL. The onExit
            // callback fires when the subprocess actually closes (or immediately
            // if there's no subprocess yet).
            this.subExec.cancel(taskId, (code, signal) => {
                this.cancelling.delete(taskId);
                void this.recordAudit({
                    kind: 'task.terminated',
                    taskId,
                    adapter: adapterId,
                    terminatedAt: this.now().toISOString(),
                    signal: signal ?? undefined,
                    exitCode: code ?? undefined,
                });
            });
        }
        else {
            // Non-subprocess executor (fake/test). Emit terminated immediately.
            this.cancelling.delete(taskId);
            void this.recordAudit({
                kind: 'task.terminated',
                taskId,
                adapter: adapterId,
                terminatedAt: this.now().toISOString(),
            });
        }
        const completeTime = this.now().toISOString();
        await this.taskStore.update(taskId, {
            status: 'cancelled',
            error: state.error ?? 'cancelled by caller',
            completeTime,
            lastUpdatedAt: completeTime,
        });
        await this.recordAudit({
            kind: 'task.cancel',
            taskId,
            adapter: adapterId,
            reason: 'caller',
        });
        // v2.3.3: close the child thread synchronously on cancel. The childThreadId
        // is the same as taskId for async-delegate tasks (per runTask convention).
        // For council forks where threadId was set explicitly to chainId::forkId,
        // we close that too. The threadStore.close is idempotent so a double-close
        // (here + runTask's terminal branch) is harmless.
        if (this.threadStore) {
            const childThreadId = taskId; // matches runTask's `req.threadId ?? taskId` fallback
            try {
                await this.threadStore.close(childThreadId);
                await this.recordAudit({
                    kind: 'thread.close',
                    threadId: childThreadId,
                    adapter: adapterId,
                });
            }
            catch {
                /* not fatal */
            }
        }
        const fresh = await this.taskStore.get(taskId);
        return projectState(fresh);
    }
    async list(opts) {
        const all = this.taskStore.list ? await this.taskStore.list() : [];
        const principal = opts?.principal ?? null;
        const filtered = all.filter((t) => (t.principal ?? null) === principal);
        filtered.sort((a, b) => (a.lastUpdatedAt ?? '').localeCompare(b.lastUpdatedAt ?? ''));
        const limit = opts?.limit ?? 50;
        const startIdx = opts?.cursor ? Math.max(0, parseInt(opts.cursor, 10)) : 0;
        const slice = filtered.slice(startIdx, startIdx + limit);
        const nextCursor = startIdx + slice.length < filtered.length ? String(startIdx + slice.length) : undefined;
        return { tasks: slice.map(projectState), nextCursor };
    }
    onProgress(taskId, cb) {
        let listeners = this.progressListeners.get(taskId);
        if (!listeners) {
            listeners = new Set();
            this.progressListeners.set(taskId, listeners);
        }
        listeners.add(cb);
        return () => {
            const set = this.progressListeners.get(taskId);
            if (!set)
                return;
            set.delete(cb);
            if (set.size === 0)
                this.progressListeners.delete(taskId);
        };
    }
    emitProgress(taskId, message) {
        const listeners = this.progressListeners.get(taskId);
        if (!listeners)
            return;
        const evt = { taskId, message, ts: this.now().toISOString() };
        for (const cb of listeners) {
            try {
                cb(evt);
            }
            catch {
                /* listener failures must not break execution */
            }
        }
    }
    async sweepIdle() {
        // v2.3 (R5-D.3): pass `cancelling` set so the store defers deletion for
        // tasks whose subprocess hasn't confirmed exit (up to the 30m hard
        // ceiling enforced inside cleanupStale).
        const reaped = await this.taskStore.cleanupStale({ skip: this.cancelling });
        for (const id of reaped) {
            // If the reap happened despite the skip set (i.e. hit the 30m hard
            // ceiling), emit `task.terminated` with signal:'orphaned' AND clear
            // the cancelling flag.
            if (this.cancelling.has(id)) {
                this.cancelling.delete(id);
                await this.recordAudit({
                    kind: 'task.terminated',
                    taskId: id,
                    adapter: 'unknown',
                    terminatedAt: this.now().toISOString(),
                    signal: 'orphaned',
                });
            }
            else {
                await this.recordAudit({
                    kind: 'task.expire',
                    taskId: id,
                    adapter: 'unknown',
                    reason: 'ttl',
                });
            }
        }
        return reaped;
    }
    /**
     * v2.3.1 (H2): Public auth gate. Throws AdapterError(kind:'auth') if the
     * adapter's local auth probe fails. Used by:
     *   - executor.start() when req.preflight==='auth' (async paths)
     *   - Delegate.run() when req.preflight==='auth' (sync delegate)
     *   - Council.runFork() when req.preflight==='auth' (sync forks)
     */
    applyAuthGate(adapterId, principal, resolvedModel) {
        const probe = this.preflightAuthProbe(adapterId, principal);
        if (!probe.ok) {
            throw new AdapterError({
                kind: 'auth',
                adapter: adapterId,
                model: resolvedModel,
                summary: `${adapterId} pre-flight auth probe failed${probe.detail ? `: ${probe.detail}` : ''}`,
                actionable: probeActionable(adapterId),
            });
        }
    }
    /**
     * v2.3.1 (H1): Public rate-limit gate. Inspects the cap advisory and either
     * throws AdapterError(kind:'rate-limit') or returns a deferred-push closure
     * that the caller invokes after their downstream spawn succeeds.
     *
     * Used by:
     *   - executor.start() (async paths) — invokes push after step 5/6 succeeds
     *   - Council.runFork() (sync forks) — invokes push after adapter.invoke succeeds
     *   - Delegate.run() (sync delegate) — invokes push after adapter.invoke succeeds
     *
     * The deferred-push prevents a phantom slot from burning when a downstream
     * step throws (B2 fix).
     */
    async applyRateLimitGate(args) {
        // v2.3.3: caller opt-out. Skip the gate entirely. The bypass audit event
        // is emitted by the caller AFTER taskId allocation (or with their own
        // task-scoped id for Council/Delegate sync paths) — this keeps gate logic
        // independent of taskId lifecycle.
        if (args.bypassRateLimit)
            return undefined;
        // v2.3.3: honor caller-supplied authPath override; falls back to env-derived.
        const authPath = args.authPathOverride ?? detectAuthPath(args.adapter);
        const advisory = args.rateLimit.byAuthPath[authPath] ??
            args.rateLimit.byAuthPath[args.rateLimit.default];
        if (advisory?.class !== 'rate-limited' || !advisory.cap)
            return undefined;
        const estTokens = await approxTokensWithFiles(args.prompt, args.files);
        const cap = advisory.cap;
        let allowedPerWindow;
        let gated = true;
        switch (cap.dim) {
            case 'input':
                allowedPerWindow = Math.max(1, Math.floor(cap.tokens / estTokens));
                break;
            case 'output':
                // Can't predict assistant-side tokens; do not gate.
                gated = false;
                allowedPerWindow = Number.POSITIVE_INFINITY;
                break;
            case 'requests':
            case 'messages':
                allowedPerWindow = Math.max(1, cap.tokens);
                break;
            default: {
                const _x = cap.dim;
                void _x;
                gated = false;
                allowedPerWindow = Number.POSITIVE_INFINITY;
            }
        }
        if (!gated)
            return undefined;
        const key = `${args.adapter}::${args.resolvedModel ?? '?'}::${authPath}::${args.principal ?? '<null>'}`;
        const nowMs = this.now().getTime();
        const windowMs = cap.windowSec * 1000;
        const bucket = (this.recentSpawns.get(key) ?? []).filter((t) => nowMs - t < windowMs);
        if (bucket.length >= allowedPerWindow) {
            throw new AdapterError({
                kind: 'rate-limit',
                adapter: args.adapter,
                model: args.resolvedModel,
                summary: `Skipping fork: tier "${args.resolvedTier}" via auth-path "${authPath}" ` +
                    `supports ~${allowedPerWindow} ${cap.dim === 'requests' ? 'requests' : cap.dim === 'messages' ? 'messages' : 'forks'} ` +
                    `per ${humanWindow(cap.windowSec)} (est ${estTokens} tokens/fork); ` +
                    `${bucket.length} already in flight this window.`,
                actionable: `Reduce parallel forks, pin a different intelligence tier, or upgrade your ${authPath} quota.`,
                details: {
                    allowedPerWindow,
                    observed: bucket.length,
                    cap,
                    authPath,
                    estTokens,
                },
            });
        }
        return () => {
            bucket.push(nowMs);
            this.recentSpawns.set(key, bucket);
        };
    }
    /**
     * v2.3 (R-DIAG-D.4): cached local auth probe. Returns `{ok}` based on cheap
     * LOCAL checks only — never paid API calls. 60s TTL keyed by adapter+principal.
     *
     * For v2.3 (single-tenant local with principal=null), the probe is a pure
     * env-presence check plus a binary-existence check. v3 will graduate this to
     * a real `claude auth status` / `codex login status` subprocess call.
     */
    preflightAuthProbe(adapter, principal) {
        const key = `${adapter}::${principal ?? '<null>'}`;
        const cached = this.authProbeCache.get(key);
        const now = this.now().getTime();
        if (cached && now - cached.at < 60_000) {
            return { ok: cached.ok, detail: cached.detail };
        }
        const env = process.env;
        let result;
        if (adapter === 'claude') {
            // Subscription path: trust the user; we can't probe without spawning
            // claude. API path requires ANTHROPIC_API_KEY. Vertex requires GCP creds
            // we can't sanity-check locally. Bedrock requires AWS creds.
            result = { ok: true, detail: 'env-presence-only' };
        }
        else if (adapter === 'gemini') {
            const hasKey = (!!env.GEMINI_API_KEY && env.GEMINI_API_KEY.length > 0) ||
                (!!env.GOOGLE_API_KEY && env.GOOGLE_API_KEY.length > 0);
            const hasVertex = env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && !!env.GOOGLE_CLOUD_PROJECT;
            result = hasKey || hasVertex
                ? { ok: true, detail: hasVertex ? 'vertex-env-present' : 'api-key-present' }
                : {
                    ok: false,
                    detail: 'neither GEMINI_API_KEY nor GOOGLE_API_KEY (nor Vertex env) set',
                };
        }
        else {
            // codex: subscription (`codex login`) writes `~/.codex/auth.json`. API
            // path uses OPENAI_API_KEY. v2.3.1: honor the "fails fast on missing
            // auth" contract by checking BOTH — if neither the env nor the auth
            // file is present, the probe fails.
            const hasKey = !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0;
            let hasLoginFile = false;
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { existsSync } = require('fs');
                const codexHome = env.CODEX_HOME ?? (env.HOME ? `${env.HOME}/.codex` : undefined);
                if (codexHome)
                    hasLoginFile = existsSync(`${codexHome}/auth.json`);
            }
            catch {
                /* fs check failed; fall through to env-only check */
            }
            if (hasKey) {
                result = { ok: true, detail: 'OPENAI_API_KEY present' };
            }
            else if (hasLoginFile) {
                result = { ok: true, detail: '~/.codex/auth.json present (subscription)' };
            }
            else {
                result = {
                    ok: false,
                    detail: 'neither OPENAI_API_KEY nor ~/.codex/auth.json detected; run `codex login` or set OPENAI_API_KEY',
                };
            }
        }
        this.authProbeCache.set(key, { ok: result.ok, detail: result.detail, at: now });
        return result;
    }
    async runTask(adapter, taskId, req) {
        const childThreadId = req.threadId ?? taskId;
        let envelope;
        let failureMessage;
        let adapterError;
        try {
            if (this.threadStore) {
                await this.threadStore.open(childThreadId, adapter.id);
                await this.recordAudit({
                    kind: 'thread.open',
                    threadId: childThreadId,
                    adapter: adapter.id,
                });
                await this.threadStore.append(childThreadId, {
                    ts: this.now().toISOString(),
                    role: 'user',
                    adapter: adapter.id,
                    content: req.prompt,
                });
            }
            const exec = this.boundExecutor(taskId);
            const result = await adapter.invoke({
                prompt: req.prompt,
                files: req.files,
                intelligence: req.intelligence,
                model: req.model,
                timeoutMs: req.timeoutMs,
                cwd: req.cwd,
                // v2.3.1 (B1) — async path must forward the additive allowlist too.
                // Previously only the sync council path forwarded mcpServers.
                mcpServers: req.mcpServers,
            }, exec);
            envelope = {
                text: result.text,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                sessionId: result.sessionId,
            };
            if (this.threadStore) {
                await this.threadStore.append(childThreadId, {
                    ts: this.now().toISOString(),
                    role: 'assistant',
                    adapter: adapter.id,
                    sessionId: result.sessionId,
                    content: result.text,
                    meta: { durationMs: result.durationMs, exitCode: result.exitCode },
                });
            }
        }
        catch (err) {
            failureMessage = err instanceof Error ? err.message : String(err);
            // v2.3 (R-DIAG-D.1): if the adapter threw AdapterError, preserve its
            // typed kind + actionable on the TaskState. Failure-classification work
            // happens in the per-adapter detectors; this just persists the verdict.
            if (err instanceof AdapterError) {
                adapterError = err;
            }
            else if (err &&
                typeof err === 'object' &&
                'code' in err &&
                err.code === 'ENOENT') {
                // Subprocess spawn rejection: synthesize binary-missing.
                adapterError = new AdapterError({
                    kind: 'binary-missing',
                    adapter: adapter.id,
                    summary: `${adapter.id} binary not on PATH`,
                    actionable: `Install the ${adapter.id} CLI and ensure it's on PATH.`,
                });
            }
        }
        // If cancel arrived while running, the subprocess was killed and the
        // status was already flipped to 'cancelled'. Honor that and do not
        // overwrite.
        const stateNow = await this.taskStore.get(taskId);
        if (stateNow?.status === 'cancelled')
            return;
        const completeTime = this.now().toISOString();
        if (envelope && envelope.exitCode === 0) {
            await this.taskStore.update(taskId, {
                status: 'completed',
                result: envelope.text,
                durationMs: envelope.durationMs,
                sessionId: envelope.sessionId,
                exitCode: envelope.exitCode,
                completeTime,
                lastUpdatedAt: completeTime,
            });
            await this.recordAudit({
                kind: 'task.complete',
                taskId,
                adapter: adapter.id,
                durationMs: envelope.durationMs,
            });
            await this.recordAudit({
                kind: 'invoke',
                adapter: adapter.id,
                durationMs: envelope.durationMs,
                threadId: childThreadId,
            });
        }
        else {
            const errMsg = adapterError?.summary ??
                failureMessage ??
                (envelope ? `exit code ${envelope.exitCode}` : 'unknown task failure');
            await this.taskStore.update(taskId, {
                status: 'failed',
                error: errMsg,
                durationMs: envelope?.durationMs,
                sessionId: envelope?.sessionId,
                exitCode: envelope?.exitCode,
                errorKind: adapterError?.kind,
                errorActionable: adapterError?.actionable,
                errorDetails: adapterError?.details,
                completeTime,
                lastUpdatedAt: completeTime,
            });
            await this.recordAudit({
                kind: 'task.fail',
                taskId,
                adapter: adapter.id,
                durationMs: envelope?.durationMs ?? 0,
                error: errMsg,
                // v2.3.1 (H4): carry typed envelope fields on the audit event so
                // operators can bucket failure shapes from JSONL without joining back
                // to the task mirror.
                ...(adapterError?.kind && { errorKind: adapterError.kind }),
                ...(adapterError?.actionable && { errorActionable: adapterError.actionable }),
                ...(adapterError?.details && { errorDetails: adapterError.details }),
            });
            await this.recordAudit({
                kind: 'invoke',
                adapter: adapter.id,
                durationMs: envelope?.durationMs ?? 0,
                threadId: childThreadId,
                error: errMsg,
            });
        }
        // v2.3.3: close the child thread synchronously on terminal. Previously
        // async-task threads leaked until the 6h idle sweeper fired. This applies
        // to BOTH the completed-success and failed-error branches; cancelled tasks
        // are handled in cancel() itself.
        if (this.threadStore) {
            try {
                await this.threadStore.close(childThreadId);
                await this.recordAudit({
                    kind: 'thread.close',
                    threadId: childThreadId,
                    adapter: adapter.id,
                });
            }
            catch {
                /* thread already closed or store unavailable; not fatal */
            }
        }
    }
    boundExecutor(taskId) {
        const sub = this.subExec;
        if (sub instanceof LocalSubprocessExecutor) {
            return { run: sub.bindNextSpawn(taskId) };
        }
        return sub;
    }
    assertPrincipal(state, principal) {
        const owner = state.principal ?? null;
        // v2.2 single-tenant: when both sides are null, allow.
        if (owner === null && principal === null)
            return;
        if (owner !== principal) {
            throw new TaskOwnerMismatchError(state.id, owner, principal);
        }
    }
    async recordAudit(event) {
        if (!this.auditLog)
            return;
        try {
            await this.auditLog.record(event);
        }
        catch {
            /* never throw to caller */
        }
    }
}
function newTaskId() {
    return `tsk-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
/**
 * v2.3.1 (B2): estimate tokens for prompt + file bytes (4 chars/token heuristic).
 * Used by the rate-limit gate so multi-file forks don't slip past with a
 * prompt-only estimate. Mirrors checkContextLimit's byte accounting but
 * doesn't throw on oversize — the gate's job is allowance, not rejection.
 */
async function approxTokensWithFiles(prompt, files) {
    let totalChars = prompt.length;
    if (files?.length) {
        const { promises: fsp } = await import('fs');
        for (const f of files) {
            try {
                const stat = await fsp.stat(f);
                if (stat.isFile())
                    totalChars += stat.size;
            }
            catch {
                /* ignore unreadable files; adapter surfaces the error itself */
            }
        }
    }
    return Math.max(1, Math.ceil(totalChars / 4));
}
/** Human-readable rendering of a windowSec value, for error envelopes. */
function humanWindow(windowSec) {
    if (windowSec >= 86400 && windowSec % 86400 === 0)
        return `${windowSec / 86400}d`;
    if (windowSec >= 3600 && windowSec % 3600 === 0)
        return `${windowSec / 3600}h`;
    if (windowSec >= 60 && windowSec % 60 === 0)
        return `${windowSec / 60}min`;
    return `${windowSec}s`;
}
function probeActionable(adapter) {
    switch (adapter) {
        case 'claude':
            return 'Run `claude /login` to authenticate, or set ANTHROPIC_API_KEY in env.';
        case 'gemini':
            return 'Set GEMINI_API_KEY or GOOGLE_API_KEY in env (or enable Vertex via GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT).';
        case 'codex':
            return 'Run `codex login`, or set a valid OPENAI_API_KEY.';
    }
}
function projectState(state) {
    return {
        taskId: state.id,
        status: toExecStatus(state.status),
        adapter: state.adapter ?? 'unknown',
        createdAt: state.startTime ?? new Date(0).toISOString(),
        lastUpdatedAt: state.lastUpdatedAt ?? state.startTime ?? new Date(0).toISOString(),
        ttlMs: state.taskTtlMs ?? 0,
        detached: state.detached ?? false,
        principal: state.principal ?? null,
        idempotencyKey: state.idempotencyKey,
        parentChainId: state.parentChainId,
        result: state.result !== undefined || state.exitCode !== undefined
            ? {
                text: state.result ?? '',
                exitCode: state.exitCode ?? 0,
                durationMs: state.durationMs ?? 0,
                sessionId: state.sessionId,
                substitutedFrom: state.substitutedFrom,
            }
            : undefined,
        error: state.error,
    };
}
function toExecStatus(s) {
    switch (s) {
        case 'pending':
        case 'running':
        case 'working':
            return 'working';
        case 'input_required':
            return 'input_required';
        case 'complete':
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        default:
            return 'failed';
    }
}
// Re-export for tests / external consumers.
export { TERMINAL_STATUSES };
