import { useEffect, useState } from "react";

/** Re-renders on an interval (for elapsed timers). Paused when `enabled` is false. Keep it in leaf components. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs, enabled]);
  return now;
}
