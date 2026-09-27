import { z } from "zod";

/** Intake analysis. Flat enough to be used directly as the LLM response schema. */
export const IntentAnalysis = z.object({
  goal: z.string().describe("The client's underlying goal in one sentence"),
  intentType: z.enum(["question", "research", "analysis", "creation", "multi"]),
  deliverable: z.object({
    format: z.string().describe("e.g. 'direct answer', 'comparison table + recommendation', 'report'"),
    audience: z.string().describe("Who the answer is for; 'general' if unknown"),
    length: z.enum(["short", "medium", "long"]),
  }),
  constraints: z.array(z.string()).describe("Explicit constraints from the query (scope, timeframe, format...)"),
  complexity: z
    .enum(["trivial", "low", "medium", "high"])
    .describe("trivial = one quick fact/answer; low = single focused task; medium = a few steps; high = multi-step research/analysis"),
  path: z.enum(["direct", "plan"]).describe("direct = one agent can answer alone; plan = needs multiple tasks"),
  suggestedCapability: z.string().describe("For the direct path: best capability, e.g. general_qa, web_research"),
  ambiguity: z.object({
    isAmbiguous: z.boolean().describe("True only if a reasonable answer is impossible without clarification"),
    questions: z.array(z.string()).describe("At most 3 clarifying questions (empty if not ambiguous)"),
  }),
});
export type IntentAnalysis = z.infer<typeof IntentAnalysis>;
