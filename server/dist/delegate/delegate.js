/**
 * Delegate — single-subordinate threaded conversation handoff.
 *
 * Opens or continues a thread, dispatches one turn to the named adapter,
 * persists user + assistant turns to the ThreadStore, optionally closes the
 * thread, and returns the response.
 *
 * Resume strategy is per-adapter (declared on the Adapter):
 *  - 'native' adapters (codex): the orchestrator passes the prior assistant
 *    turn's sessionId; the adapter uses its CLI's resume primitive.
 *  - 'replay' adapters (claude, gemini): the orchestrator serializes prior
 *    turns into the prompt itself before invoking.
 *
 * v2.2: optional `async: true` mode (R4-D). When set, the Delegate routes
 * the call through the injected TaskExecutor and returns an AsyncDelegate
 * envelope ({taskId, status: 'working'}) instead of the synchronous
 * DelegateResponse. Callers poll via `tasks/get`, block via `tasks/result`,
 * or cancel via `tasks/cancel`. The synchronous path is unchanged.
 */
import { randomUUID } from 'crypto';
import { CredentialsNotSupportedError, } from '../core/taskExecutor.js';
const REMINDER_OPEN = 'Thread is open. Call delegate_close({threadId}) when this conversation is done. ' +
    'Idle threads are auto-swept after 6 hours.';
const REMINDER_CLOSED = 'Thread closed.';
const REMINDER_ASYNC = 'Async task created. Poll status via tasks/get({taskId}); fetch result via ' +
    'tasks/result({taskId}); cancel via tasks/cancel({taskId}). Idle tasks expire per ' +
    'category TTL (working/completed 60m, failed 10m, cancelled 5m).';
export class Delegate {
    adapters;
    threadStore;
    executor;
    auditLog;
    taskExecutor;
    constructor(adapters, threadStore, executor, auditLog, taskExecutor) {
        this.adapters = adapters;
        this.threadStore = threadStore;
        this.executor = executor;
        this.auditLog = auditLog;
        this.taskExecutor = taskExecutor;
    }
    /** Synchronous turn — returns the assistant response inline. */
    async run(req) {
        if (req.credentials !== undefined &&
            req.credentials !== '' &&
            req.credentials !== 'default') {
            throw new CredentialsNotSupportedError(req.credentials);
        }
        const adapter = this.adapters.get(req.adapter);
        if (!adapter) {
            const known = this.adapters.list().map((a) => a.id).join(', ');
            throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
        }
        const threadId = req.threadId ?? newThreadId();
        const wasNew = (await this.threadStore.read(threadId)).length === 0;
        await this.threadStore.open(threadId, adapter.id);
        if (wasNew) {
            await this.auditLog?.record({
                kind: 'thread.open',
                threadId,
                adapter: adapter.id,
            });
        }
        const history = await this.threadStore.read(threadId);
        let effectivePrompt = req.prompt;
        let sessionId;
        if (history.length > 0) {
            if (adapter.resumeStrategy === 'native') {
                sessionId = lastAssistantSessionId(history);
            }
            else {
                effectivePrompt = renderReplay(history, req.prompt);
            }
        }
        const userTurn = {
            ts: new Date().toISOString(),
            role: 'user',
            adapter: adapter.id,
            content: req.prompt,
        };
        await this.threadStore.append(threadId, userTurn);
        const result = await adapter.invoke({
            prompt: effectivePrompt,
            files: req.files,
            sessionId,
            cwd: req.cwd,
            timeoutMs: req.timeoutMs,
            intelligence: req.intelligence,
            model: req.model,
        }, this.executor);
        const assistantTurn = {
            ts: new Date().toISOString(),
            role: 'assistant',
            adapter: adapter.id,
            sessionId: result.sessionId,
            content: result.text,
            meta: { durationMs: result.durationMs, exitCode: result.exitCode },
        };
        await this.threadStore.append(threadId, assistantTurn);
        await this.auditLog?.record({
            kind: 'invoke',
            adapter: adapter.id,
            durationMs: result.durationMs,
            threadId,
            error: result.exitCode !== 0 ? `exit code ${result.exitCode}` : undefined,
        });
        const closed = !!req.close;
        if (closed) {
            await this.threadStore.close(threadId);
            await this.auditLog?.record({
                kind: 'thread.close',
                threadId,
                adapter: adapter.id,
            });
        }
        return {
            threadId,
            adapter: adapter.id,
            output: result.text,
            sessionId: result.sessionId,
            closed,
            // Each turn = one user + one assistant pair. After this call, history
            // length doubled. Turn number = (history.length / 2) + 1.
            turn: Math.floor(history.length / 2) + 1,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            reminder: closed ? REMINDER_CLOSED : REMINDER_OPEN,
        };
    }
    /**
     * Async turn (v2.2). Routes through the injected TaskExecutor; returns
     * `{taskId, status}` immediately. Subsequent polling/blocking happens via
     * `tasks/get`, `tasks/result`, `tasks/cancel`.
     *
     * Idempotency: if `req.idempotencyKey` is supplied and a non-terminal
     * task with the same `(idempotencyKey, principal)` exists, the existing
     * taskId is returned (R-DUR-D.3).
     */
    async runAsync(req) {
        if (!this.taskExecutor) {
            throw new Error('Async delegate requested but no TaskExecutor was injected.');
        }
        const adapter = this.adapters.get(req.adapter);
        if (!adapter) {
            const known = this.adapters.list().map((a) => a.id).join(', ');
            throw new Error(`Unknown adapter "${req.adapter}". Registered: ${known}`);
        }
        const state = await this.taskExecutor.start({
            adapter: req.adapter,
            prompt: req.prompt,
            files: req.files,
            intelligence: req.intelligence,
            model: req.model,
            timeoutMs: req.timeoutMs,
            cwd: req.cwd,
            idempotencyKey: req.idempotencyKey,
            detached: true, // async delegates are detached by default (independent of any chain)
            principal: req.principal ?? null,
            ttlMs: req.ttlMs,
            credentials: req.credentials,
            threadId: req.threadId,
            skill: req.skill,
            // v2.3 (F3-D.2, R-DIAG-D.4) — forward additive allowlist + preflight opt-in.
            ...(req.mcpServers !== undefined && { mcpServers: req.mcpServers }),
            ...(req.preflight !== undefined && { preflight: req.preflight }),
        });
        return {
            taskId: state.taskId,
            adapter: state.adapter,
            status: state.status,
            reminder: REMINDER_ASYNC,
        };
    }
}
function newThreadId() {
    // Short, file-system-safe thread id. Collisions are practically impossible
    // and the orchestrator is the only writer.
    return `t-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
function lastAssistantSessionId(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant' && history[i].sessionId) {
            return history[i].sessionId;
        }
    }
    return undefined;
}
function renderReplay(history, newPrompt) {
    const lines = ['<conversation>'];
    for (const t of history) {
        const tag = t.role === 'user' ? 'user' : 'assistant';
        lines.push(`<${tag}>`, t.content, `</${tag}>`);
    }
    lines.push('</conversation>');
    lines.push('');
    lines.push(newPrompt);
    return lines.join('\n');
}
