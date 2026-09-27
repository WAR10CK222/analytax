import { TIERS, type Tier } from "@analytax/contracts";
import { ChatGoogle } from "@langchain/google";
import { describe, expect, it } from "vitest";
import type { ModelSpec } from "../../src/config/schema.js";
import { thinkingParams } from "../../src/models/factory.js";
import { testConfig } from "../helpers.js";

type ThinkingConfig = { thinkingLevel?: string; thinkingBudget?: number; includeThoughts?: boolean };

/** The thinkingConfig ChatGoogle would send for a tier spec (no network: invocationParams only builds the body). */
function thinkingConfigFor(spec: ModelSpec): ThinkingConfig {
  const model = new ChatGoogle({ model: spec.model, apiKey: "test-key", ...thinkingParams(spec.thinking) });
  const params = model.invocationParams({} as never) as { generationConfig?: { thinkingConfig?: ThinkingConfig } };
  return params.generationConfig?.thinkingConfig ?? {};
}

const specs: [string, ModelSpec][] = TIERS.flatMap((tier: Tier) => {
  const spec = testConfig().models.tiers[tier];
  const entries: [string, ModelSpec][] = [[tier, spec]];
  if (spec.alternate) entries.push([`${tier} alternate`, spec.alternate]);
  return entries;
});

describe("thinkingConfig sent per tier", () => {
  it.each(specs)("%s sends exactly one of thinkingLevel or thinkingBudget", (_name, spec) => {
    const config = thinkingConfigFor(spec);
    const hasLevel = config.thinkingLevel !== undefined;
    const hasBudget = config.thinkingBudget !== undefined;
    expect(hasLevel !== hasBudget).toBe(true);
  });

  it.each(specs)("%s sends the configured value", (_name, spec) => {
    const config = thinkingConfigFor(spec);
    if ("level" in spec.thinking) expect(config.thinkingLevel?.toLowerCase()).toBe(spec.thinking.level);
    if ("budget" in spec.thinking) expect(config.thinkingBudget).toBe(spec.thinking.budget);
  });
});
