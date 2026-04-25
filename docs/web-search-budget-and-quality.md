# Web Search Budget and Quality Notes

## Current P0 Guardrail

The current Web Search tool keeps a per-turn result budget for automatic search. In one assistant turn, `webSearch` can retrieve at most 10 web results total. If the model asks for more than the remaining budget, the request is downgraded to the remaining budget. If the budget is already exhausted, the tool returns an empty result instead of interrupting the model response.

This is a P0 safety guardrail, not the final search-quality strategy.

## Why This Limit Helps

- Keeps search latency and provider cost bounded.
- Prevents repeated tool calls from expanding one answer into 20, 30, or more sources.
- Keeps the source panel readable and focused.
- Makes behavior explainable: one assistant turn has a clear external-search budget.
- Encourages the model to synthesize from a limited set of sources instead of blindly fetching more.

## Known Limitations

- Some research-style questions may need more than 10 raw sources to cover enough angles.
- If the first query is poorly phrased, the model may spend the budget before finding the best sources.
- A numeric cap does not guarantee source quality. Ten weak sources are still weak.
- The current limit couples fetched sources, model context, and UI-visible sources too tightly.
- Budget exhaustion prevents further web access in the same turn, even when a second narrower query would be useful.

## Better Future Direction

- Separate raw retrieval volume from final reasoning/display volume.
- Allow broader multi-query retrieval, then deduplicate and rerank before selecting the best sources.
- Feed only the top sources into the model context, even if more pages were fetched upstream.
- Show only a concise source set in the UI, with optional expansion for full retrieval traces.
- Add source quality scoring based on authority, recency, duplication, and relevance.
- Add reranking for query-result fit before synthesis.
- Use dynamic budgets by task type:
  - Simple factual lookup: 3-5 sources.
  - Normal current-information answer: 5-10 sources.
  - Product/game/event comparison or review: 10-15 sources after reranking.
  - Deep research mode: higher raw retrieval, but still capped context and UI output.
- Track and display search budget usage, such as fetched count and selected source count.

## Open Product Question

For P1, decide whether Web Search should remain a simple bounded tool or become a two-stage retrieval pipeline:

1. Fetch more candidate sources across one or more queries.
2. Deduplicate, rerank, and select the best sources for model reasoning and UI display.

The second design is better for research quality, but it requires stronger observability, ranking logic, and tests.
