import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode, RefObject } from "react";
import { cx } from "../../lib/cx";
import { IconClose } from "./icons";

type FocusTarget = boolean | RefObject<HTMLElement | null>;

/**
 * Centred modal on ≥640px, bottom sheet below. Focus is trapped while open and returned on close.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  headerAside,
  children,
  footer,
  initialFocus,
  finalFocus,
  size = "md",
  bare = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  headerAside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  initialFocus?: FocusTarget;
  finalFocus?: FocusTarget;
  size?: "md" | "lg";
  /** Children lay out their own body and footer (use DialogBody / DialogFooter), e.g. a form. */
  bare?: boolean;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="ax-backdrop fixed inset-0 z-50 bg-overlay" />
        <BaseDialog.Popup
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          className={cx(
            "ax-dialog fixed z-50 flex flex-col overflow-hidden border border-line bg-raised text-fg shadow-overlay outline-none",
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-lg pb-[env(safe-area-inset-bottom)]",
            "sm:inset-x-auto sm:bottom-auto sm:top-[8dvh] sm:left-1/2 sm:max-h-[84dvh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:rounded-lg sm:pb-0",
            size === "md" ? "sm:max-w-xl" : "sm:max-w-3xl",
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <BaseDialog.Title className="text-md font-semibold text-fg">{title}</BaseDialog.Title>
              {description && <BaseDialog.Description className="mt-0.5 text-sm text-fg-2">{description}</BaseDialog.Description>}
            </div>
            {headerAside}
            <BaseDialog.Close
              aria-label="Close"
              className="ax-press -mt-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-hover hover:text-fg"
            >
              <IconClose size={16} aria-hidden="true" />
            </BaseDialog.Close>
          </div>
          {bare ? (
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          ) : (
            <>
              <DialogBody>{children}</DialogBody>
              {footer && <DialogFooter>{footer}</DialogFooter>}
            </>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Side sheet (modal): the inspector on narrow screens and the mobile navigation. */
export function Sheet({
  open,
  onOpenChange,
  side,
  label,
  children,
  className,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  label: string;
  children: ReactNode;
  className?: string;
  finalFocus?: FocusTarget;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="ax-backdrop fixed inset-0 z-40 bg-overlay" />
        <BaseDialog.Popup
          aria-label={label}
          finalFocus={finalFocus}
          className={cx(
            "fixed inset-y-0 z-40 flex flex-col bg-surface text-fg shadow-overlay outline-none",
            side === "right" ? "ax-sheet-right right-0 border-l border-line" : "ax-sheet-left left-0 border-r border-line",
            className,
          )}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4", className)}>{children}</div>;
}

export function DialogFooter({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3">
      {note && <div className="mr-auto min-w-0 text-xs text-fg-2">{note}</div>}
      {children}
    </div>
  );
}

export const DialogTitle = BaseDialog.Title;
export const DialogClose = BaseDialog.Close;
