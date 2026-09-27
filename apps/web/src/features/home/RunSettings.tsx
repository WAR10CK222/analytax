import { DemoFaultKind, type AgentCardSummary, type DemoFault, type HitlSettings } from "@analytax/contracts";
import { useId } from "react";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "../../components/ui/Disclosure";
import { NumberStepper, Select, SwitchField, fieldClass } from "../../components/ui/Form";
import { IconClose, IconPlus } from "../../components/ui/icons";
import { cx } from "../../lib/cx";
import type { ServerSwitch } from "../../view-models/mcp";

export type FaultDraft = { key: number; kind: DemoFaultKind; agentId: string; titleIncludes: string; times: number };

export type RunSettingsValue = { hitl: HitlSettings; maxConcurrency: number; faults: FaultDraft[]; toolServersOff: string[] };

const HITL_FIELDS: readonly { key: keyof HitlSettings; label: string; hint: string }[] = [
  { key: "clarify", label: "Ask clarifying questions", hint: "When the request is ambiguous, ask before planning." },
  { key: "approvePlan", label: "Let me approve the plan", hint: "Review and edit the tasks before any agent starts." },
  { key: "humanReview", label: "Escalate stuck tasks to me", hint: "Ask me when a task keeps failing or the run stalls." },
];

const FAULT_LABEL: Record<DemoFaultKind, string> = {
  block_with_prerequisite: "Block and ask for a prerequisite",
  reject: "Fail review",
  transient_error: "Temporary error",
  propose_follow_up: "Suggest a follow-up task",
  decline: "Decline the task",
};

export const toDemoFaults = (faults: readonly FaultDraft[]): DemoFault[] =>
  faults.map((fault) => ({
    kind: fault.kind,
    agentId: fault.agentId || null,
    taskTitleIncludes: fault.titleIncludes.trim() || null,
    times: Math.max(1, Math.round(fault.times)),
  }));

/** One-line summary for the settings trigger, e.g. "Ask first, 4 parallel". */
export function summarizeSettings(value: RunSettingsValue): string {
  const checkIns = [value.hitl.clarify && "questions", value.hitl.approvePlan && "plan review", value.hitl.humanReview && "escalations"].filter(Boolean);
  const parts = [checkIns.length ? `Check-ins: ${checkIns.join(", ")}` : "No check-ins", `${value.maxConcurrency} in parallel`];
  if (value.toolServersOff.length) parts.push(`${value.toolServersOff.length} tool ${value.toolServersOff.length === 1 ? "server" : "servers"} off`);
  if (value.faults.length) parts.push(`${value.faults.length} ${value.faults.length === 1 ? "fault" : "faults"}`);
  return parts.join(", ");
}

