import { IconCheck } from "../../components/ui/icons";
import { StatusIcon } from "../../components/ui/Status";
import { cx } from "../../lib/cx";
import { tone } from "../../lib/status";
import type { ProgressStep } from "../../view-models/progress";

const CURRENT_TONE = {
  current: tone("", "running"),
  waiting: tone("", "attention"),
  failed: tone("", "danger"),
  stopped: tone("", "neutral", "stopped"),
  partial: tone("", "attention", "partial"),
} as const;

function StepMarker({ step }: { step: ProgressStep }) {
  if (step.state === "done") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-ink-fg">
        <IconCheck size={13} weight="bold" aria-hidden="true" />
      </span>
    );
  }
  if (step.state === "upcoming") return <span className="size-6 shrink-0 rounded-full border border-line-strong" aria-hidden="true" />;
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface">
      <StatusIcon tone={CURRENT_TONE[step.state]} size={14} />
    </span>
  );
}

const STATE_TEXT: Record<ProgressStep["state"], string> = {
  done: "done",
  current: "in progress",
  waiting: "waiting for you",
  failed: "failed",
  stopped: "stopped",
  upcoming: "not started",
  partial: "partly done",
};

/** Four-step rail. Finished steps are ink; only the current step carries status colour. */
export function ProgressRail({ steps, executeRatio }: { steps: ProgressStep[]; executeRatio: number | null }) {
  return (
    <ol aria-label="Run progress" className="grid grid-cols-4 gap-x-3 sm:gap-x-4">
      {steps.map((step, index) => {
        const active = step.state === "current" || step.state === "waiting";
        return (
          <li key={step.id} className="flex min-w-0 flex-col gap-1.5 sm:gap-2">
            <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <StepMarker step={step} />
              <span className={cx("text-xs font-medium sm:text-sm", step.state === "upcoming" ? "text-fg-3" : "text-fg")}>
                {step.label}
                <span className="sr-only">, {STATE_TEXT[step.state]}</span>
              </span>
              {index < steps.length - 1 && <span aria-hidden="true" className="ml-1 hidden h-px flex-1 bg-line-strong sm:block" />}
            </div>
            {step.id === "execute" && executeRatio !== null && step.state !== "upcoming" && (
              <div
                className="h-1 max-w-40 overflow-hidden rounded-full bg-line-strong sm:ml-8"
                role="progressbar"
                aria-label="Tasks done"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(executeRatio * 100)}
              >
                <div className={cx("h-full rounded-full transition-[width] duration-500", active ? "bg-running" : "bg-fg")} style={{ width: `${executeRatio > 0 ? Math.max(executeRatio * 100, 3) : 0}%` }} />
              </div>
            )}
            {step.detail && <p className={cx("text-xs sm:ml-8", step.state === "waiting" ? "text-attention" : "text-fg-2")}>{step.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
