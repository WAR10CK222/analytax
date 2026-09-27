import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cx } from "../../lib/cx";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

const popupSurface = "ax-popup rounded-lg border border-line bg-raised text-fg shadow-overlay outline-none";

// ---------------------------------------------------------------------------------------------------------------
// Tooltip: supplementary only; never the sole way to read a value.
// ---------------------------------------------------------------------------------------------------------------

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={450} closeDelay={80}>
      {children}
    </BaseTooltip.Provider>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: Side }) {
  if (!content) return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup className={cx(popupSurface, "max-w-xs px-2.5 py-1.5 text-xs leading-snug text-fg-2")}>{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------------------------------------------

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverClose = BasePopover.Close;

export function PopoverContent({
  children,
  className,
  side = "bottom",
  align = "start",
  sideOffset = 8,
  ...props
}: Omit<ComponentProps<typeof BasePopover.Popup>, "className"> & { className?: string; side?: Side; align?: Align; sideOffset?: number }) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={12} className="z-40">
        <BasePopover.Popup className={cx(popupSurface, "max-h-[min(80dvh,var(--available-height))] overflow-y-auto", className)} {...props}>
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------------------------------------------

export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;

export function MenuContent({ children, side = "bottom", align = "end", className }: { children: ReactNode; side?: Side; align?: Align; className?: string }) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side={side} align={align} sideOffset={6} collisionPadding={12} className="z-40">
        <BaseMenu.Popup className={cx(popupSurface, "min-w-52 p-1", className)}>{children}</BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

const itemClass =
  "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm text-fg outline-none select-none data-[highlighted]:bg-hover data-[disabled]:opacity-50";

export function MenuItem({
  icon,
  children,
  onClick,
  disabled,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <BaseMenu.Item className={itemClass} onClick={onClick} disabled={disabled}>
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-fg-2">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
    </BaseMenu.Item>
  );
}

export function MenuRadioGroup<T extends string>({ value, onValueChange, children }: { value: T; onValueChange: (value: T) => void; children: ReactNode }) {
  return (
    <BaseMenu.RadioGroup value={value} onValueChange={(next) => onValueChange(next as T)}>
      {children}
    </BaseMenu.RadioGroup>
  );
}

export function MenuRadioItem({ value, icon, children }: { value: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <BaseMenu.RadioItem value={value} className={itemClass} closeOnClick>
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-fg-2">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <BaseMenu.RadioItemIndicator className="size-1.5 rounded-full bg-fg" />
    </BaseMenu.RadioItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-xs text-fg-3">{children}</div>;
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="my-1 h-px bg-line" />;
}
