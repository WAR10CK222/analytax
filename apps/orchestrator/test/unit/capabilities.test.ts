import { TIERS } from "@analytax/contracts";
import { describe, expect, it } from "vitest";
import type { ModelSpec } from "../../src/config/schema.js";
import { capabilityFor, describeThinking, thinkingAlwaysOn, validateModelSpec, validateModelsConfig } from "../../src/models/capabilities.js";
import { testConfig } from "../helpers.js";

const errorsFor = (spec: ModelSpec) => validateModelSpec(spec, "tier").errors;

describe("validateModelSpec", () => {
  it.each<[string, ModelSpec]>([
    ["minimal on 3.8 Flash", { model: "gemini-3.8-flash", thinking: { level: "minimal" } }],
    ["minimal on 3.7 Flash", { model: "gemini-3.7-flash", thinking: { level: "minimal" } }],
    ["minimal on 3.1 Pro", { model: "gemini-3.1-pro-preview", thinking: { level: "minimal" } }],
    ["medium on 3.1 flash-lite-image", { model: "gemini-3.1-flash-lite-image", thinking: { level: "medium" } }],
    ["budget on 3.1 Pro (silently mapped to a level)", { model: "gemini-3.1-pro-preview", thinking: { budget: 128 } }],
    ["budget 0 on 3.8 Flash (would become MINIMAL, a 400)", { model: "gemini-3.8-flash", thinking: { budget: 0 } }],
    ["budget -1 on 3.6 Flash (would become HIGH)", { model: "gemini-3.6-flash", thinking: { budget: -1 } }],
    ["budget 0 on 2.5 Pro", { model: "gemini-2.5-pro", thinking: { budget: 0 } }],
    ["budget below the 2.5 Pro minimum", { model: "gemini-2.5-pro", thinking: { budget: 64 } }],
    ["budget above the 2.5 Flash maximum", { model: "gemini-2.5-flash", thinking: { budget: 40_000 } }],
    ["a level on 2.5 Flash", { model: "gemini-2.5-flash", thinking: { level: "low" } }],
  ])("rejects %s", (_name, spec) => {
    expect(errorsFor(spec)).not.toHaveLength(0);
  });

  it.each<[string, ModelSpec]>([
    ["low on 3.1 Pro", { model: "gemini-3.1-pro-preview", thinking: { level: "low" } }],
    ["high on 3.1 Pro", { model: "gemini-3.1-pro-preview", thinking: { level: "high" } }],
    ["minimal on 3.6 Flash", { model: "gemini-3.6-flash", thinking: { level: "minimal" } }],
    ["medium on 3.8 Flash", { model: "gemini-3.8-flash", thinking: { level: "medium" } }],
    ["minimal on 3.1 flash-lite-image", { model: "gemini-3.1-flash-lite-image", thinking: { level: "minimal" } }],
    ["budget 0 on 2.5 Flash", { model: "gemini-2.5-flash", thinking: { budget: 0 } }],
    ["budget 128 on 2.5 Pro", { model: "gemini-2.5-pro", thinking: { budget: 128 } }],
    ["dynamic budget on 2.5 Pro", { model: "gemini-2.5-pro", thinking: { budget: -1 } }],
  ])("accepts %s", (_name, spec) => {
    expect(errorsFor(spec)).toEqual([]);
  });

  it("warns (does not fail) on unknown model families", () => {
    const issues = validateModelSpec({ model: "gemini-9-ultra", thinking: {} }, "tier");
    expect(issues.errors).toEqual([]);
    expect(issues.warnings.join(" ")).toContain("unknown model family");
  });
});

describe("the shipped config/models.yaml", () => {
  const config = testConfig();

  it("has no invalid tier or alternate", () => {
    expect(validateModelsConfig(config.models).errors).toEqual([]);
  });

  it.each(TIERS)("tier %s and its alternate use a known model family", (tier) => {
    const spec = config.models.tiers[tier];
    expect(capabilityFor(spec.model)).not.toBeNull();
    if (spec.alternate) expect(capabilityFor(spec.alternate.model)).not.toBeNull();
  });
});

describe("describeThinking labels", () => {
  it("is honest that Pro thinking cannot be turned off", () => {
    expect(describeThinking({ level: "low" }, "gemini-3.1-pro-preview")).toBe("thinking low (lowest; cannot be turned off)");
    expect(describeThinking({ budget: 128 }, "gemini-2.5-pro")).toBe("thinking budget 128 (minimum; cannot be turned off)");
    expect(thinkingAlwaysOn("gemini-3.1-pro-preview")).toBe(true);
    expect(thinkingAlwaysOn("gemini-2.5-flash")).toBe(false);
  });

  it("says minimal is near off, and only budget 0 is off", () => {
    expect(describeThinking({ level: "minimal" }, "gemini-3.6-flash")).toBe("thinking minimal (near off, not fully off)");
    expect(describeThinking({ budget: 0 }, "gemini-2.5-flash")).toBe("thinking off");
    expect(describeThinking({ budget: -1 }, "gemini-2.5-pro")).toBe("dynamic thinking");
    expect(describeThinking({ level: "medium" }, "gemini-3.8-flash")).toBe("thinking medium");
  });

  it("never uses dash punctuation (labels are shown in the UI)", () => {
    const labels = [
      describeThinking({ level: "low" }, "gemini-3.1-pro-preview"),
      describeThinking({ level: "minimal" }, "gemini-3.6-flash"),
      describeThinking({ budget: 128 }, "gemini-2.5-pro"),
    ];
    for (const label of labels) expect(label).not.toMatch(/[–—]/);
  });
});
