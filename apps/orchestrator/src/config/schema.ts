import { HitlSettings, Tier } from "@analytax/contracts";
import { z } from "zod";

export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Exactly one of `level` (Gemini 3.x) or `budget` (Gemini 2.5); `{}` means "model default". */
export const ThinkingSpec = z.union([
  z.object({ level: z.enum(THINKING_LEVELS) }).strict(),
  z.object({ budget: z.number().int().min(-1) }).strict(),
  z.object({}).strict(),
]);
export type ThinkingSpec = z.infer<typeof ThinkingSpec>;

export const ModelSpec = z.object({
  model: z.string().min(1),
  thinking: ThinkingSpec,
});
export type ModelSpec = z.infer<typeof ModelSpec>;

export const TierSpec = ModelSpec.extend({
  maxConcurrency: z.number().int().positive(),
  contextTokens: z.number().int().positive(),
  alternate: ModelSpec.nullable().optional(),
});
export type TierSpec = z.infer<typeof TierSpec>;

export const ROLE_NAMES = ["intake", "planner", "replanner", "judge", "synthesizer", "search"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const ModelsConfig = z.object({
  provider: z.literal("google"),
  defaults: z.object({ maxOutputTokens: z.number().int().positive() }),
  tiers: z.object({
    deep: TierSpec,
    standard: TierSpec,
    fast: TierSpec,
    "fast-thinking": TierSpec,
  }),
  useAlternates: z.boolean(),
  roles: z.object(Object.fromEntries(ROLE_NAMES.map((role) => [role, Tier])) as Record<RoleName, typeof Tier>),
  pricing: z.record(z.string(), z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() })),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

const positiveInt = z.number().int().positive();

export const Guards = z.object({
  maxConcurrency: positiveInt,
  maxWaves: positiveInt,
  maxReplans: z.number().int().nonnegative(),
  maxHumanReviews: z.number().int().nonnegative(),
  maxAttempts: positiveInt,
  maxInfraRetries: z.number().int().nonnegative(),
  maxBlocks: z.number().int().nonnegative(),
  maxTotalTasks: positiveInt,
  maxInitialTasks: positiveInt,
  maxOpsPerPatch: positiveInt,
  maxSpawnDepth: z.number().int().nonnegative(),
  maxProposalsPerTask: z.number().int().nonnegative(),
  maxAutoSpawned: z.number().int().nonnegative(),
  maxRevisionsPerTask: z.number().int().nonnegative(),
  stallReplanAt: positiveInt,
  stallStopAt: positiveInt,
  growthFreeze: z.object({ outstanding: positiveInt, factor: z.number().positive(), windowWaves: positiveInt }),
  deadlineSec: positiveInt,
  maxClarifyRounds: z.number().int().nonnegative(),
});
export type Guards = z.infer<typeof Guards>;

export const OrchestratorConfig = z.object({
  guards: Guards,
  limits: z.object({ maxConcurrency: positiveInt, deadlineSec: positiveInt }),
  hitl: HitlSettings,
  evaluation: z.object({
    skipConfidence: z.number().min(0).max(1),
    degradedScore: z.number().min(0).max(1),
    maxOutputCharsForJudge: positiveInt,
  }),
  artifacts: z.object({ inlineMaxBytes: positiveInt }),
  paths: z.object({ agents: z.string().min(1), skills: z.array(z.string().min(1)) }),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfig>;
