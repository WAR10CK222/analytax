/** Cheap, dependency-free token estimate (≈4 chars/token) used for context budgeting. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function truncate(text: string, maxChars: number, marker = " …[truncated]"): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

/** Shortens a title at a word boundary with a plain ellipsis (no "[truncated]" marker, it is shown to people). */
export function shortTitle(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSet(text: string): Set<string> {
  return new Set(normalizeText(text).split(" ").filter(Boolean));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export const wordCount = (text: string): number => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

export const uniq = <T>(items: Iterable<T>): T[] => [...new Set(items)];
