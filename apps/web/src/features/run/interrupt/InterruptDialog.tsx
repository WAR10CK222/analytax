import {
  ApprovePlanResume,
  HumanReviewResume,
  type ApprovePlanInterrupt,
  type ApprovePlanResumeInput,
  type ClarifyInterrupt,
  type ClarifyResume,
  type HumanDecision,
  type HumanRequest,
  type HumanReviewInterrupt,
  type PlanOpInput,
} from "@analytax/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Dialog, DialogBody, DialogFooter } from "../../../components/ui/Dialog";
import { Disclosure } from "../../../components/ui/Disclosure";
import { AutoTextarea } from "../../../components/ui/Form";
import { IconEdit, IconTrash, IconUndo } from "../../../components/ui/icons";
import { OriginMark } from "../../../components/ui/Status";
import { Callout } from "../../../components/ui/Surface";
import { TaskLink } from "../../../components/ui/TaskLink";
import { cx } from "../../../lib/cx";
import { errorMessage, pluralize } from "../../../lib/format";
import { FAMILY_COLOR, humanizeKey, type StatusFamily } from "../../../lib/status";
import type { PendingInterrupt } from "../../../stream/types";
import { useRunView } from "../run-context";

type FormProps<T> = {
  interrupt: T;
  submitting: boolean;
  onSubmit: (value: unknown) => void;
  onLater: () => void;
  /** Closes the dialog, then opens the task in the inspector (never two modals at once). */
  onSelectTask: (taskId: string) => void;
};

const TITLES: Record<PendingInterrupt["value"]["kind"], string> = {
  clarify: "A few questions before planning",
  approve_plan: "Review the plan",
  human_review: "The run needs your decision",
};

