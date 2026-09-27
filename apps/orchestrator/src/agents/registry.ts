import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EvaluationMode, Tier, tierRank, type AgentCardSummary } from "@analytax/contracts";
import matter from "gray-matter";
import { z } from "zod";
import { parseToolRef } from "../mcp/refs.js";
import type { AgentDirectory } from "../planning/apply-plan-ops.js";

export const AgentCardFrontmatter = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "id must be lowercase letters, digits, '-' or '_'"),
  name: z.string().min(1),
  description: z.string().min(1),
  persona: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  tools: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
  model: z
    .object({ defaultTier: Tier, minTier: Tier, maxTier: Tier })
    .refine(
      (model) => tierRank(model.minTier) <= tierRank(model.defaultTier) && tierRank(model.defaultTier) <= tierRank(model.maxTier),
      "model tiers must satisfy minTier ≤ defaultTier ≤ maxTier",
    ),
  limits: z.object({
    modelCalls: z.number().int().positive(),
    toolCalls: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  evaluation: EvaluationMode.default("auto"),
});

export type AgentCard = z.infer<typeof AgentCardFrontmatter> & {
  /** Markdown body of the card: the agent's job prompt. */
  jobPrompt: string;
  file: string;
};

export class AgentConfigError extends Error {
  override name = "AgentConfigError";
}

export function parseAgentCard(file: string, content: string): AgentCard {
  const parsed = matter(content);
  const result = AgentCardFrontmatter.safeParse(parsed.data);
  if (!result.success) throw new AgentConfigError(`Invalid agent card ${file}:\n${z.prettifyError(result.error)}`);
  const jobPrompt = parsed.content.trim();
  if (!jobPrompt) throw new AgentConfigError(`Agent card ${file} has an empty job prompt`);
  return { ...result.data, jobPrompt, file };
}

export interface AgentValidationContext {
  toolNames: ReadonlySet<string>;
  hasSkill: (name: string) => boolean;
  /** Server ids from config/mcp.yaml, for `mcp:<server>/<tool>` refs (disabled servers count as known). */
  mcpServers?: ReadonlySet<string>;
}

export class AgentRegistry implements AgentDirectory {
  private readonly cards: Map<string, AgentCard>;

  constructor(cards: readonly AgentCard[]) {
    this.cards = new Map();
    for (const card of cards) {
      if (this.cards.has(card.id)) throw new AgentConfigError(`Duplicate agent id '${card.id}' (${card.file})`);
      this.cards.set(card.id, card);
    }
  }

  /** Loads every `*.agent.md` in `dir` and fails fast on unknown tools/skills. */
  static load(dir: string, validation: AgentValidationContext): AgentRegistry {
    if (!existsSync(dir)) throw new AgentConfigError(`Agents directory not found: ${dir}`);
    const cards = readdirSync(dir)
      .filter((file) => file.endsWith(".agent.md"))
      .sort()
      .map((file) => parseAgentCard(path.join(dir, file), readFileSync(path.join(dir, file), "utf8")));
    if (cards.length === 0) throw new AgentConfigError(`No *.agent.md files found in ${dir}`);
    const problems: string[] = [];
    for (const card of cards) {
      for (const tool of card.tools) {
        const ref = parseToolRef(tool);
        if (ref.kind === "invalid") problems.push(`${card.id}: invalid tool '${tool}' (${ref.reason})`);
        else if (ref.kind === "mcp" && !validation.mcpServers?.has(ref.server)) {
          problems.push(`${card.id}: tool '${tool}' uses MCP server '${ref.server}', which is not in config/mcp.yaml`);
        } else if (ref.kind === "builtin" && !validation.toolNames.has(tool)) problems.push(`${card.id}: unknown tool '${tool}'`);
      }
      for (const skill of card.skills) if (!validation.hasSkill(skill)) problems.push(`${card.id}: unknown skill '${skill}'`);
    }
    if (problems.length > 0) throw new AgentConfigError(`Agent card validation failed:\n- ${problems.join("\n- ")}`);
    return new AgentRegistry(cards);
  }

  has(agentId: string): boolean {
    return this.cards.has(agentId);
  }

  get(agentId: string): AgentCard | undefined {
    return this.cards.get(agentId);
  }

  require(agentId: string): AgentCard {
    const card = this.cards.get(agentId);
    if (!card) throw new AgentConfigError(`Unknown agent '${agentId}'`);
    return card;
  }

  list(): AgentCard[] {
    return [...this.cards.values()];
  }

  capabilitiesOf(agentId: string): readonly string[] {
    return this.cards.get(agentId)?.capabilities ?? [];
  }

  tierRange(agentId: string): { minTier: Tier; maxTier: Tier } | null {
    const card = this.cards.get(agentId);
    return card ? { minTier: card.model.minTier, maxTier: card.model.maxTier } : null;
  }

  withCapability(capability: string): AgentCard[] {
    return this.list()
      .filter((card) => card.capabilities.includes(capability))
      .sort(
        (a, b) =>
          a.capabilities.indexOf(capability) - b.capabilities.indexOf(capability) ||
          a.capabilities.length - b.capabilities.length ||
          a.id.localeCompare(b.id),
      );
  }

  /** Best specialist for a capability: primary capability first, then the most focused card. */
  bestFor(capability: string, exclude: Iterable<string> = []): AgentCard | null {
    const excluded = new Set(exclude);
    return this.withCapability(capability).find((card) => !excluded.has(card.id)) ?? null;
  }

  fallback(): AgentCard | null {
    return this.bestFor("fallback") ?? this.bestFor("general_qa");
  }

  allCapabilities(): string[] {
    return [...new Set(this.list().flatMap((card) => card.capabilities))].sort();
  }

  /**
   * Compact directory the planner uses to assign tasks. `describeTools` replaces the raw tool list so the planner sees
   * which MCP tools are actually available in this run.
   */
  directoryPrompt(describeSkill: (name: string) => string | undefined, describeTools?: (card: AgentCard) => string): string {
    return this.list()
      .map((card) => {
        const skills = card.skills.map((skill) => `${skill}${describeSkill(skill) ? ` (${describeSkill(skill)})` : ""}`);
        return [
          `### ${card.id} — ${card.name}`,
          card.description,
          `- capabilities: ${card.capabilities.join(", ")}`,
          `- tools: ${describeTools ? describeTools(card) : card.tools.length ? card.tools.join(", ") : "none"}`,
          `- skills: ${skills.length ? skills.join("; ") : "none"}`,
          `- model tiers: default ${card.model.defaultTier}, range ${card.model.minTier}–${card.model.maxTier}`,
        ].join("\n");
      })
      .join("\n\n");
  }

  summaries(): AgentCardSummary[] {
    return this.list().map((card) => ({
      id: card.id,
      name: card.name,
      description: card.description,
      persona: card.persona,
      capabilities: card.capabilities,
      tools: card.tools,
      skills: card.skills,
      model: card.model,
      evaluation: card.evaluation,
    }));
  }
}