function FaultEditor({ faults, agents, onChange }: { faults: FaultDraft[]; agents: readonly AgentCardSummary[]; onChange: (faults: FaultDraft[]) => void }) {
  const ids = useId();
  const update = (key: number, patch: Partial<FaultDraft>) => onChange(faults.map((fault) => (fault.key === key ? { ...fault, ...patch } : fault)));
  const nextKey = faults.reduce((max, fault) => Math.max(max, fault.key), 0) + 1;
  return (
    <div className="flex flex-col gap-3 pt-3">
      <p className="text-xs text-fg-2">Force retries, blocks and failures to see how the plan adapts. Only honored when the server allows fault injection.</p>
      {faults.map((fault, index) => (
        <fieldset key={fault.key} className="flex flex-col gap-2 rounded-md border border-line p-3">
          <legend className="sr-only">Fault {index + 1}</legend>
          <div className="flex items-center gap-2">
            <Select aria-label="What happens" value={fault.kind} onChange={(event) => update(fault.key, { kind: event.target.value as DemoFaultKind })} className="min-w-0 flex-1">
              {DemoFaultKind.options.map((kind) => (
                <option key={kind} value={kind}>
                  {FAULT_LABEL[kind]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              aria-label={`Remove fault ${index + 1}`}
              onClick={() => onChange(faults.filter((item) => item.key !== fault.key))}
              className="ax-press flex size-8 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
            >
              <IconClose size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
            <Select aria-label="Which agent" value={fault.agentId} onChange={(event) => update(fault.key, { agentId: event.target.value })}>
              <option value="">Any agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
            <label className="sr-only" htmlFor={`${ids}-times-${fault.key}`}>
              Attempts affected
            </label>
            <input
              id={`${ids}-times-${fault.key}`}
              type="number"
              min={1}
              max={10}
              value={fault.times}
              onChange={(event) => update(fault.key, { times: Number(event.target.value) || 1 })}
              className={cx(fieldClass, "h-8 py-0 text-sm tabular")}
              title="Attempts affected"
            />
          </div>
          <input
            aria-label="Only tasks whose title contains"
            placeholder="Only tasks whose title contains (optional)"
            value={fault.titleIncludes}
            onChange={(event) => update(fault.key, { titleIncludes: event.target.value })}
            className={cx(fieldClass, "h-8 py-0 text-sm")}
          />
        </fieldset>
      ))}
      <Button
        size="sm"
        variant="secondary"
        icon={<IconPlus size={14} aria-hidden="true" />}
        onClick={() => onChange([...faults, { key: nextKey, kind: "transient_error", agentId: "", titleIncludes: "", times: 1 }])}
        className="self-start"
      >
        Add fault
      </Button>
    </div>
  );
}

export function RunSettingsForm({
  value,
  onChange,
  agents,
  faultsEnabled,
  maxConcurrencyLimit,
  onReset,
  toolServers = [],
}: {
  value: RunSettingsValue;
  onChange: (value: RunSettingsValue) => void;
  agents: readonly AgentCardSummary[];
  faultsEnabled: boolean;
  maxConcurrencyLimit: number;
  onReset: () => void;
  /** MCP servers agents use; each can be switched off for this run. */
  toolServers?: readonly ServerSwitch[];
}) {
  return (
    <div className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <p className="text-base font-semibold">Run settings</p>
        <button type="button" onClick={onReset} className="text-xs text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">
          Reset to defaults
        </button>
      </div>
      <fieldset className="flex flex-col gap-3.5">
        <legend className="mb-2.5 text-xs font-medium text-fg-3">Check with me</legend>
        {HITL_FIELDS.map((field) => (
          <SwitchField
            key={field.key}
            label={field.label}
            hint={field.hint}
            checked={value.hitl[field.key]}
            onCheckedChange={(checked) => onChange({ ...value, hitl: { ...value.hitl, [field.key]: checked } })}
          />
        ))}
      </fieldset>
      <div className="border-t border-line pt-4">
        <NumberStepper
          label="Parallel agents"
          hint="Tasks that can run at the same time."
          value={value.maxConcurrency}
          min={1}
          max={maxConcurrencyLimit}
          onValueChange={(next) => onChange({ ...value, maxConcurrency: next })}
        />
      </div>
      {toolServers.length > 0 && (
        <fieldset className="flex flex-col gap-3.5 border-t border-line pt-4">
          <legend className="mb-2.5 text-xs font-medium text-fg-3">Tool servers</legend>
          {toolServers.map((server) => (
            <SwitchField
              key={server.id}
              label={server.title}
              hint={server.hint}
              disabled={!server.usable}
              checked={server.usable && !value.toolServersOff.includes(server.id)}
              onCheckedChange={(checked) =>
                onChange({ ...value, toolServersOff: checked ? value.toolServersOff.filter((id) => id !== server.id) : [...value.toolServersOff, server.id] })
              }
            />
          ))}
        </fieldset>
      )}
      {faultsEnabled && (
        <div className="border-t border-line pt-3">
          <Disclosure summary={<span>Developer: fault injection{value.faults.length ? ` (${value.faults.length})` : ""}</span>} defaultOpen={value.faults.length > 0}>
            <FaultEditor faults={value.faults} agents={agents} onChange={(faults) => onChange({ ...value, faults })} />
          </Disclosure>
        </div>
      )}
    </div>
  );
}
