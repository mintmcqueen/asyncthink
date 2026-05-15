export class TaskNotFoundError extends Error {
    constructor(taskId) {
        super(`Task "${taskId}" not found.`);
        this.name = 'TaskNotFoundError';
    }
}
export class TaskOwnerMismatchError extends Error {
    constructor(taskId, owner, requester) {
        super(`Task "${taskId}" is owned by "${owner ?? '<null>'}" but the requester is "${requester ?? '<null>'}".`);
        this.name = 'TaskOwnerMismatchError';
    }
}
export class CredentialsNotSupportedError extends Error {
    constructor(profile) {
        super(`Credential profile "${profile}" is not supported in v2.2. Per-delegate credentials are reserved for v3 ` +
            `(see R-CRED-D.2). Drop the credentials argument or pass "default".`);
        this.name = 'CredentialsNotSupportedError';
    }
}
// v2.3 — ContextLimitExceededError is now a subclass of AdapterError (R-DIAG-D.6).
// Re-exported here so existing imports keep working; new code should import from
// '../core/adapterError.js' directly.
export { ContextLimitExceededError } from './adapterError.js';
/** Category-wise TTL caps (R-DUR-D.4). All values in ms. */
export const CATEGORY_TTL_MS = {
    working: 60 * 60_000, // 60 minutes
    input_required: 60 * 60_000,
    completed: 60 * 60_000,
    failed: 10 * 60_000,
    cancelled: 5 * 60_000,
};
/** Caller-supplied TTL clamps (R-DUR-D.4). */
export const TTL_MIN_MS = 60_000; // 60s
export const TTL_DEFAULT_MS = CATEGORY_TTL_MS.completed;
export function clampTtl(requested) {
    if (requested === undefined || !Number.isFinite(requested))
        return TTL_DEFAULT_MS;
    return Math.max(TTL_MIN_MS, Math.min(TTL_DEFAULT_MS, requested));
}
/** Approximate token count from text length (4 chars ≈ 1 token heuristic). */
export function approxTokens(text) {
    return Math.ceil(text.length / 4);
}
