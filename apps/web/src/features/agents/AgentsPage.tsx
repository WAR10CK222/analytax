import { TIERS, tierRank, type AgentCardSummary, type CatalogResponse, type Tier } from "@analytax/contracts";
import { useEffect } from "react";
import { useCatalogContext } from "../../app/catalog";
import { useRunSession } from "../../app/session";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "../../components/ui/Disclosure";
import { IconRetry } from "../../components/ui/icons";
import { Card, Callout, EmptyState, KeyValues, Section, Skeleton } from "../../components/ui/Surface";
import { API_URL } from "../../lib/api";
import { formatTokens, pluralize } from "../../lib/format";
import { TIER_LABEL, humanizeKey } from "../../lib/status";
import { groupAgentTools } from "../../view-models/mcp";
import { ToolServersPanel } from "./ToolServersPanel";

const EVALUATION_LABEL: Record<AgentCardSummary["evaluation"], string> = {
  auto: "Reviewed when the task is risky",
  always: "Every result is reviewed",
  never: "Results are not reviewed",
};

const ROLE_LABEL: Record<string, string> = {
  intake: "Understands the request",
  planner: "Writes the plan",
  replanner: "Revises the plan",
  judge: "Reviews results",
  synthesizer: "Writes the final answer",
  search: "Runs web searches",
};

function tierRange(agent: AgentCardSummary): Tier[] {
  return TIERS.filter((tier) => tierRank(tier) >= tierRank(agent.model.minTier) && tierRank(tier) <= tierRank(agent.model.maxTier));
}

function AgentCard({ agent, catalog, totals }: { agent: AgentCardSummary; catalog: CatalogResponse; totals: { dispatches: number; completed: number; failed: number; tokens: number } | null }) {
  const skills = agent.skills.map((name) => ({ name, description: catalog.skills.find((skill) => skill.name === name)?.description ?? "" }));
  const tools = groupAgentTools(agent.tools, catalog.mcp?.servers);
  const toolText = [tools.builtin.join(", "), ...tools.servers.map((server) => `${server.title}: ${server.tools.join(", ")}`)].filter(Boolean).join("; ");
  return (
    <Card className="flex flex-col gap-4 px-5 py-4">
      <div>
        <h2 className="text-md font-semibold text-fg">{agent.name}</h2>
        <p className="mt-1 text-sm text-fg-2">{agent.description}</p>
      </div>
      {totals && totals.dispatches > 0 && (
        <p className="rounded-md bg-sunken px-3 py-2 text-sm text-fg-2">
          In this run: {pluralize(totals.dispatches, "attempt")}, {totals.completed} done{totals.failed ? `, ${totals.failed} failed` : ""}, {formatTokens(totals.tokens, "0")} tokens
        </p>
      )}
      <KeyValues
        items={[
          ["Persona", agent.persona],
          ["Good at", agent.capabilities.map((capability) => humanizeKey(capability).toLowerCase()).join(", ")],
          ["Tools", toolText || "None"],
          ["Model tiers", `${tierRange(agent).map((tier) => TIER_LABEL[tier]).join(", ")} (starts at ${TIER_LABEL[agent.model.defaultTier]})`],
          ["Review", EVALUATION_LABEL[agent.evaluation]],
        ]}
      />
      {skills.length > 0 && (
        <Disclosure summary={`Skills (${skills.length})`}>
          <ul className="flex flex-col gap-2 pt-2">
            {skills.map((skill) => (
              <li key={skill.name} className="text-sm">
                <span className="font-mono text-[13px] text-fg">{skill.name}</span>
                {skill.description && <p className="mt-0.5 text-fg-2">{skill.description}</p>}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Card>
  );
}

function OrchestratorConfig({ catalog }: { catalog: CatalogResponse }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <caption className="px-4 pt-4 pb-2 text-left text-sm font-semibold text-fg">Model tiers</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-fg-3">
              <th scope="col" className="px-4 py-2 font-medium">
                Tier
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Model
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Thinking
              </th>
            </tr>
          </thead>
          <tbody>
            {catalog.tiers.map((tier) => (
              <tr key={tier.tier} className="border-b border-line last:border-b-0 align-top">
                <th scope="row" className="px-4 py-2.5 text-left font-medium">
                  {TIER_LABEL[tier.tier]}
                </th>
                <td className="px-4 py-2.5 font-mono text-[13px] text-fg-2">{tier.model}</td>
                <td className="px-4 py-2.5 text-fg-2">{tier.thinking.replace(/^thinking /, "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 pb-4 text-xs text-fg-3">Harder tasks start on higher tiers; a task that keeps failing review moves up a tier.</p>
      </Card>
      <Card className="px-4 py-4">
        <h3 className="text-sm font-semibold text-fg">Orchestrator roles</h3>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          {Object.entries(catalog.roles).map(([role, tier]) => (
            <div key={role} className="flex items-baseline justify-between gap-3">
              <dt className="text-fg-2">{ROLE_LABEL[role] ?? humanizeKey(role)}</dt>
              <dd className="text-fg">{TIER_LABEL[tier]}</dd>
            </div>
          ))}
        </dl>
        <Disclosure className="mt-4 border-t border-line pt-3" summary="Safety limits">
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 pt-2 text-sm">
            {Object.entries(catalog.guards).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-fg-2">{humanizeKey(key.replace(/([A-Z])/g, " $1")).toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</dt>
                <dd className="tabular text-right text-fg">{value}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      </Card>
    </div>
  );
}

export function AgentsPage() {
  const { catalog, error, loading, reload } = useCatalogContext();
  const session = useRunSession();
  const agentTotals = session.views.agentActivity.agents;
  const hasRun = session.threadId !== null;

  useEffect(() => {
    document.title = "Agents · Analytax";
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1.5 max-w-[65ch] text-base text-fg-2">
          The specialists the planner assigns tasks to. Each has a persona, tools, skills and a range of model tiers.
          {hasRun && " Totals show what each agent did in the run you have open."}
        </p>
      </div>

      {error && (
        <Callout family="danger" role="alert" title={`Can't reach the orchestrator at ${API_URL}`} actions={<Button size="sm" icon={<IconRetry size={14} aria-hidden="true" />} onClick={reload}>Retry</Button>}>
          Start it with <code className="font-mono">pnpm dev</code>, then retry.
        </Callout>
      )}

      {loading && !catalog ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-56" />
          ))}
        </div>
      ) : !catalog ? (
        !error && <EmptyState title="No agents loaded" hint="The roster comes from the orchestrator catalog." />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {catalog.agents.map((agent) => {
              const totals = agentTotals[agent.id];
              return (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  catalog={catalog}
                  totals={totals ? { dispatches: totals.dispatches, completed: totals.completed, failed: totals.failed, tokens: totals.usage.inputTokens + totals.usage.outputTokens } : null}
                />
              );
            })}
          </div>
          {catalog.mcp && <ToolServersPanel initial={catalog.mcp} agents={catalog.agents} />}
          <Section title="How work is routed" description="Which model tier each part of the orchestrator uses, and the limits that keep runs bounded.">
            <OrchestratorConfig catalog={catalog} />
          </Section>
        </>
      )}
    </div>
  );
}
