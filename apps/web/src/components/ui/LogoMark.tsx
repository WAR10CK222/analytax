/** Brand mark: an ink tile with a geometric A. The only hand-drawn SVG in the app (a mark, not an icon). */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" fill="var(--ax-ink)" />
      <path d="M9 23l5.4-14h3.2L23 23h-3.1l-1.2-3.3h-5.4L12.1 23zm4.6-5.8h3.8L15.5 12z" fill="var(--ax-ink-fg)" />
    </svg>
  );
}
