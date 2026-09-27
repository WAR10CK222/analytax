import { useNow } from "../../hooks/useNow";
import { elapsedMs, formatDateTime, formatDuration, formatRelativeTime } from "../../lib/format";

/**
 * Timers live in leaf components so the ticking re-render stays tiny (and pauses in hidden tabs, where
 * React <Activity> stops effects).
 */
export function Elapsed({ from, to, live, fallback = "Not started" }: { from: string | null | undefined; to?: string | null; live: boolean; fallback?: string }) {
  const now = useNow(1000, live);
  const end = to ?? (live ? now : null);
  const ms = end === null ? null : elapsedMs(from, end);
  return <span className="tabular">{formatDuration(ms, fallback)}</span>;
}

export function RelativeTime({ ts, className }: { ts: string | null | undefined; className?: string }) {
  const now = useNow(15_000, Boolean(ts));
  if (!ts) return null;
  return (
    <time dateTime={ts} title={formatDateTime(ts)} className={className}>
      {formatRelativeTime(ts, now)}
    </time>
  );
}
