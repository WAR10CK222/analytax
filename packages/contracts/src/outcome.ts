import { z } from "zod";
import { Source } from "./common.js";

export const ProposalKind = z.enum(["prerequisite", "follow_up", "decompose", "clarification"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const Proposal = z.object({
  kind: ProposalKind,
  title: z.string(),
  instructions: z.string(),
  capability: z.string(),
  rationale: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;

export const OutcomeStatus = z.enum(["completed", "partial", "blocked", "declined", "needs_input"]);
export type OutcomeStatus = z.infer<typeof OutcomeStatus>;

/** Normalized agent outcome used by the control plane. */
export const TaskOutcome = z.object({
  status: OutcomeStatus,
  summary: z.string(),
  output: z.string(),
  keyFindings: z.array(z.string()),
  sources: z.array(Source),
  confidence: z.number().min(0).max(1),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  proposals: z.array(Proposal),
});
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/**
 * LLM-facing schema (agent structured response). Deliberately flat: no unions, records or nullable objects,
 * so it stays inside Gemini's function-declaration schema subset.
 */
export const TaskOutcomeWire = z.object({
  status: OutcomeStatus.describe(
    "completed = fully done; partial = usable but incomplete; blocked = cannot finish until a missing prerequisite is done (add a 'prerequisite' proposal); declined = outside your role; needs_input = only the client can answer (list openQuestions)",
  ),
  summary: z
    .string()
    .describe("2-5 sentence summary of the result for downstream tasks (at most ~1000 characters)"),
  output: z.string().describe("The complete deliverable for this task, in Markdown"),
  keyFindings: z.array(z.string()).describe("The most important facts or conclusions, one per item"),
  sources: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().describe("Source URL, or an empty string when not a web source"),
      }),
    )
    .describe("Sources you actually used"),
  confidence: z.number().describe("0.0-1.0 confidence that the output meets every acceptance criterion"),
  assumptions: z.array(z.string()).describe("Assumptions you made (empty if none)"),
  openQuestions: z.array(z.string()).describe("Questions only the client can answer (empty if none)"),
  proposals: z
    .array(
      z.object({
        kind: ProposalKind.describe(
          "prerequisite = must happen before this task can be finished; follow_up = useful work after this task; decompose = this task should be split; clarification = needs client input",
        ),
        title: z.string(),
        instructions: z.string().describe("Self-contained instructions for whoever does the proposed work"),
        capability: z.string().describe("Capability needed, e.g. web_research, analysis, writing, review"),
        rationale: z.string(),
      }),
    )
    .describe("At most 3. Only propose work that is genuinely needed and not already in the plan outline"),
});
export type TaskOutcomeWire = z.infer<typeof TaskOutcomeWire>;

const cleanList = (items: readonly string[], max = 30): string[] =>
  items
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);

/** Normalizes a (possibly sloppy) model response into a `TaskOutcome`. */
export function outcomeFromWire(wire: TaskOutcomeWire): TaskOutcome {
  let confidence = Number.isFinite(wire.confidence) ? wire.confidence : 0;
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  return {
    status: wire.status,
    summary: wire.summary.trim().slice(0, 1200),
    output: wire.output,
    keyFindings: cleanList(wire.keyFindings, 20),
    sources: wire.sources
      .map((source) => ({ title: source.title.trim(), url: source.url.trim() }))
      .filter((source) => source.title || source.url)
      .map((source) => ({ title: source.title || source.url, url: source.url || null })),
    confidence: Math.min(1, Math.max(0, confidence)),
    assumptions: cleanList(wire.assumptions),
    openQuestions: cleanList(wire.openQuestions),
    proposals: wire.proposals
      .filter((proposal) => proposal.title.trim() && proposal.instructions.trim())
      .slice(0, 3)
      .map((proposal) => ({
        kind: proposal.kind,
        title: proposal.title.trim(),
        instructions: proposal.instructions.trim(),
        capability: proposal.capability.trim(),
        rationale: proposal.rationale.trim(),
      })),
  };
}
