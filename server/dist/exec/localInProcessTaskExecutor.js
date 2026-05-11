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
            const probe = this.preflightAuthProbe(req.adapter, principal);
            if (!probe.ok) {
                throw new AdapterError({
                    kind: 'auth',
                    adapter: req.adapter,
                    model: resolvedModel,
                    summary: `${req.adapter} pre-flight auth probe failed${probe.detail ? `: ${probe.detail}` : ''}`,
                    actionable: probeActionable(req.adapter),
                });
            }
        }
        // 4.6. v2.3 (R6a-D.5): pre-flight rate-limit refuse. Look up the
        // auth-path-aware advisory; if rate-limited and we've already burned the
        // budget for this minute, throw AdapterError with kind:'rate-limit'.
        if (manifest && resolvedLimits?.rateLimit && resolvedTier) {
            const authPath = detectAuthPath(req.adapter);
            const advisory = resolvedLimits.rateLimit.byAuthPath[authPath] ??
                resolvedLimits.rateLimit.byAuthPath[resolvedLimits.rateLimit.default];
            if (advisory?.class === 'rate-limited' && advisory.cap) {
                const estTokens = Math.max(1, Math.ceil(req.prompt.length / 4));
                const allowedPerMin = Math.max(1, Math.floor(advisory.cap.tokens / estTokens / (advisory.cap.windowSec / 60)));
                const key = `${req.adapter}::${resolvedModel ?? '?'}::${authPath}::${principal ?? '<null>'}`;
                const now = this.now().getTime();
                const window = (advisory.cap.windowSec * 1000);
                const bucket = (this.recentSpawns.get(key) ?? []).filter((t) => now - t < window);
                if (bucket.length >= allowedPerMin) {
                    throw new AdapterError({
                        kind: 'rate-limit',
                        adapter: req.adapter,
                        model: resolvedModel,
                        summary: `Skipping fork: tier "${resolvedTier}" via auth-path "${authPath}" ` +
                            `supports ~${allowedPerMin} forks per ${Math.round(advisory.cap.windowSec / 60)}min ` +
                            `at ~${estTokens} tokens; ${bucket.length} already in flight this window.`,
                        actionable: `Reduce parallel forks, pin a different intelligence tier, or upgrade your ${authPath} quota.`,
                        details: {
                            allowedPerMin,
                            observed: bucket.length,
                            cap: advisory.cap,
                            authPath,
                        },
                    });
                }
                bucket.push(now);
                this.recentSpawns.set(key, bucket);
            }
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
            // codex: subscription (codex login) or OPENAI_API_KEY. Subscription is
            // checked via `~/.codex/auth.json` existence in v3; for v2.3 we trust
            // the user's setup and only fail-fast when env is empty.
            const hasKey = !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0;
            result = hasKey
                ? { ok: true, detail: 'api-key-present' }
                : { ok: true, detail: 'subscription-assumed' };
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
                completeTime,
                lastUpdatedAt: completeTime,
            });
            await this.recordAudit({
                kind: 'task.fail',
                taskId,
                adapter: adapter.id,
                durationMs: envelope?.durationMs ?? 0,
                error: errMsg,
            });
            await this.recordAudit({
                kind: 'invoke',
                adapter: adapter.id,
                durationMs: envelope?.durationMs ?? 0,
                threadId: childThreadId,
                error: errMsg,
            });
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
