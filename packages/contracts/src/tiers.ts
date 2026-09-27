import { TIERS, type Complexity, type Tier } from "./common.js";

/** Ordered escalation ladder: cheapest → most capable. */
export const TIER_ORDER: readonly Tier[] = TIERS;

export const tierRank = (tier: Tier): number => TIER_ORDER.indexOf(tier);

/** The next tier up the ladder, or null when already at (or above) `maxTier`. */
export function nextTier(tier: Tier, maxTier: Tier = "deep"): Tier | null {
  const next = TIER_ORDER[tierRank(tier) + 1];
  return next !== undefined && tierRank(next) <= tierRank(maxTier) ? next : null;
}

export function clampTier(tier: Tier, minTier: Tier, maxTier: Tier): Tier {
  const rank = Math.min(Math.max(tierRank(tier), tierRank(minTier)), tierRank(maxTier));
  return TIER_ORDER[rank] ?? tier;
}

export const COMPLEXITY_TIER: Readonly<Record<Complexity, Tier>> = {
  low: "fast",
  medium: "standard",
  high: "deep",
};
