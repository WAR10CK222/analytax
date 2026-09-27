import { Collapsible } from "@base-ui/react/collapsible";
import { useState, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { IconCaretRight } from "./icons";

/** Expandable group with a caret trigger. Height animates via Base UI's measured variable. */
export function Disclosure({
  summary,
  aside,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  triggerClassName,
}: {
  summary: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
}) {
  // Base UI warns if an uncontrolled default changes after mount; freeze the first value.
  const [initialOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root
      className={className}
      {...(open === undefined ? { defaultOpen: initialOpen } : { open })}
      onOpenChange={(next) => onOpenChange?.(next)}
    >
      <div className="flex items-center gap-2">
        <Collapsible.Trigger
          className={cx(
            "group ax-press flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-sm font-medium text-fg hover:text-fg",
            triggerClassName,
          )}
        >
          <IconCaretRight
            aria-hidden="true"
            size={14}
            className="shrink-0 text-fg-3 transition-transform duration-150 group-data-[panel-open]:rotate-90"
          />
          <span className="min-w-0 flex-1">{summary}</span>
        </Collapsible.Trigger>
        {aside}
      </div>
      <Collapsible.Panel className="ax-collapse">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}
