/** Example prompts on the Home screen. Each exercises a different path through the orchestrator. */
export const EXAMPLE_PROMPTS: readonly { title: string; query: string }[] = [
  {
    title: "Compare two databases",
    query:
      "Compare PostgreSQL and ClickHouse for ~2 TB/day of product analytics events: ingestion, query latency, cost and operational burden. Recommend one and explain the trade-offs.",
  },
  {
    title: "Size a market",
    query:
      "Estimate the 2026 EU market for AI code-review tools. State your assumptions, give a low/base/high range and include a short sensitivity table.",
  },
  {
    title: "Write a research brief",
    query: "What drove global EV sales growth in 2025, and what does it imply for lithium demand through 2030? Cite sources.",
  },
  {
    title: "Ask a quick question",
    query: "What is 17.5% of 2,340, and how many weekdays are there in March 2027?",
  },
];
