---
name: structured-analysis
description: Framework for rigorous analysis — frame the decision, decompose it MECE, make assumptions explicit, quantify, and stress-test conclusions. Use for analysis, comparison or recommendation tasks.
license: MIT
metadata:
  version: "1.0"
  owner: analytax
---

# Structured analysis

## 1. Frame
- **Question**: the single decision or question being answered, phrased for the client's goal.
- **Scope & constraints**: what is in and out (budget, timeline, scale, compliance, existing stack).
- **Success looks like**: what the client will do with the answer.

## 2. Decompose (MECE)
Break the question into mutually exclusive, collectively exhaustive parts (e.g. cost / performance / risk / effort). Avoid overlapping criteria that double-count the same factor.

## 3. Evidence per part
For each part, pull the relevant upstream findings. Mark each input as fact (sourced), estimate (derived), or assumption (stated without evidence).

## 4. Quantify
- Convert qualitative statements into numbers where possible (orders of magnitude are fine).
- Use the calculator for every multi-step computation and show the formula in the output.
- Sanity-check results against a rough independent estimate.

## 5. Synthesize
State the conclusion first, then the two or three reasons that matter most. Don't list every consideration with equal weight.

## 6. Stress-test
- Which single assumption, if wrong, flips the conclusion? What is the break-even value?
- What would you check next with more time?

## Output skeleton
```
**Conclusion:** …
**Why:** 1) … 2) … 3) …
**Analysis:** (tables/numbers)
**Assumptions & sensitivities:** …
```
