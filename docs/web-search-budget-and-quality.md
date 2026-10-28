# Web search routing and evidence

RiA exposes one `webSearch` tool. The model decides when it helps; ordinary questions do not start a mandatory lookup. Template restrictions continue to apply. Search always runs through the selected chat model's provider; there is no separate search service or key.

| Selected provider | Preferred search path |
| --- | --- |
| DeepSeek `deepseek-v4-pro` | Native `web_search` through the official Responses API |
| Other DeepSeek chat models, including Flash | Official independent `POST /v1/tools/search`; structured results go back to the chat model |
| OpenRouter | Gateway `openrouter:web_search`, with gateway engine selection |
| No provider key for the selected model | Search is unavailable and reported as not configured |

The native DeepSeek capability is documented for that exact model. Independent DeepSeek searches accept up to 128 Unicode characters; oversized queries are reported for reformulation instead of silently truncating operators. Configure the selected provider key normally. `DEEPSEEK_BASE_URL` also applies to search, so a DeepSeek-compatible endpoint must implement the search routes to provide search.

Sources: [DeepSeek Search](https://api-docs.deepseek.com/guides/search/), [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/), [OpenRouter server search](https://openrouter.ai/docs/guides/features/server-tools/web-search), reviewed 2026-10-18. OpenRouter server tools are beta. Deprecated web plugins and `:online` suffixes are not used.

## Limits and failure handling

The conversation model chooses `maxResults` according to the question. RiA has no fixed five-result default, ten-result call limit or per-turn result-count quota. Manual Web Search shows only the query; when the count is absent, the selected chat model produces a structured count plan before the search. That planning call uses normal model admission and usage accounting; if planning fails or is cancelled, no search is started and no fixed count is substituted.

Only the search services' documented per-request limits are applied at transport: DeepSeek independent Search accepts up to 50 results and OpenRouter gateway search up to 25. Native engines may ignore requested counts; the DeepSeek native request includes the model's target in its prompt. Requests larger than a service's ceiling are capped to that ceiling; the model can make further focused searches within the existing run step, time and failure limits. All normalized requested results are available to answer synthesis, rather than only the first five.

Provider requests and count planning have a 60-second transport deadline. OpenRouter still receives `max_tool_calls: 1` and `max_uses: 1` per tool invocation. DeepSeek does not support a server-side `max_tool_calls` bound. These execution controls remain separate from result counts and do not bound all upstream internal searches.

Native searches run as a tool subrequest, then pass citations, excerpts and any evidence summary to the conversation model. Requests use existing model-library leases, admission and usage accounting. Provider-reported OpenRouter cost is recorded; unreported charges remain unknown. Search fees may be additional to token costs. These limits are not a guaranteed total-spend cap.

No matches, no search executed and provider failure remain distinct. A provider search route that is unavailable (HTTP 404/501), and permission, balance, quota, timeout and ambiguous upstream failures, are reported after one request; they never trigger a second paid search on another engine or bypass provider policies. The actual engine remains in the result. Cancellation reaches the HTTP transport. Provider results are deduplicated and bounded by the requested count and response-size limits; source links are restricted to HTTP(S). Retrieved material is untrusted reference data.

## Presentation and verification

Web/document sources, tool input/output and retrieval diagnostics appear in **Execution records**. Its compact list groups linked approval continuations into one request; expansion shows tool calls, used sources and diagnostic information. Sources and verbose input/output are disclosed on demand. Pending approvals appear in a card above the composer without opening the records sheet. Inline answer citations remain in chat. A limitation is explained only when a requested action cannot be completed, distinguishing template restrictions from missing configuration.

Offline tests cover each protocol, provider-only routing, missing searches versus empty results, cancellation, errors, usage accounting and template restrictions. Browser tests cover autonomous gateway search and persisted execution details. These verify integration contracts; real account access, search quality and billing require live-service validation.
