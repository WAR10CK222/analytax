import type { Tier } from "@analytax/contracts";
import type { ModelSpec, ModelsConfig, ThinkingLevel, ThinkingSpec } from "../config/schema.js";

export type ModelCapability = {
  family: string;
  control: "level" | "budget";
  levels?: readonly ThinkingLevel[];
  budget?: { min: number; max: number; canDisable: boolean };
  preview: boolean;
};

const ALL_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];

/** Thinking-control capability matrix (verified against the Gemini API docs, 2026-09-22). First match wins. */
const RULES: readonly { test: RegExp; capability: ModelCapability }[] = [
  { test: /^gemini-3\.1-pro/, capability: { family: "gemini-3.1-pro", control: "level", levels: ["low", "medium", "high"], preview: true } },
  { test: /^gemini-3(\.\d+)?-flash-lite-image/, capability: { family: "gemini-3.x-flash-lite-image", control: "level", levels: ["minimal", "high"], preview: false } },
  { test: /^gemini-3(\.\d+)?-flash-lite/, capability: { family: "gemini-3.x-flash-lite", control: "level", levels: ALL_LEVELS, preview: false } },
  { test: /^gemini-3\.(7|8)-flash/, capability: { family: "gemini-3.7/3.8-flash", control: "level", levels: ["low", "medium", "high"], preview: false } },
  { test: /^gemini-3(\.\d+)?-flash/, capability: { family: "gemini-3.x-flash", control: "level", levels: ALL_LEVELS, preview: false } },
  { test: /^gemini-2\.5-pro/, capability: { family: "gemini-2.5-pro", control: "budget", budget: { min: 128, max: 32768, canDisable: false }, preview: false } },
  { test: /^gemini-2\.5-flash-lite/, capability: { family: "gemini-2.5-flash-lite", control: "budget", budget: { min: 512, max: 24576, canDisable: true }, preview: false } },
  { test: /^gemini-2\.5-flash/, capability: { family: "gemini-2.5-flash", control: "budget", budget: { min: 1, max: 24576, canDisable: true }, preview: false } },
];

export function capabilityFor(model: string): ModelCapability | null {
  const rule = RULES.find((candidate) => candidate.test.test(model));
  if (!rule) return null;
  return { ...rule.capability, preview: rule.capability.preview || model.includes("preview") };
}

/** True when the model cannot run with thinking fully off (every Pro model, and Gemini 3.x at any level). */
export function thinkingAlwaysOn(model: string): boolean {
  const capability = capabilityFor(model);
  if (!capability) return false;
  if (capability.control === "level") return true;
  return capability.budget?.canDisable === false;
}

/**
 * Human-readable thinking setting. Pass the model so the label is honest about what the model can do: Gemini 3.x
 * `minimal` still "may think very minimally", and no Pro model can turn thinking off.
 */
export function describeThinking(thinking: ThinkingSpec, model?: string): string {
  if ("level" in thinking) {
    const base = `thinking ${thinking.level}`;
    if (!model) return base;
    const capability = capabilityFor(model);
    const lowest = capability?.levels?.[0];
    if (thinking.level === "minimal") return `${base} (near off, not fully off)`;
    if (capability && lowest === thinking.level) return `${base} (lowest; cannot be turned off)`;
    return base;
  }
  if ("budget" in thinking) {
    if (thinking.budget === 0) return "thinking off";
    if (thinking.budget === -1) return "dynamic thinking";
    const suffix = model && thinkingAlwaysOn(model) && thinking.budget === capabilityFor(model)?.budget?.min ? " (minimum; cannot be turned off)" : "";
    return `thinking budget ${thinking.budget}${suffix}`;
  }
  return "model default thinking";
}

export type SpecIssues = { errors: string[]; warnings: string[] };

/**
 * Rejects combinations that would fail or silently change meaning at request time: `minimal` on 3.7/3.8 Flash
 * (HTTP 400), budget 0 on Pro, and any `budget` on a Gemini 3.x model (LangChain maps it to a level, e.g. 0 becomes
 * MINIMAL and -1 becomes HIGH, so the configured value is not what gets sent).
 */
export function validateModelSpec(spec: ModelSpec, label: string): SpecIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const capability = capabilityFor(spec.model);
  if (!capability) {
    warnings.push(`${label}: unknown model family '${spec.model}'; thinking settings are not validated`);
    return { errors, warnings };
  }
  const { thinking } = spec;
  if ("level" in thinking) {
    if (capability.control === "budget") {
      errors.push(`${label}: ${spec.model} uses thinking.budget (Gemini 2.5), not thinking.level`);
    } else if (capability.levels && !capability.levels.includes(thinking.level)) {
      errors.push(`${label}: ${spec.model} does not support thinking level '${thinking.level}' (allowed: ${capability.levels.join(", ")})`);
    }
  } else if ("budget" in thinking) {
    if (capability.control === "level") {
      errors.push(
        `${label}: ${spec.model} is controlled by thinking.level (${capability.levels?.join(", ")}); a budget would be silently mapped to a level`,
      );
    } else if (capability.budget && thinking.budget !== -1) {
      const { min, max, canDisable } = capability.budget;
      if (thinking.budget === 0 && !canDisable) errors.push(`${label}: ${spec.model} cannot disable thinking (minimum budget ${min})`);
      else if (thinking.budget !== 0 && (thinking.budget < min || thinking.budget > max)) {
        errors.push(`${label}: thinking budget ${thinking.budget} is outside ${min}-${max} for ${spec.model}`);
      }
    }
  }
  if (capability.preview) warnings.push(`${label}: ${spec.model} is a preview model (stricter rate limits)`);
  return { errors, warnings };
}

export function validateModelsConfig(config: ModelsConfig): SpecIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [tier, spec] of Object.entries(config.tiers) as [Tier, ModelsConfig["tiers"][Tier]][]) {
    const primary = validateModelSpec(spec, `tiers.${tier}`);
    errors.push(...primary.errors);
    warnings.push(...primary.warnings);
    if (spec.alternate) {
      const alternate = validateModelSpec(spec.alternate, `tiers.${tier}.alternate`);
      errors.push(...alternate.errors);
      warnings.push(...alternate.warnings);
    }
  }
  return { errors, warnings: [...new Set(warnings)] };
}
