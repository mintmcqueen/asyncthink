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
export class Council {
    adapters;
    threadStore;
    taskStore;
    executor;
    auditLog;
    inflight = new Map();
    constructor(adapters, threadStore, taskStore, executor, auditLog) {
        this.adapters = adapters;
        this.threadStore = threadStore;
        this.taskStore = taskStore;
        this.executor = executor;
        this.auditLog = auditLog;
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
            }, this.executor);
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
            const message = err instanceof Error ? err.message : String(err);
            await this.taskStore.update(taskId, {
                status: 'failed',
                error: message,
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
    };
}
