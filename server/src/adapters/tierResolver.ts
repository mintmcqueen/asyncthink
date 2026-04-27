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

export const DEFAULT_TIERS: IntelligenceTier[] = ['high', 'med', 'low'];

export class TierModelConflictError extends Error {
  constructor(
    public readonly intelligence: IntelligenceTier,
    public readonly model: string,
    public readonly tierModel: string,
    public readonly tiers: Record<IntelligenceTier, string>
  ) {
    super(
      `Conflicting model selection: intelligence="${intelligence}" maps to "${tierModel}" but model="${model}" was also supplied. ` +
        `Drop one of the inputs, or pass model="${tierModel}" to confirm. Tiers: ${JSON.stringify(tiers)}`
    );
    this.name = 'TierModelConflictError';
  }
}

export function resolveModel(
  inv: AdapterInvocation,
  tiers: Record<IntelligenceTier, string>,
  defaultTier: IntelligenceTier
): string {
  // Both supplied — error if they disagree, allow if they match.
  if (inv.model && inv.model.length > 0 && inv.intelligence) {
    const tierModel = tiers[inv.intelligence];
    if (tierModel !== inv.model) {
      throw new TierModelConflictError(inv.intelligence, inv.model, tierModel, tiers);
    }
    return inv.model;
  }
  // Raw model only — escape hatch.
  if (inv.model && inv.model.length > 0) return inv.model;
  // Tier (caller-supplied or adapter default).
  const tier: IntelligenceTier = inv.intelligence ?? defaultTier;
  const id = tiers[tier];
  if (!id || id.length === 0) {
    throw new Error(
      `Adapter has no model id for intelligence tier "${tier}". Tiers map: ${JSON.stringify(tiers)}`
    );
  }
  return id;
}
