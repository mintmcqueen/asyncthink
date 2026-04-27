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
 */
export const DEFAULT_TIERS = ['high', 'med', 'low'];
export function resolveModel(inv, tiers, defaultTier) {
    if (inv.model && inv.model.length > 0)
        return inv.model;
    const tier = inv.intelligence ?? defaultTier;
    const id = tiers[tier];
    if (!id || id.length === 0) {
        throw new Error(`Adapter has no model id for intelligence tier "${tier}". Tiers map: ${JSON.stringify(tiers)}`);
    }
    return id;
}
