import { NumberField } from "@base-ui/react/number-field";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useEffect, useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { IconCaretDown, IconMinus, IconPlus } from "./icons";

export const fieldClass =
  "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-base text-fg placeholder:text-fg-3 transition-[border-color,box-shadow] duration-150 outline-none focus:border-fg focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ax-fg)_12%,transparent)] disabled:opacity-60";

/** Toggle with a visible label and optional hint (label is the click target). */
export function SwitchField({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-fg-2">{hint}</span>}
      </label>
      <BaseSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        disabled={disabled}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full bg-line-strong transition-colors duration-150 data-[checked]:bg-ink data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
      >
        <BaseSwitch.Thumb className="block size-4 translate-x-0.5 translate-y-0.5 rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-150 ease-[var(--ease-out)] data-[checked]:translate-x-[18px]" />
      </BaseSwitch.Root>
    </div>
  );
}

export function NumberStepper({
  label,
  hint,
  value,
  onValueChange,
  min,
  max,
}: {
  label: string;
  hint?: string;
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
}) {
  const id = useId();
  const buttonClass =
    "ax-press flex size-8 items-center justify-center text-fg-2 hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-fg-2">{hint}</span>}
      </label>
      <NumberField.Root id={id} value={value} min={min} max={max} onValueChange={(next) => next !== null && onValueChange(next)}>
        <NumberField.Group className="flex h-8 items-center overflow-hidden rounded-md border border-line-strong bg-surface">
          <NumberField.Decrement className={buttonClass} aria-label={`Fewer ${label.toLowerCase()}`}>
            <IconMinus size={14} aria-hidden="true" />
          </NumberField.Decrement>
          <NumberField.Input className="tabular h-8 w-10 border-x border-line bg-transparent text-center text-sm text-fg outline-none" />
          <NumberField.Increment className={buttonClass} aria-label={`More ${label.toLowerCase()}`}>
            <IconPlus size={14} aria-hidden="true" />
          </NumberField.Increment>
        </NumberField.Group>
      </NumberField.Root>
    </div>
  );
}

/** Textarea that grows with its content up to `maxRows`. */
export function AutoTextarea({ className, value, maxRows = 12, ref: externalRef, ...props }: ComponentProps<"textarea"> & { maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 22;
    const limit = line * maxRows + 24;
    node.style.height = `${Math.min(node.scrollHeight, limit)}px`;
    node.style.overflowY = node.scrollHeight > limit ? "auto" : "hidden";
  }, [value, maxRows]);
  const setRef = (node: HTMLTextAreaElement | null) => {
    ref.current = node;
    if (typeof externalRef === "function") externalRef(node);
    else if (externalRef) externalRef.current = node;
  };
  return <textarea ref={setRef} value={value} className={cx(fieldClass, "resize-none", className)} {...props} />;
}

/** Single-choice segmented control (radio semantics through a toggle group). */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
  size = "md",
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode; count?: number; icon?: ReactNode }[];
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked) onValueChange(picked);
      }}
      className={cx("inline-flex items-center gap-0.5 rounded-md bg-sunken p-0.5", className)}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className={cx(
            "ax-press inline-flex items-center gap-1.5 rounded-sm px-2.5 font-medium whitespace-nowrap text-fg-2 hover:text-fg",
            size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
            "data-[pressed]:bg-surface data-[pressed]:text-fg data-[pressed]:shadow-[0_1px_2px_rgb(0_0_0/0.08)]",
          )}
        >
          {option.icon}
          {option.label}
          {option.count !== undefined && <span className="tabular text-fg-3">{option.count}</span>}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** Native select, restyled (fully accessible, native mobile pickers). */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className={cx("relative inline-flex", className)}>
      <select
        className="h-8 w-full appearance-none rounded-md border border-line-strong bg-surface py-0 pr-8 pl-3 text-sm text-fg outline-none focus-visible:border-fg"
        {...props}
      >
        {children}
      </select>
      <IconCaretDown aria-hidden="true" size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-3" />
    </div>
  );
}

/** Label above, control, error below (never placeholder-as-label). */
export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-fg-2">{hint}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Autofocus that respects dialogs: focuses once when `when` becomes true. */
export function useFocusWhen<T extends HTMLElement>(when: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (when) ref.current?.focus();
  }, [when]);
  return ref;
}
