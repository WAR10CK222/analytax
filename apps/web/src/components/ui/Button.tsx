import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-ink text-ink-fg hover:bg-[color-mix(in_oklab,var(--ax-ink)_86%,var(--ax-canvas))] border border-transparent",
  secondary: "bg-surface text-fg border border-line-strong hover:bg-hover",
  ghost: "bg-transparent text-fg-2 border border-transparent hover:bg-hover hover:text-fg",
  danger:
    "bg-surface text-danger border border-line-strong hover:bg-[color-mix(in_oklab,var(--ax-danger)_8%,transparent)] hover:border-[color-mix(in_oklab,var(--ax-danger)_40%,transparent)]",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-sm",
  md: "h-8 gap-1.5 rounded-md px-3 text-sm",
  lg: "h-9 gap-2 rounded-md px-4 text-base",
};

const ICON_SIZE: Record<ButtonSize, string> = { sm: "size-7 rounded-md", md: "size-8 rounded-md", lg: "size-9 rounded-md" };

export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string =>
  cx(
    "ax-press inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none",
    "disabled:cursor-not-allowed disabled:opacity-50",
    VARIANT[variant],
    SIZE[size],
    extra,
  );

/** Square, padding-free button classes (for icon-only buttons and Base UI triggers). */
export const iconButtonClass = (variant: ButtonVariant = "ghost", size: ButtonSize = "md", extra?: string): string =>
  cx(
    "ax-press inline-flex shrink-0 items-center justify-center select-none disabled:cursor-not-allowed disabled:opacity-50 [&>svg]:shrink-0",
    VARIANT[variant],
    ICON_SIZE[size],
    extra,
  );

type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  trailing?: ReactNode;
};

export function Button({ variant = "secondary", size = "md", icon, trailing, className, children, type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...props}>
      {icon}
      {children}
      {trailing}
    </button>
  );
}

type IconButtonProps = Omit<ComponentProps<"button">, "children"> & {
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/** Square button with an accessible name; pair with a Tooltip when the icon alone is not obvious. */
export function IconButton({ label, icon, variant = "ghost", size = "md", className, type = "button", ...props }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} className={iconButtonClass(variant, size, className)} {...props}>
      {icon}
    </button>
  );
}
