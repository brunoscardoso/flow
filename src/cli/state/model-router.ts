import type { PlanPhase, ModelTier, ModelTierLevel } from './types.js';

/**
 * The model every phase runs on when routing is OFF (the default):
 * the most capable model of the active provider. Provider-agnostic
 * alias — the executing runner resolves it (opus for Anthropic).
 */
export const MOST_CAPABLE_MODEL = 'opus';

/** A provider's fast / standard / powerful model ids (multi_runtime_support). */
export interface ProviderTierModels {
  fast: string;
  standard: string;
  powerful: string;
}

/**
 * Per-provider tier→model maps (multi_runtime_support). Claude preserves the
 * ORIGINAL haiku/sonnet/opus mapping exactly, so routing behaviour for existing
 * users is unchanged. Providers whose concrete model ids are install/profile
 * specific — Codex resolves its model from `-c model=` / profiles, not a fixed
 * lineup — register no map here; the runtime maps the returned TIER to its own
 * model. Unknown providers fall back to Claude's map so routing still yields a
 * tier.
 */
export const PROVIDER_TIER_MODELS: Record<string, ProviderTierModels> = {
  claude: { fast: 'haiku', standard: 'sonnet', powerful: 'opus' },
};

/** The tier→model map for a provider (defaults to Claude; unknown → Claude). */
export function tierModelsFor(provider: string = 'claude'): ProviderTierModels {
  return PROVIDER_TIER_MODELS[provider] ?? PROVIDER_TIER_MODELS.claude;
}

/**
 * Map a complexity score to a model tier and model name, for a provider.
 *
 * - 0-3  -> fast     (Claude: haiku)
 * - 4-5  -> standard (Claude: sonnet)
 * - 6-10 -> powerful (Claude: opus)
 *
 * `provider` defaults to `'claude'`, so the two-arg callers below are behaviour
 * identical to before this became provider-aware.
 */
function complexityToTier(
  complexity: number,
  provider: string = 'claude',
): { tier: ModelTierLevel; model: string } {
  const tiers = tierModelsFor(provider);
  if (complexity <= 3) {
    return { tier: 'fast', model: tiers.fast };
  }
  if (complexity <= 5) {
    return { tier: 'standard', model: tiers.standard };
  }
  return { tier: 'powerful', model: tiers.powerful };
}

/**
 * Calculate model tiers for each plan phase based on complexity scores.
 *
 * Returns an empty array when model routing is disabled. `provider` defaults to
 * `'claude'` — a plain two-arg call is unchanged from before this generalized.
 */
export function calculateModelTiers(
  phases: PlanPhase[],
  modelRoutingEnabled: boolean,
  provider: string = 'claude',
): ModelTier[] {
  if (!modelRoutingEnabled) {
    return [];
  }

  return phases.map((phase) => {
    const { tier, model } = complexityToTier(phase.complexity, provider);
    return {
      phase: phase.number,
      complexity: phase.complexity,
      tier,
      model,
    };
  });
}
