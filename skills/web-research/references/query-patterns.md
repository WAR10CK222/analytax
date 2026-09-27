# Query patterns

| Goal | Pattern | Example |
|---|---|---|
| Official facts | `<entity> official documentation <topic>` | `PostgreSQL official documentation logical replication limits` |
| Current state | `<topic> <year>` / `<product> <version> release notes` | `Kubernetes 1.34 release notes deprecations` |
| Comparisons | `<A> vs <B> <criterion> benchmark <year>` | `Qdrant vs Milvus recall latency benchmark 2026` |
| Numbers | `<metric> <entity> <year> report` | `global EV sales 2025 IEA report` |
| Pricing | `<product> pricing page` then fetch the vendor page | `Pinecone serverless pricing` |
| Known issues | `<product> <feature> known issues github` | `pgvector hnsw known issues github` |
| Primary data | `site:<domain> <topic>` when you know the authority | `site:sec.gov 10-K <company> 2025` |

Tips:
- Swap synonyms when a query returns marketing pages only ("limits" → "quotas", "maximum").
- Quote exact error messages or product names.
- For contested topics, search for the opposing view explicitly ("criticism", "limitations", "downsides").
