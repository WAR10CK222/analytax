---
name: decision-matrix
description: Weighted decision matrix for comparing options transparently — criteria weighting, 1–5 scoring with evidence, weighted totals and sensitivity checks. Use when a task asks to compare or recommend among options.
license: MIT
metadata:
  version: "1.0"
  owner: analytax
---

# Decision matrix

1. **Criteria (3–7)** derived from the client's goal and constraints. Each criterion must be distinct and observable.
2. **Weights** summing to 100, justified in one line each by the client's priorities. If priorities are unknown, use equal weights and say so.
3. **Scores 1–5** per option per criterion, each backed by a short evidence note referencing upstream findings. Use this scale:
   - 5 = clearly best in class for this client · 3 = adequate · 1 = poor or disqualifying
4. **Hard constraints first**: any option that violates a must-have is excluded before scoring (list why).
5. **Weighted total** = Σ(weight × score) / 100 — compute with the calculator.
6. **Sensitivity**: re-run with the top weight ±10 points. If the winner changes, the recommendation is conditional — state the condition.

Use the template in `assets/decision-matrix-template.md` for the output table.
