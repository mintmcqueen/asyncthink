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
import { ContextLimitExceededError } from '../core/taskExecutor.js';
import { promises as fsp } from 'fs';
export const DEFAULT_TIERS = ['high', 'med', 'low'];
export class TierModelConflictError extends Error {
    intelligence;
    model;
    tierModel;
    tiers;
    constructor(intelligence, model, tierModel, tiers) {
        super(`Conflicting model selection: intelligence="${intelligence}" maps to "${tierModel}" but model="${model}" was also supplied. ` +
            `Drop one of the inputs, or pass model="${tierModel}" to confirm. Tiers: ${JSON.stringify(tiers)}`);
        this.intelligence = intelligence;
        this.model = model;
        this.tierModel = tierModel;
        this.tiers = tiers;
        this.name = 'TierModelConflictError';
    }
}
export function resolveModel(inv, tiers, defaultTier, opts = {}) {
    // Both supplied — error if they disagree, allow if they match.
    if (inv.model && inv.model.length > 0 && inv.intelligence) {
        const tierModel = tiers[inv.intelligence];
        if (tierModel !== inv.model) {
            throw new TierModelConflictError(inv.intelligence, inv.model, tierModel, tiers);
        }
        return {
            model: inv.model,
            tier: inv.intelligence,
            limits: opts.tierLimits?.[inv.intelligence],
        };
    }
    // Raw model only — escape hatch.
    if (inv.model && inv.model.length > 0) {
        const matchedTier = findTierForModel(inv.model, tiers);
        if (matchedTier) {
            return { model: inv.model, tier: matchedTier, limits: opts.tierLimits?.[matchedTier] };
        }
        // Out-of-tier raw model. Two paths:
        //   (a) substituteStaleSkillPin=true: skill-pin context; R6b-D.2 fires.
        //   (b) default: caller knows what they're doing; pass through verbatim,
        //       resolve to defaultTier limits as a sensible context-check basis.
        if (opts.substituteStaleSkillPin) {
            const substitute = tiers[defaultTier];
            const adapter = opts.adapterId ?? '<unknown>';
            const warn = opts.stderr ?? ((s) => console.error(s));
            warn(`[Adapter:${adapter}] Skill-pinned model "${inv.model}" is not in current tier map; ` +
                `substituting defaultTier "${defaultTier}" → "${substitute}". (R6b-D.2)`);
            if (opts.auditLog) {
                void opts.auditLog
                    .record({
                    kind: 'model.substitute',
                    adapter,
                    from: inv.model,
                    to: substitute,
                    tier: defaultTier,
                    reason: 'pinned-model-not-in-current-tiers',
                })
                    .catch(() => {
                    /* audit failures must not break dispatch */
                });
            }
            return {
                model: substitute,
                tier: defaultTier,
                substitutedFrom: inv.model,
                limits: opts.tierLimits?.[defaultTier],
            };
        }
        // Pass through verbatim; report the defaultTier's limits as the basis
        // for any context check.
        return {
            model: inv.model,
            tier: defaultTier,
            limits: opts.tierLimits?.[defaultTier],
        };
    }
    // Tier (caller-supplied or adapter default).
    const tier = inv.intelligence ?? defaultTier;
    const id = tiers[tier];
    if (!id || id.length === 0) {
        throw new Error(`Adapter has no model id for intelligence tier "${tier}". Tiers map: ${JSON.stringify(tiers)}`);
    }
    return { model: id, tier, limits: opts.tierLimits?.[tier] };
}
/**
 * Pre-flight context-size check (R6a-D.2). Counts approximate tokens in the
 * prompt + the byte-length of any `files` content (cheap heuristic, ~4
 * chars/token). Throws `ContextLimitExceededError` if the total exceeds the
 * resolved tier's `maxContext`.
 *
 * If `limits.maxContext` is undefined the check is a no-op (no advisory
 * available).
 */
export async function checkContextLimit(inv, tier, adapterId, limits) {
    if (!limits || limits.maxContext === undefined)
        return;
    let totalChars = inv.prompt.length;
    if (inv.files) {
        for (const f of inv.files) {
            try {
                const stat = await fsp.stat(f);
                if (stat.isFile())
                    totalChars += stat.size;
            }
            catch {
                // ignore; the adapter will surface the file error itself
            }
        }
    }
    const approxTokenCount = Math.ceil(totalChars / 4);
    if (approxTokenCount > limits.maxContext) {
        throw new ContextLimitExceededError({
            approxTokens: approxTokenCount,
            maxTokens: limits.maxContext,
            tier,
            adapter: adapterId,
        });
    }
}
function findTierForModel(model, tiers) {
    for (const tier of DEFAULT_TIERS) {
        if (tiers[tier] === model)
            return tier;
    }
    return undefined;
}
