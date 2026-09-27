import type { Task } from "@analytax/contracts";
import { shortHash } from "../util/hash.js";
import { jaccard, normalizeText, tokenSet } from "../util/text.js";

export type TaskIdentity = { capability: string; title: string; instructions: string };

export const taskFingerprint = ({ capability, title, instructions }: TaskIdentity): string =>
  shortHash(`${normalizeText(capability)}|${normalizeText(title)}|${normalizeText(instructions)}`);

const NEAR_DUPLICATE_THRESHOLD = 0.85;

/**
 * Exact match on fingerprint; optionally a near-duplicate match that requires BOTH title and instructions to be
 * highly similar (so "Research Qdrant pricing" vs "Research Milvus pricing" stay distinct).
 */
export function findDuplicateTask(
  tasks: Iterable<Task>,
  candidate: TaskIdentity,
  options: { near: boolean; excludeIds?: ReadonlySet<string> },
): Task | null {
  const fingerprint = taskFingerprint(candidate);
  const titleTokens = tokenSet(candidate.title);
  const instructionTokens = tokenSet(candidate.instructions);
  const capability = normalizeText(candidate.capability);
  let near: Task | null = null;
  for (const task of tasks) {
    if (options.excludeIds?.has(task.id)) continue;
    if (task.fingerprint === fingerprint) return task;
    if (
      options.near &&
      near === null &&
      normalizeText(task.capability) === capability &&
      jaccard(titleTokens, tokenSet(task.title)) >= NEAR_DUPLICATE_THRESHOLD &&
      jaccard(instructionTokens, tokenSet(task.instructions)) >= NEAR_DUPLICATE_THRESHOLD
    ) {
      near = task;
    }
  }
  return near;
}
