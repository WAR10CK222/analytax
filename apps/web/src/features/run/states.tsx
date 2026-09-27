import type { HitlInterrupt } from "@analytax/contracts";
import { useShell } from "../../app/shell-context";
import { Button } from "../../components/ui/Button";
import { IconPlus, IconQuestion } from "../../components/ui/icons";
import { Callout, EmptyState, Skeleton } from "../../components/ui/Surface";

/** Shaped like the workspace, shown while a run is rejoined. */
export function RunSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" aria-busy="true" aria-label="Loading run">
      <Skeleton className="h-6 w-2/3 max-w-xl" />
      <Skeleton className="h-4 w-80" />
      <div className="flex gap-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-8 w-20" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-12" />
        ))}
      </div>
      <Skeleton className="h-48" />
    </div>
  );
}

export function RunNotFound() {
  const { actions } = useShell();
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <EmptyState
        title="This run is no longer on the server"
        hint="The orchestrator has no record of it, usually because its local data was cleared or it points at a different server. Start a new run, or remove this one from the list."
        action={
          <Button variant="primary" icon={<IconPlus size={14} aria-hidden="true" />} onClick={actions.newRun}>
            New run
          </Button>
        }
      />
    </div>
  );
}

const INTERRUPT_COPY: Record<HitlInterrupt["kind"], string> = {
  clarify: "Answer a few questions before planning",
  approve_plan: "Review the plan before it runs",
  human_review: "Decide how to handle a stuck task",
};

/** Shown when a question is pending and the dialog was dismissed. */
export function AttentionCallout({ kind, onReview }: { kind: HitlInterrupt["kind"]; onReview: () => void }) {
  return (
    <Callout
      family="attention"
      role="status"
      title={`The run is waiting for you: ${INTERRUPT_COPY[kind].toLowerCase()}`}
      actions={
        <Button variant="primary" size="sm" icon={<IconQuestion size={14} aria-hidden="true" />} onClick={onReview}>
          Review
        </Button>
      }
    />
  );
}
