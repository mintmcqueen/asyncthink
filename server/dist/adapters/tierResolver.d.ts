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
 * has expressed contradictory intent (e.g. `{intelligence: 'low', model:
 * 'claude-opus-4-7'}` says "be cheap" and "use the expensive model" at
 * once). We throw with both inputs and the resolved tier→model so the
 * caller can drop one or align them. If both are supplied and they agree,
 * the call is allowed.
 */
import type { AdapterInvocation } from '../core/adapter.js';
import type { IntelligenceTier } from '../core/manifests.js';
export declare const DEFAULT_TIERS: IntelligenceTier[];
export declare class TierModelConflictError extends Error {
    readonly intelligence: IntelligenceTier;
    readonly model: string;
    readonly tierModel: string;
    readonly tiers: Record<IntelligenceTier, string>;
    constructor(intelligence: IntelligenceTier, model: string, tierModel: string, tiers: Record<IntelligenceTier, string>);
}
export declare function resolveModel(inv: AdapterInvocation, tiers: Record<IntelligenceTier, string>, defaultTier: IntelligenceTier): string;
