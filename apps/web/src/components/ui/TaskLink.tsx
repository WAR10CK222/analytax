import { cx } from "../../lib/cx";

/** Opens a task in the inspector. Shows the title when known, the id otherwise. */
export function TaskLink({
  id,
  title,
  onSelect,
  className,
}: {
  id: string;
  title?: string | null;
  onSelect?: ((id: string) => void) | undefined;
  className?: string;
}) {
  const text = title ?? id;
  if (!onSelect) return <span className={cx("text-fg", className)}>{text}</span>;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onSelect(id);
      }}
      className={cx(
        "rounded-sm text-left text-fg underline decoration-line-strong underline-offset-[3px] hover:decoration-fg",
        className,
      )}
    >
      {text}
    </button>
  );
}
