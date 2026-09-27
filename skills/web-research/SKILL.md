---
name: web-research
description: Systematic web research workflow — decompose the question, run iterative searches, triage and read sources, and record cited findings. Use for any task that needs more than a single quick lookup.
license: MIT
metadata:
  version: "1.0"
  owner: analytax
---

# Web research

## 1. Decompose before searching
Write down (for yourself) the 2–5 sub-questions whose answers together satisfy the task. For each, note what a *good* source would be (official documentation, standards body, regulator, company filing, peer-reviewed paper, reputable benchmark).

## 2. Search iteratively
- Start broad with 1–2 searches per sub-question, then narrow using the vocabulary you learn (product names, version numbers, official terminology).
- Add a year or version to queries for anything that changes over time.
- See `references/query-patterns.md` for patterns that work well.
- Stop searching a sub-question once two independent, credible sources agree — or once you can clearly state that the information is not publicly available.

## 3. Triage and read
- Skim search results for authority and recency before fetching.
- Fetch the primary source rather than trusting a search snippet for any claim that drives the conclusion.
- Watch for dates: a 2023 benchmark is not evidence about a 2026 release.

## 4. Record as you go
Keep a running list of `claim → source → date/version`. It becomes your `keyFindings` and `sources`.

## 5. Report
- Organize the output by sub-question.
- Cite with `[n]` markers in the order of your `sources` list.
- Explicitly list what you could not verify.

## Budget discipline
Your tool calls are limited. Prefer fewer, sharper searches; never repeat an identical query — change the wording or the angle.
