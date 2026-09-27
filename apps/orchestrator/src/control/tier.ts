import { TIER_ORDER, clampTier, tierRank, type Task, type Tier } from "@analytax/contracts";
import type { AgentCard } from "../agents/registry.js";

const COMPLEXITY_OFFSET = { low: -1, medium: 0, high: 1 } as const;

/**
 * Tier for the next attempt: an explicit override (escalation/planner) or the card's default shifted by task
 * complexity (low → one tier cheaper, high → one tier stronger), always clamped to the card's allowed range.
 */
export function selectTier(task: Task, card: AgentCard): Tier {
  const { defaultTier, minTier, maxTier } = card.model;
  if (task.tierOverride) return clampTier(task.tierOverride, minTier, maxTier);
  const shifted = TIER_ORDER[Math.min(TIER_ORDER.length - 1, Math.max(0, tierRank(defaultTier) + COMPLEXITY_OFFSET[task.complexity]))];
  return clampTier(shifted ?? defaultTier, minTier, maxTier);
}
