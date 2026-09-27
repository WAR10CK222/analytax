import type { TaskOriginKind, Tier } from "@analytax/contracts";
import { cx } from "../../lib/cx";
import { ORIGIN_LABEL, TIER_LABEL, type OriginIconKey, type StatusIconKey, type Tone } from "../../lib/status";
import {
  IconAttention,
  IconCanceled,
  IconDanger,
  IconDirect,
  IconEvaluate,
  IconFallback,
  IconHuman,
  IconInfo,
  IconNeutral,
  IconPartial,
  IconProposal,
  IconRejected,
  IconReplan,
  IconRevision,
  IconSpinner,
  IconSplit,
  IconStopped,
  IconSuccess,
  IconWaiting,
  type PhosphorIcon,
} from "./icons";
import { Tooltip } from "./Overlay";

const STATUS_ICON: Record<StatusIconKey, PhosphorIcon> = {
  running: IconSpinner,
  evaluating: IconEvaluate,
  success: IconSuccess,
  attention: IconAttention,
  partial: IconPartial,
  danger: IconDanger,
  rejected: IconRejected,
  neutral: IconNeutral,
  waiting: IconWaiting,
  canceled: IconCanceled,
  stopped: IconStopped,
  info: IconInfo,
};

export function StatusIcon({ tone, size = 16, className }: { tone: Tone; size?: number; className?: string }) {
  const Icon = STATUS_ICON[tone.icon];
  const spins = tone.icon === "running";
  return (
    <Icon
      aria-hidden="true"
      size={size}
      weight={tone.family === "neutral" ? "regular" : "bold"}
      className={cx("shrink-0", spins && "animate-spin [animation-duration:1.4s] motion-reduce:animate-none", className)}
      style={{ color: tone.color }}
    />
  );
}

/** Pill with icon + word. Status is never colour alone. */
export function StatusBadge({ tone, className, size = "sm" }: { tone: Tone; className?: string; size?: "sm" | "md" }) {
  const neutral = tone.family === "neutral";
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-sm",
        neutral ? "bg-sunken text-fg-2" : "bg-[color-mix(in_oklab,var(--tone)_11%,transparent)] text-[var(--tone)]",
        className,
      )}
      style={neutral ? undefined : ({ "--tone": tone.color } as React.CSSProperties)}
    >
      <StatusIcon tone={tone} size={size === "sm" ? 13 : 14} />
      {tone.label}
    </span>
  );
}

/** Inline icon + word, for rows and dense lists. */
export function StatusText({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-fg-2", className)}>
      <StatusIcon tone={tone} size={14} />
      {tone.label}
    </span>
  );
}

export function TierText({ tier, className }: { tier: Tier | null | undefined; className?: string }) {
  if (!tier) return null;
  return <span className={cx("text-sm whitespace-nowrap text-fg-3", className)}>{TIER_LABEL[tier]}</span>;
}

const ORIGIN_ICON: Record<OriginIconKey, PhosphorIcon> = {
  proposal: IconProposal,
  split: IconSplit,
  revision: IconRevision,
  replan: IconReplan,
  human: IconHuman,
  fallback: IconFallback,
  direct: IconDirect,
};

/** Small neutral icon for tasks that were not in the original plan. Screen readers get the label. */
export function OriginMark({ origin, size = 14 }: { origin: TaskOriginKind | null | undefined; size?: number }) {
  const meta = origin ? ORIGIN_LABEL[origin] : undefined;
  if (!meta) return null;
  const Icon = ORIGIN_ICON[meta.icon];
  return (
    <Tooltip content={`${meta.label}. ${meta.hint}.`}>
      <span className="inline-flex shrink-0 text-fg-3" tabIndex={0} role="img" aria-label={meta.label}>
        <Icon size={size} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
