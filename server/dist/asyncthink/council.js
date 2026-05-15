/**
 * Council — parallel competitor forks for an asyncthink chain.
 *
 * Each chain has a parentThreadId. Forks within the chain are child threads
 * named `<parentThreadId>::<forkId>`. Tasks in the TaskStore use the same
 * scoping so concurrent chains do not collide.
 *
 * Forks are fire-and-forget: `fork()` returns immediately after registering
 * the in-flight promise. Results land in the TaskStore as the adapter
 * promises resolve. Callers retrieve results via `getResult` or block until
 * complete via `waitFor`. On chain end, `endChain` waits for any remaining
 * in-flight forks (up to a timeout), closes all child threads, and prunes
 * the chain's tasks from the store.
 */
import { randomUUID } from 'crypto';
import { AdapterError } from '../core/adapterError.js';
import { resolveModel } from '../adapters/tierResolver.js';
export class Council {
    adapters;
    threadStore;
    taskStore;
    executor;
    auditLog;
    gates;
    manifests;
    inflight = new Map();
    constructor(adapters, threadStore, taskStore, executor, auditLog, 
    /**
     * v2.3.1 (H1+H2): optional pre-flight gates. When wired (via app.ts),
     * sync forks honor `preflight: 'auth'` and the R6a-D.5 rate-limit refuse.
     * Tests that build Council directly without gates keep working.
     */
    gates, manifests) {
        this.adapters = adapters;
        this.threadStore = threadStore;
        this.taskStore = taskStore;
        this.executor = executor;
        this.auditLog = auditLog;
        this.gates = gates;
        this.manifests = manifests;
    }
    newChain() {
        return `chain-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    }
    /** Spawn a fork. Resolves once the task is registered (not when it completes). */
    async fork(req) {
        const adapter = this.adapters.get(req.adapter);
        if (!adapter) {
            const known = this.adapters.list().map((a) => a.id).join(', ');
            throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
        }
        const taskId = this.scopeId(req.parentThreadId, req.id);
        if (await this.taskStore.get(taskId)) {
            throw new Error(`Fork id "${req.id}" already exists in chain ${req.parentThreadId}`);
        }
        await this.taskStore.create(taskId, req.prompt);
        await this.taskStore.update(taskId, {
            status: 'running',
            forkThought: req.thoughtNumber,
            adapter: req.adapter,
        });
        const childThreadId = taskId;
        const promise = this.runFork(adapter, childThreadId, taskId, req).finally(() => {
            this.inflight.delete(taskId);
        });
        this.inflight.set(taskId, promise);
    }
    async runFork(adapter, childThreadId, taskId, req) {
        try {
            // v2.3.1 (H1+H2): apply the pre-flight gates if the executor was wired
            // through. Auth gate runs when req.preflight==='auth'. Rate-limit gate
            // runs unconditionally for rate-limited tier cells; throws AdapterError
            // when over budget so the catch below classifies it as a typed failure.
            let rateLimitSlotPush;
            if (this.gates) {
                if (req.preflight === 'auth') {
                    this.gates.applyAuthGate(req.adapter, null /* v2.2 single-tenant */, req.model);
                }
                const manifest = this.manifests ? await this.manifests.get(req.adapter) : undefined;
                if (manifest) {
                    const resolved = resolveModel({ prompt: req.prompt, intelligence: req.intelligence, model: req.model, files: req.files }, manifest.tiers, manifest.defaultTier, { adapterId: req.adapter, tierLimits: manifest.tierLimits });
                    if (resolved.limits?.rateLimit) {
                        rateLimitSlotPush = await this.gates.applyRateLimitGate({
                            adapter: req.adapter,
                            prompt: req.prompt,
                            files: req.files,
                            principal: null,
                            resolvedModel: resolved.model,
                            resolvedTier: resolved.tier,
                            rateLimit: resolved.limits.rateLimit,
                            // v2.3.3 — forward caller flexibility levers.
                            authPathOverride: req.authPath,
                            bypassRateLimit: req.bypassRateLimit,
                        });
                        // v2.3.3: bypass audit event paired with the fork's taskId.
                        if (req.bypassRateLimit) {
                            await this.auditLog?.record({
                                kind: 'task.bypass_rate_limit',
                                taskId,
                                adapter: req.adapter,
                                authPath: req.authPath,
                                reason: 'council-fork-opt-out',
                            });
                        }
                    }
                }
            }
            await this.threadStore.open(childThreadId, adapter.id);
            await this.auditLog?.record({
                kind: 'thread.open',
                threadId: childThreadId,
                adapter: adapter.id,
            });
            await this.threadStore.append(childThreadId, {
                ts: new Date().toISOString(),
                role: 'user',
                adapter: adapter.id,
                content: req.prompt,
            });
            const result = await adapter.invoke({
                prompt: req.prompt,
                files: req.files,
                intelligence: req.intelligence,
                model: req.model,
                // v2.3 (F3-D.2) — additive MCP-server allowlist passes through.
                mcpServers: req.mcpServers,
            }, this.executor);
            // v2.3.1 (B2): consume the rate-limit slot only after invoke succeeds.
            if (rateLimitSlotPush)
                rateLimitSlotPush();
            await this.threadStore.append(childThreadId, {
                ts: new Date().toISOString(),
                role: 'assistant',
                adapter: adapter.id,
                sessionId: result.sessionId,
                content: result.text,
                meta: { durationMs: result.durationMs, exitCode: result.exitCode },
            });
            await this.taskStore.update(taskId, {
                status: result.exitCode === 0 ? 'complete' : 'failed',
                result: result.text,
                error: result.exitCode !== 0 ? `exit code ${result.exitCode}` : undefined,
                durationMs: result.durationMs,
            });
            await this.auditLog?.record({
                kind: 'invoke',
                adapter: adapter.id,
                durationMs: result.durationMs,
                threadId: childThreadId,
                error: result.exitCode !== 0 ? `exit code ${result.exitCode}` : undefined,
            });
        }
        catch (err) {
            // v2.3 (F3-D.4 / R-DIAG-D.1): treat AdapterError-throwing adapters as
            // typed failures. Persist kind + actionable into TaskState for the
            // council aggregation surface.
            const message = err instanceof Error ? err.message : String(err);
            let errorKind;
            let errorActionable;
            if (err instanceof AdapterError) {
                errorKind = err.kind;
                errorActionable = err.actionable;
            }
            await this.taskStore.update(taskId, {
                status: 'failed',
                error: message,
                errorKind,
                errorActionable,
            });
            await this.auditLog?.record({
                kind: 'invoke',
                adapter: adapter.id,
                durationMs: 0,
                threadId: childThreadId,
                error: message,
            });
        }
    }
    /** Wait for any of the named forks (chain-scoped) to settle, up to timeoutMs. */
    async waitFor(forkIds, parentThreadId, timeoutMs) {
        const promises = forkIds
            .map((id) => this.inflight.get(this.scopeId(parentThreadId, id)))
            .filter((p) => p !== undefined);
        if (promises.length === 0)
            return;
        await Promise.race([
            Promise.allSettled(promises),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
    }
    async getResult(forkId, parentThreadId) {
        const state = await this.taskStore.get(this.scopeId(parentThreadId, forkId));
        if (!state)
            return undefined;
        return resultFromTask(state, forkId, parentThreadId);
    }
    async chainStatus(parentThreadId) {
        const prefix = `${parentThreadId}::`;
        const trim = (id) => id.slice(prefix.length);
        const pending = [];
        const complete = [];
        const failed = [];
        for (const t of await this.taskStore.byStatus('pending')) {
            if (t.id.startsWith(prefix))
                pending.push(trim(t.id));
        }
        for (const t of await this.taskStore.byStatus('running')) {
            if (t.id.startsWith(prefix))
                pending.push(trim(t.id));
        }
        for (const t of await this.taskStore.byStatus('complete')) {
            if (t.id.startsWith(prefix))
                complete.push(trim(t.id));
        }
        for (const t of await this.taskStore.byStatus('failed')) {
            if (t.id.startsWith(prefix))
                failed.push(trim(t.id));
        }
        return { pending, complete, failed };
    }
    /**
     * Wait for non-detached forks in the chain, close their child threads,
     * prune their tasks. Detached forks (R-DUR-D.1) are immune: they survive
     * past chain end and are reaped by the TTL sweeper.
     */
    async endChain(parentThreadId, timeoutMs) {
        const prefix = `${parentThreadId}::`;
        // Collect detached task ids so we exclude them from chain-end work.
        const detachedIds = new Set();
        if (this.taskStore.list) {
            for (const t of await this.taskStore.list()) {
                if (t.id.startsWith(prefix) && t.detached === true) {
                    detachedIds.add(t.id);
                }
            }
        }
        const promises = [];
        for (const [tid, p] of this.inflight) {
            if (tid.startsWith(prefix) && !detachedIds.has(tid))
                promises.push(p);
        }
        if (promises.length > 0) {
            await Promise.race([
                Promise.allSettled(promises),
                new Promise((resolve) => setTimeout(resolve, timeoutMs)),
            ]);
        }
        const results = [];
        for (const status of [
            'complete',
            'completed',
            'failed',
            'running',
            'working',
            'pending',
        ]) {
            for (const t of await this.taskStore.byStatus(status)) {
                if (!t.id.startsWith(prefix))
                    continue;
                if (detachedIds.has(t.id))
                    continue;
                const forkId = t.id.slice(prefix.length);
                const r = resultFromTask(t, forkId, parentThreadId);
                if (r)
                    results.push(r);
            }
        }
        // Close child threads (non-detached only).
        for (const t of await this.threadStore.list()) {
            if (!t.threadId.startsWith(prefix))
                continue;
            if (detachedIds.has(t.threadId))
                continue;
            await this.threadStore.close(t.threadId);
            await this.auditLog?.record({
                kind: 'thread.close',
                threadId: t.threadId,
                adapter: t.adapter,
            });
        }
        // Prune tasks from the store.
        for (const r of results) {
            await this.taskStore.delete(this.scopeId(parentThreadId, r.id));
        }
        return results;
    }
    scopeId(parentThreadId, forkId) {
        return `${parentThreadId}::${forkId}`;
    }
}
function resultFromTask(state, forkId, _parentThreadId) {
    return {
        id: forkId,
        adapter: state.adapter ?? 'unknown',
        output: state.result ?? '',
        status: state.status,
        error: state.error,
        durationMs: state.durationMs,
        errorKind: state.errorKind,
        errorActionable: state.errorActionable,
    };
}
