/**
 * Per-adapter intelligence-tier resolution.
 *
 * Resolution precedence (highest → lowest):
 *   1. Caller's raw `inv.model` — escape hatch, always wins
 *   2. Caller's `inv.intelligence` tier mapped via the adapter's tiers
 *   3. The adapter's `defaultTier` mapped via the adapter's tiers
 *
 * The tiers map is the single source of truth for "what model id does this
 * adapter currently advertise as high/med/low". Updating defaults across
 * the stack means editing one JSON file (the manifest) per adapter. Callers
 * pin to tiers, not to model names that age out.
 *
 * Conflict detection (F1): if the caller supplies BOTH `inv.intelligence`
 * AND `inv.model`, and the model id at that tier in the adapter's manifest
 * does NOT equal `inv.model`, this is a configuration mistake — the caller
 * has expressed contradictory intent. We throw with both inputs and the
 * resolved tier→model so the caller can drop one or align them. If both
 * are supplied and they agree, the call is allowed.
 *
 * v2.2 additions:
 *   - Pre-flight context-size check against `tierLimits[tier].maxContext`
 *     (R6a-D.2). Throws `ContextLimitExceededError` if exceeded.
 *   - Successor-model substitution (R6b-D.2): if a raw `inv.model` is no
 *     longer in the adapter's `tiers` map (i.e. the model has been retired
 *     from the manifest), we warn + substitute the adapter's `defaultTier`
 *     model and emit a `model.substitute` audit event. The conflict-detect
 *     path (F1) takes precedence: if both `intelligence` and `model` are
 *     supplied and they don't match, that's still a hard error regardless
 *     of whether the pinned model is current.
 */
import type { AdapterInvocation } from '../core/adapter.js';
import type { AuditLog } from '../core/auditLog.js';
import type { IntelligenceTier, TierLimits } from '../core/manifests.js';
export declare const DEFAULT_TIERS: IntelligenceTier[];
export declare class TierModelConflictError extends Error {
    readonly intelligence: IntelligenceTier;
    readonly model: string;
    readonly tierModel: string;
    readonly tiers: Record<IntelligenceTier, string>;
    constructor(intelligence: IntelligenceTier, model: string, tierModel: string, tiers: Record<IntelligenceTier, string>);
}
export interface ResolveModelOptions {
    /** Adapter id, only used in audit-log lines. */
    adapterId?: string;
    /** Per-tier facts (max context, etc.) for pre-flight checks (R6a-D.2). */
    tierLimits?: Partial<Record<IntelligenceTier, TierLimits>>;
    /** Optional audit log; receives `model.substitute` on R6b-D.2 substitution. */
    auditLog?: AuditLog;
    /** Override clock for tests. */
    now?: () => Date;
    /** stderr writer (warnings go here). */
    stderr?: (s: string) => void;
    /**
     * v2.2 — when true (skill-pin context only), an out-of-tier raw `model`
     * triggers R6b-D.2 successor substitution. Default false: raw model is an
     * escape hatch that's preserved verbatim.
     */
    substituteStaleSkillPin?: boolean;
}
export interface ResolveModelResult {
    /** Final model id to invoke. */
    model: string;
    /** Tier the model resolves to (or defaultTier if substituted). */
    tier: IntelligenceTier;
    /** Original raw model id supplied by the caller, if it was substituted out. */
    substitutedFrom?: string;
    /** TierLimits entry for the resolved tier (if any). */
    limits?: TierLimits;
}
export declare function resolveModel(inv: AdapterInvocation, tiers: Record<IntelligenceTier, string>, defaultTier: IntelligenceTier, opts?: ResolveModelOptions): ResolveModelResult;
/**
 * Pre-flight context-size check (R6a-D.2). Counts approximate tokens in the
 * prompt + the byte-length of any `files` content (cheap heuristic, ~4
 * chars/token). Throws `ContextLimitExceededError` if the total exceeds the
 * resolved tier's `maxContext`.
 *
 * If `limits.maxContext` is undefined the check is a no-op (no advisory
 * available).
 */
export declare function checkContextLimit(inv: AdapterInvocation, tier: IntelligenceTier, adapterId: string, limits: TierLimits | undefined): Promise<void>;
