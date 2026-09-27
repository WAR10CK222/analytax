import type { RunContext } from "@analytax/contracts";

/**
 * A composer draft handed from a run ("Run again with changes") to the Home screen. Kept in memory only:
 * it is consumed once, right after navigation.
 */
export type ComposerDraft = { query: string; runOptions: Partial<RunContext> | null };

let pending: ComposerDraft | null = null;

export function setDraft(draft: ComposerDraft): void {
  pending = draft;
}

export function takeDraft(): ComposerDraft | null {
  const draft = pending;
  pending = null;
  return draft;
}
