import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { FAMILY_COLOR, type StatusFamily } from "../../lib/status";
import { IconAttention, IconDanger, IconInfo, IconSuccess } from "./icons";

/** A titled region. Headings are sentence case; `level` picks h2/h3. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  level = 2,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  level?: 2 | 3;
  id?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={cx("min-w-0", className)} aria-labelledby={headingId}>
      <div className="mb-3 flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Heading id={headingId} className={cx("font-semibold text-fg", level === 2 ? "text-md" : "text-base")}>
            {title}
          </Heading>
          {description && <p className="mt-0.5 text-sm text-fg-2">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Flat surface with a hairline border. Use only where the grouping carries meaning. */
export function Card({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cx("rounded-lg border border-line bg-surface", className)} {...props}>
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      {icon && <div className="mb-1 text-fg-3">{icon}</div>}
      <p className="text-base font-medium text-fg">{title}</p>
      {hint && <p className="max-w-sm text-sm text-fg-2">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

const CALLOUT_ICON = { attention: IconAttention, danger: IconDanger, success: IconSuccess, neutral: IconInfo, running: IconInfo } as const;

/** Inline message block. Errors say what happened and what to do. */
export function Callout({
  family = "neutral",
  title,
  children,
  actions,
  className,
  role,
}: {
  family?: StatusFamily;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  const Icon = CALLOUT_ICON[family];
  const tinted = family !== "neutral";
  return (
    <div
      role={role}
      className={cx(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-3",
        tinted ? "border-[color-mix(in_oklab,var(--tone)_28%,transparent)] bg-[color-mix(in_oklab,var(--tone)_6%,var(--ax-surface))]" : "border-line bg-surface",
        className,
      )}
      style={tinted ? ({ "--tone": FAMILY_COLOR[family] } as React.CSSProperties) : undefined}
    >
      <Icon aria-hidden="true" size={18} weight="bold" className="mt-px shrink-0" style={{ color: FAMILY_COLOR[family] }} />
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children && <div className="mt-0.5 text-sm break-words text-fg-2">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function KeyValues({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm", className)}>
      {items.map(([key, value], index) => (
        <div key={index} className="contents">
          <dt className="text-fg-3">{key}</dt>
          <dd className="min-w-0 break-words text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One number the reader should see at a glance, with an optional supporting line. */
export function StatTile({ label, value, detail, className }: { label: string; value: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3.5", className)}>
      <p className="text-sm text-fg-2">{label}</p>
      <p className="text-xl font-semibold tracking-tight text-fg">{value}</p>
      {detail && <p className="text-xs text-fg-3">{detail}</p>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("animate-pulse rounded-md bg-sunken motion-reduce:animate-none", className)} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong px-1 font-mono text-[11px] leading-none text-fg-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx("border-line", className)} />;
}