function ErrorList({ errors, title }: { errors: readonly string[]; title: string }) {
  if (errors.length === 0) return null;
  return (
    <Callout family="danger" role="alert" title={title}>
      <ul className="flex list-disc flex-col gap-0.5 pl-4 break-words whitespace-pre-wrap">
        {errors.map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
    </Callout>
  );
}

function LaterButton({ onLater, disabled }: { onLater: () => void; disabled: boolean }) {
  return (
    <Button variant="ghost" onClick={onLater} disabled={disabled} className="mr-auto">
      Review later
    </Button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// clarify → { answers: string[] }
// ---------------------------------------------------------------------------------------------------------------

function ClarifyForm({ interrupt, submitting, onSubmit, onLater }: FormProps<ClarifyInterrupt>) {
  const ids = useId();
  const questions = interrupt.questions.length > 0 ? interrupt.questions : ["Anything the agents should know before planning?"];
  const [answers, setAnswers] = useState(() => questions.map(() => ""));
  const send = (value: ClarifyResume) => onSubmit(value);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        send({ answers: answers.map((answer) => answer.trim()) });
      }}
    >
      <DialogBody className="flex flex-col gap-5">
        {interrupt.goal && (
          <p className="text-sm text-fg-2">
            So far this reads as: <span className="text-fg">{interrupt.goal}</span>
          </p>
        )}
        {questions.map((question, index) => (
          <div key={index} className="flex flex-col gap-2">
            <label htmlFor={`${ids}-q${index}`} className="text-sm font-medium text-fg">
              {questions.length > 1 ? `${index + 1}. ` : ""}
              {question}
            </label>
            <AutoTextarea
              id={`${ids}-q${index}`}
              rows={2}
              maxRows={8}
              autoFocus={index === 0}
              value={answers[index] ?? ""}
              onChange={(event) => setAnswers((current) => current.map((answer, position) => (position === index ? event.target.value : answer)))}
            />
          </div>
        ))}
        <p className="text-xs text-fg-3">Leave an answer blank and the agents will use their best judgment.</p>
      </DialogBody>
      <DialogFooter>
        <LaterButton onLater={onLater} disabled={submitting} />
        <Button disabled={submitting} onClick={() => send({ answers: questions.map(() => "") })}>
          Skip questions
        </Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Sending" : "Send answers"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// approve_plan → approve | edit (update_task / cancel_task ops) | reject
// ---------------------------------------------------------------------------------------------------------------

type TaskEdit = { instructions?: string; removed?: boolean };

function ApprovePlanForm({ interrupt, submitting, onSubmit, onLater, onSelectTask }: FormProps<ApprovePlanInterrupt>) {
  const ids = useId();
  const { agentName } = useRunView();
  const [edits, setEdits] = useState<Record<string, TaskEdit>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const titleOf = (id: string) => interrupt.tasks.find((task) => task.id === id)?.title ?? id;

  const removedIds = useMemo(() => new Set(Object.entries(edits).filter(([, edit]) => edit.removed).map(([id]) => id)), [edits]);

  const ops = useMemo<PlanOpInput[]>(() => {
    const result: PlanOpInput[] = [];
    for (const task of interrupt.tasks) {
      const edit = edits[task.id];
      if (!edit) continue;
      if (edit.removed) {
        result.push({ op: "cancel_task", taskId: task.id, cascade: "auto", reason: "Removed by reviewer during plan approval", source: { kind: "human" } });
        continue;
      }
      const instructions = edit.instructions?.trim();
      if (instructions && instructions !== task.instructions.trim()) {
        result.push({ op: "update_task", taskId: task.id, patch: { instructions }, reason: "Instructions edited by reviewer", source: { kind: "human" } });
      }
    }
    return result;
  }, [edits, interrupt.tasks]);

  const send = (value: ApprovePlanResumeInput) => {
    const parsed = ApprovePlanResume.safeParse(value);
    if (!parsed.success) {
      setLocalErrors(parsed.error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`));
      return;
    }
    setLocalErrors([]);
    onSubmit(value);
  };

  const patchEdit = (taskId: string, patch: TaskEdit) => setEdits((current) => ({ ...current, [taskId]: { ...current[taskId], ...patch } }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DialogBody className="flex flex-col gap-4">
        {interrupt.rationale && <p className="max-w-[72ch] text-sm leading-relaxed text-fg">{interrupt.rationale}</p>}
        <ErrorList title="The server rejected the previous edit" errors={interrupt.errors} />
        <ErrorList title="Fix these before sending" errors={localErrors} />

        <ol className="flex flex-col gap-2">
          {interrupt.tasks.map((task, index) => {
            const edit = edits[task.id];
            const removed = edit?.removed === true;
            const edited = edit?.instructions !== undefined && edit.instructions.trim() !== task.instructions.trim();
            const blockedBy = task.dependsOn.filter((dependency) => removedIds.has(dependency));
            const isEditing = editingId === task.id && !removed;
            return (
              <li key={task.id} className={cx("rounded-md border px-4 py-3", removed ? "border-dashed border-line-strong bg-sunken/50" : "border-line bg-surface")}>
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <span className="tabular w-5 shrink-0 pt-px text-sm text-fg-3">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx("text-sm font-medium", removed ? "text-fg-3 line-through" : "text-fg")}>{task.title}</span>
                      <OriginMark origin={task.originKind} size={13} />
                      {edited && !removed && <span className="rounded-full bg-sunken px-2 text-xs leading-5 text-fg-2">Edited</span>}
                      {removed && <span className="rounded-full bg-sunken px-2 text-xs leading-5 text-fg-2">Removed</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-fg-3">
                      {agentName(task.agentId)}, {humanizeKey(task.complexity).toLowerCase()} complexity
                      {task.critical ? ", critical" : ""}
                      {task.dependsOn.length > 0 ? `, after ${task.dependsOn.map(titleOf).join(", ")}` : ""}
                    </p>
                    {blockedBy.length > 0 && !removed && (
                      <p className="mt-1 text-xs text-attention">Depends on a removed task. The server will cancel or rewire it.</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {!removed && (
                      <Button size="sm" variant="ghost" aria-expanded={isEditing} icon={<IconEdit size={14} aria-hidden="true" />} onClick={() => setEditingId(isEditing ? null : task.id)}>
                        {isEditing ? "Done" : "Edit"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={removed ? <IconUndo size={14} aria-hidden="true" /> : <IconTrash size={14} aria-hidden="true" />}
                      onClick={() => patchEdit(task.id, { removed: !removed })}
                    >
                      {removed ? "Restore" : "Remove"}
                    </Button>
                  </div>
                </div>

                <div className="mt-2 pl-8">
                  {isEditing ? (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`${ids}-${task.id}`} className="text-xs font-medium text-fg-2">
                        Instructions
                      </label>
                      <AutoTextarea
                        id={`${ids}-${task.id}`}
                        autoFocus
                        rows={4}
                        value={edit?.instructions ?? task.instructions}
                        onChange={(event) => patchEdit(task.id, { instructions: event.target.value })}
                      />
                      {edited && (
                        <button
                          type="button"
                          className="self-start text-xs text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg"
                          onClick={() => patchEdit(task.id, { instructions: task.instructions })}
                        >
                          Revert to original
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="line-clamp-3 text-sm whitespace-pre-wrap text-fg-2">{edit?.instructions ?? task.instructions}</p>
                  )}
                  {task.acceptanceCriteria.length > 0 && (
                    <Disclosure className="mt-2" triggerClassName="text-xs font-normal text-fg-2" summary={`Done when (${task.acceptanceCriteria.length})`}>
                      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-sm text-fg-2">
                        {task.acceptanceCriteria.map((criterion, criterionIndex) => (
                          <li key={criterionIndex}>{criterion}</li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                  <TaskLink id={task.id} title="Open task details" onSelect={onSelectTask} className="mt-2 inline-block text-xs text-fg-3" />
                </div>
              </li>
            );
          })}
        </ol>

        {rejecting && (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${ids}-feedback`} className="text-sm font-medium">
              What should the next plan do differently?
            </label>
            <AutoTextarea id={`${ids}-feedback`} autoFocus rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} />
            <p className="text-xs text-fg-3">The planner discards these tasks and plans again with your feedback.</p>
          </div>
        )}
      </DialogBody>

      {rejecting ? (
        <DialogFooter>
          <Button disabled={submitting} onClick={() => setRejecting(false)} className="mr-auto">
            Back
          </Button>
          <Button variant="danger" disabled={submitting || !feedback.trim()} onClick={() => send({ decision: "reject", feedback: feedback.trim() })}>
            {submitting ? "Sending" : "Request a new plan"}
          </Button>
        </DialogFooter>
      ) : (
        <DialogFooter>
          <LaterButton onLater={onLater} disabled={submitting} />
          <Button variant="ghost" disabled={submitting} onClick={() => setRejecting(true)}>
            Request changes
          </Button>
          {ops.length > 0 && (
            <Button disabled={submitting} onClick={() => send({ decision: "approve" })}>
              Approve original
            </Button>
          )}
          <Button variant="primary" disabled={submitting} onClick={() => send(ops.length > 0 ? { decision: "edit", ops } : { decision: "approve" })}>
            {submitting ? "Sending" : ops.length > 0 ? `Approve with ${pluralize(ops.length, "edit")}` : "Approve plan"}
          </Button>
        </DialogFooter>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// human_review → { decisions: [{ requestId, decision, answer?, instructions? }] }
// ---------------------------------------------------------------------------------------------------------------

type DecisionDraft = { decision: HumanDecision; answer: string; instructions: string };

const DECISION_COPY: Record<HumanDecision, { label: string; hint: string }> = {
  retry: { label: "Retry", hint: "Run it again, optionally with new instructions" },
  skip: { label: "Skip", hint: "Continue without it, or on stated assumptions" },
  answer: { label: "Answer", hint: "Give the missing information or guidance" },
  abort: { label: "Stop the run", hint: "Stop now and write the answer from what exists" },
};

const REQUEST_KIND: Record<HumanRequest["kind"], { label: string; family: StatusFamily }> = {
  task_failed: { label: "A task failed", family: "danger" },
  needs_input: { label: "An agent needs input", family: "attention" },
  stalled: { label: "The run stopped making progress", family: "attention" },
};

function defaultDecision(request: HumanRequest): HumanDecision {
  const preference: HumanDecision[] =
    request.kind === "needs_input" ? ["answer", "skip", "retry", "abort"] : request.kind === "stalled" ? ["retry", "answer", "skip", "abort"] : ["retry", "skip", "answer", "abort"];
  return preference.find((decision) => request.options.includes(decision)) ?? request.options[0] ?? "skip";
}

function HumanReviewForm({ interrupt, submitting, onSubmit, onLater, onSelectTask }: FormProps<HumanReviewInterrupt>) {
  const ids = useId();
  const { taskTitle } = useRunView();
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>(() =>
    Object.fromEntries(interrupt.requests.map((request) => [request.id, { decision: defaultDecision(request), answer: "", instructions: "" }])),
  );
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const draftFor = (request: HumanRequest): DecisionDraft => drafts[request.id] ?? { decision: defaultDecision(request), answer: "", instructions: "" };
  const patchDraft = (request: HumanRequest, patch: Partial<DecisionDraft>) =>
    setDrafts((current) => ({ ...current, [request.id]: { ...(current[request.id] ?? draftFor(request)), ...patch } }));

  const missingAnswers = interrupt.requests.filter((request) => {
    const draft = draftFor(request);
    return draft.decision === "answer" && !draft.answer.trim();
  });

  const submit = () => {
    const value: HumanReviewResume = {
      decisions: interrupt.requests.map((request) => {
        const draft = draftFor(request);
        return {
          requestId: request.id,
          decision: draft.decision,
          ...(draft.decision === "answer" && draft.answer.trim() ? { answer: draft.answer.trim() } : {}),
          ...(draft.decision === "retry" && draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
        };
      }),
    };
    const parsed = HumanReviewResume.safeParse(value);
    if (!parsed.success) {
      setLocalErrors(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
      return;
    }
    setLocalErrors([]);
    onSubmit(value);
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogBody className="flex flex-col gap-4">
        <ErrorList title="Fix these before sending" errors={localErrors} />
        {interrupt.requests.map((request) => {
          const draft = draftFor(request);
          const kind = REQUEST_KIND[request.kind];
          return (
            <fieldset key={request.id} className="rounded-md border border-line px-4 py-3.5">
              <legend className="sr-only">{request.title}</legend>
              <p className="text-xs font-medium" style={{ color: FAMILY_COLOR[kind.family] }}>
                {kind.label}
              </p>
              <p className="mt-1 text-sm font-medium text-fg">{request.question}</p>
              {request.taskId && (
                <p className="mt-1 text-xs text-fg-3">
                  Task: <TaskLink id={request.taskId} title={taskTitle(request.taskId)} onSelect={onSelectTask} className="text-xs" />
                </p>
              )}
              {request.detail && (
                <Disclosure className="mt-2" triggerClassName="text-xs font-normal text-fg-2" summary="Details">
                  <p className="mt-1 text-sm break-words whitespace-pre-wrap text-fg-2">{request.detail}</p>
                </Disclosure>
              )}

              <div role="radiogroup" aria-label={`Decision for ${request.title}`} className="mt-3 grid gap-2 sm:grid-cols-2">
                {request.options.map((option) => {
                  const copy = DECISION_COPY[option];
                  const selected = draft.decision === option;
                  return (
                    <label
                      key={option}
                      className={cx(
                        "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-fg",
                        selected ? "border-fg bg-selected" : "border-line hover:bg-hover",
                      )}
                    >
                      <input
                        type="radio"
                        className="mt-0.5 accent-[var(--ax-ink)]"
                        name={`${ids}-${request.id}`}
                        checked={selected}
                        onChange={() => patchDraft(request, { decision: option })}
                      />
                      <span>
                        <span className="block text-sm font-medium text-fg">{copy.label}</span>
                        <span className="block text-xs text-fg-2">{copy.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {draft.decision === "answer" && (
                <div className="mt-3 flex flex-col gap-1.5">
                  <label htmlFor={`${ids}-${request.id}-answer`} className="text-xs font-medium text-fg-2">
                    Your answer
                  </label>
                  <AutoTextarea id={`${ids}-${request.id}-answer`} rows={3} value={draft.answer} onChange={(event) => patchDraft(request, { answer: event.target.value })} />
                </div>
              )}
              {draft.decision === "retry" && (
                <div className="mt-3 flex flex-col gap-1.5">
                  <label htmlFor={`${ids}-${request.id}-instructions`} className="text-xs font-medium text-fg-2">
                    New instructions (optional)
                  </label>
                  <AutoTextarea
                    id={`${ids}-${request.id}-instructions`}
                    rows={3}
                    placeholder={request.kind === "task_failed" ? "Replace the task instructions for the retry" : "Only used when retrying a failed task"}
                    value={draft.instructions}
                    onChange={(event) => patchDraft(request, { instructions: event.target.value })}
                  />
                </div>
              )}
            </fieldset>
          );
        })}
      </DialogBody>
      <DialogFooter note={missingAnswers.length > 0 ? "Write an answer, or pick another option." : undefined}>
        <LaterButton onLater={onLater} disabled={submitting} />
        <Button type="submit" variant="primary" disabled={submitting || missingAnswers.length > 0}>
          {submitting ? "Sending" : interrupt.requests.length > 1 ? `Send ${pluralize(interrupt.requests.length, "decision")}` : "Send decision"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function InterruptDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session, selectTask } = useRunView();
  const { interrupts, respond } = session;
  const current = interrupts[0];
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formKey = current ? `${current.id ?? "interrupt"}:${current.value.kind}:${JSON.stringify(current.value).length}` : "none";

  useEffect(() => {
    setError(null);
    setSubmitting(false);
  }, [formKey]);

  if (!current) return null;

  const respondWith = (value: unknown) => {
    setSubmitting(true);
    setError(null);
    // The dialog closes on its own when the interrupt clears. (respond() may only resolve when the resumed run
    // pauses again, so closing on resolve could hide the next question.)
    respond(value, current.id)
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setSubmitting(false));
  };

  const formProps = {
    submitting,
    onSubmit: respondWith,
    onLater: () => onOpenChange(false),
    onSelectTask: (taskId: string) => {
      onOpenChange(false);
      selectTask(taskId);
    },
  };
  const value = current.value;
  const description =
    value.kind === "approve_plan"
      ? `${pluralize(value.tasks.length, "task")} planned. Nothing runs until you approve.`
      : "The run is paused until you respond.";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={TITLES[value.kind]}
      description={description}
      headerAside={interrupts.length > 1 ? <span className="shrink-0 pt-1 text-xs text-fg-3">1 of {interrupts.length}</span> : undefined}
      size={value.kind === "clarify" ? "md" : "lg"}
      bare
    >
      {error && (
        <div className="px-5 pt-4">
          <ErrorList title="Your response was not sent" errors={[error]} />
        </div>
      )}
      {value.kind === "clarify" && <ClarifyForm key={formKey} interrupt={value} {...formProps} />}
      {value.kind === "approve_plan" && <ApprovePlanForm key={formKey} interrupt={value} {...formProps} />}
      {value.kind === "human_review" && <HumanReviewForm key={formKey} interrupt={value} {...formProps} />}
    </Dialog>
  );
}
