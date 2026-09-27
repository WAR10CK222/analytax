import type { CheckResult, IssueSeverity, Task, TaskOutcome } from "@analytax/contracts";
import { wordCount } from "../util/text.js";

const RESEARCH_CAPABILITIES = new Set(["web_research", "source_citation"]);

/** Stage A: cheap deterministic checks. Any failed blocker rejects the attempt without calling the LLM judge. */
export function runChecks(task: Task, outcome: TaskOutcome): CheckResult[] {
  const checks: CheckResult[] = [];
  const add = (id: string, passed: boolean, severity: IssueSeverity, failure: string) =>
    checks.push({ id, passed, severity, message: passed ? "ok" : failure });

  const output = outcome.output.trim();
  const lower = output.toLowerCase();
  const words = wordCount(output);
  add("output.non_empty", output.length >= 20, "blocker", "The output is empty or trivially short");
  add("summary.present", outcome.summary.trim().length > 0, "major", "The summary is missing");

  if (RESEARCH_CAPABILITIES.has(task.capability)) {
    const webSources = outcome.sources.filter((source) => source.url && /^https?:\/\//i.test(source.url));
    add("sources.present", webSources.length > 0, "blocker", "Research output must cite at least one web source with a URL");
  }

  for (const check of task.checks) {
    const value = check.value.trim();
    const number = Number.parseInt(value, 10);
    switch (check.kind) {
      case "minWords":
        if (Number.isFinite(number)) add(`minWords:${number}`, words >= number, "blocker", `The output has ${words} words; at least ${number} are required`);
        break;
      case "maxWords":
        if (Number.isFinite(number)) {
          add(`maxWords:${number}`, words <= number * 1.1, words > number * 1.5 ? "blocker" : "major", `The output has ${words} words; at most ${number} are allowed`);
        }
        break;
      case "contains":
        if (value) add(`contains:${value}`, lower.includes(value.toLowerCase()), "blocker", `The output must mention "${value}"`);
        break;
      case "sections": {
        const headings = value.split("|").map((heading) => heading.trim()).filter(Boolean);
        const missing = headings.filter((heading) => !lower.includes(heading.toLowerCase()));
        if (headings.length) add("sections", missing.length === 0, "blocker", `Missing required sections: ${missing.join(", ")}`);
        break;
      }
      case "minSources":
        if (Number.isFinite(number)) {
          add(`minSources:${number}`, outcome.sources.length >= number, "blocker", `${outcome.sources.length} sources cited; at least ${number} are required`);
        }
        break;
      case "minFindings":
        if (Number.isFinite(number)) {
          add(`minFindings:${number}`, outcome.keyFindings.length >= number, "major", `${outcome.keyFindings.length} key findings; at least ${number} expected`);
        }
        break;
    }
  }
  return checks;
}

export const blockingFailures = (checks: readonly CheckResult[]): CheckResult[] =>
  checks.filter((check) => !check.passed && check.severity === "blocker");
