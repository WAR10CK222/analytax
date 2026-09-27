const MAX_DETAIL = 300;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * Makes error text safe to store, log and show: every secret becomes `***`, full URLs shrink to their host (paths and
 * query strings can carry tokens), control characters go, and the result is capped.
 */
export function redact(text: string, secrets: readonly string[], max = MAX_DETAIL): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("***");
  }
  out = out.replace(URL_PATTERN, (match) => {
    try {
      return new URL(match).host;
    } catch {
      return "[url]";
    }
  });
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
