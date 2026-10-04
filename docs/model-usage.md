# Model settings and usage

Model removal waits for an active chat stream to finish, fail or be cancelled,
including the time after the provider returns its stream object. A submission
failure releases the lease as well. This does not cancel an ongoing response;
new calls cannot acquire a lease once removal begins.

Tool-enabled turns require a stored run. Each tool step atomically checks its
run budget and reserves a unique step position before executing. Concurrent
tool calls share that budget, and a failed reservation executes no side effect.
Completed-step reporting remains best-effort after the operation has happened.

Open **模型与用量** from the chat sidebar or Settings. Browser and Electron share the same local SQLite preferences. Browse the official OpenRouter chat, image, video and embedding catalogs, then add models to **我的模型**. Only library members appear in chat selectors or pass server-side call validation.

A model is identified by a **reference**: a provider plus that provider's model id (`{ providerId, modelId }`). The two halves are not interchangeable — the same underlying model reached through OpenRouter and reached directly are separate library entries with separate credentials, pricing and availability, and each keeps its own default, fallback and rate entry. Every call path (chat, image, video, media regeneration, embeddings, tool synthesis, fallback) authorizes against that pair. New installations have an empty library and no selected defaults. Explicitly created new conversations use configured defaults; existing conversations retain their local controls.

Catalog categories refresh on demand and are cached locally for 24 hours, per provider and per category. A failed refresh keeps the last successful snapshot, marks it stale, and records the reason next to it so the next page load can still say whether the credential was rejected, the host was unreachable or the response was unusable. Each response is bounded, timed out and validated before it replaces a snapshot. A provider that is not configured locally, one whose credential was rejected, and one that is merely unreachable are reported as different states, because they call for different action.

Each library entry also carries a current availability state shown next to it: **可用**, **未配置密钥**, **目录暂不可用** or **官方目录已不再提供**. These states are display only. A delisted model keeps its entry, its media recipes and its history; nothing is swapped for another model automatically, because a silent substitution spends money on a different one. Removing a model clears matching defaults and fallbacks atomically and prevents subsequent calls using a conversation's stale selection. Calls already submitted to the provider may finish; calls that have not yet reached the provider are rejected. Previous saved model IDs migrate to explicit candidates and are never enabled automatically. The installed provider can still report a model unavailable after it appears in the official catalog.

OpenRouter image models aggregate capabilities across providers. When a user adds an image-generation model, the app also requests its official per-endpoint records and marks reference-image support only when an endpoint advertises `input_references`. This describes available endpoints; upstream routing and availability can still change.

## DeepSeek (direct)

The catalog page has a provider row above the model-type tabs: the same model id reached through two providers is two different entries, and merging them into one list would hide which one the add button would add. A provider with no key says so instead of showing an empty list.

A second provider can be configured on its own. With only a DeepSeek key set, chat works end to end: models are discovered from the official list, added to **我的模型**, selected, and called. Image and video generation still need OpenRouter, and the application says so rather than offering a mode that cannot run. Memory search falls back to keyword scoring because this provider offers no embedding model.

The chat protocol is implemented directly rather than by pointing an OpenAI-shaped client at a different base URL, because three parts of it are not OpenAI-shaped and each one fails quietly otherwise:

- **Thinking mode is on by default upstream.** While it is on, the API rejects a `required` or named tool choice with a 400. Those are downgraded to `auto` rather than forwarded. `DEEPSEEK_THINKING=disabled` turns the mode off, in which case sampling parameters are sent; while it is on they are omitted, because the API ignores them.
- **`reasoning_content` is the chain of thought.** When a request carries tools, the API requires the reasoning of previous assistant turns to be sent back or it returns 400. Reasoning produced during a turn therefore travels back out with the next request, and the same provider's tool chain keeps what it needs.
- **Usage arrives on the last streamed chunk**, with cache hits reported separately from fresh input. The usage view shows the three numbers rather than one total.

Capabilities the official model list does not report — currently only tool support — come from a written rule in `src/lib/models/providers/deepseek.ts` that names its source and the date it was checked. The list itself is never hardcoded: a renamed model stops being offered, because nothing in the source remembers its old name.

Images are inlined as the documented `image_url` block with a data URL, in user messages only; the provider answers 400 for one anywhere else, so an image in an assistant turn is dropped rather than failing the request. A private media path is never forwarded as a link the provider cannot fetch, and a format outside JPEG, PNG, GIF and WebP is refused before the request is sent.

**Thinking mode** is a request setting, stored per workspace and edited on this page. The provider decides how to express it: DeepSeek maps it to its toggle and effort, and a toggle that is off is never sent together with an effort. A provider with no notion of it ignores the setting and its requests are unchanged.

**Reasoning is stored with the message.** Some providers require a previous assistant turn's chain of thought to travel back on the next request that uses tools, and the model will not produce it a second time on demand. It is kept in the message it belongs to and replayed with the next request, and it is included in workspace backups like the rest of a message. In the conversation it is shown in its own collapsed block above the answer, opening by itself while the turn is still arriving: the model's working and its conclusion are different claims, and folding them together makes both harder to read.

`DEEPSEEK_BASE_URL` overrides the endpoint for a proxy or an offline fixture. It changes where a request goes, never what it means, and carries no credential.

## When web search is not configured

An optional tool that is not configured is absent, not broken. The search tool is not handed to the model at all, so the model cannot call it, retry it, or spend a step discovering it is missing, and no search request is made. The chat prompt says plainly that this turn has no internet access, so a question that depends on current information is answered from knowledge with that said out loud rather than presented as if it had been checked. The manual tool picker shows the search entry as unavailable instead of hiding it, and the model page shows a `自带联网（额外计费）` badge on any model that searches on the provider's side.

The same rule applies to a per-turn result budget: a lookup skipped because the budget is spent is returned as a skipped result, never as an empty result set, so "we did not look" cannot read as "we looked and found nothing".

A tool that becomes unavailable **during** a turn — a key cleared in another window between the tools being built and the call running — answers with the same controlled result instead of failing the turn, so the model is told once and spends the rest of the turn on what it can do. The same applies to a transient search failure (timeout, throttling, unreachable): a lookup that failed is not a lookup that found nothing, and the model should not keep asking a service that is already refusing. This path is only for optional tools that are merely unavailable. A rejected approval, a bad argument or a refused write still fails as before — degradation never swallows a decision the user or the caller made.

Each turn records which optional tools it could not use, and the message carries a `本轮未联网` badge from the stored turn rather than from the live stream, so a reloaded conversation says the same thing the first time did.

## Optional fallback

Automatic fallback is disabled by default. Each mode can specify one distinct backup model. Enabling it authorizes at most one additional model attempt and can incur additional charges. Successful media results and generation recipes identify the model actually used; the usage table lists primary and fallback attempts separately.

Chat falls back only before content is exposed and when no tools participate. After text, reasoning or a tool call starts, failure is reported without switching models. Cancellation, timeouts, provider authentication/permission/parameter errors and incompatible image input never trigger fallback. Eligible failures include an unavailable model (404), provider throttling (429), server errors and transport failures. Auxiliary nonstreaming chat/tool-planning and embedding calls are observed but do not use the configured chat fallback. Their existing SDK retry behavior remains separate from the main chat/media attempt limit.

Image/video fallback retains the request's prompt/options and requires a library model compatible with reference images. For image generation, reference-image support must be confirmed by endpoint data; if endpoint data cannot be read, text-only generation remains available. The media library's **按原参数重新生成** action always uses the recorded model, so its reproducibility contract is unchanged. A quota counts logical generation requests; fallback attempts are bounded but are not a provider spending limit. Failed or interrupted requests can still be billed.

## Usage and estimates

Each observed model attempt records its actual model ID and provider, mode, result, duration, tokens when supplied, error code and fallback flag. It stores no new copy of prompts, keys or provider error bodies. Calls for chat context, intent/planning and embeddings are included when they run inside an authenticated application request. HTTP validation/configuration failures before reaching a model do not create model-attempt records. Duration measures the model attempt rather than the entire HTTP request.

The page shows the latest 100 calls and totals over the last 30 days. New recorded attempts opportunistically remove records older than 90 days and retain at most 5,000 records. No calls means no usage-retention maintenance. Backups preserve the currently retained history.

Cost values have three explicit sources:

- **上游返回**: a numeric OpenRouter cost reported through the installed provider adapter.
- **配置估算**: user-entered USD prices per million input/output tokens, per image/video request, and optionally per million **cache-read and cache-write** tokens. Media per-request pricing takes precedence. There is no price feed or automatic exchange-rate conversion.

A cached read is not an ordinary input token: providers bill it differently, and charging it at the full input price overstates exactly the cheapest requests. When a provider reports the split, it is priced with the cache rates; when no cache rate is filled in, the input rate applies, so a configuration without one means what it always meant.
- **未报告 / 未配置**: unknown. Missing tokens or rates do not become zero. An explicitly configured or reported zero remains zero.

The known-cost total omits unknown costs and shows the number of unknown attempts beside it. A failed attempt does not get a synthetic per-request charge; an upstream-reported charge is retained. Usage recording is best effort: a storage failure logs the sanitized `model.usage.write_failed` event without discarding a successful model answer. Process termination or provider omissions can leave missing usage. This is an estimate/history view, not a complete billing ledger; check the provider's bill for payment decisions.

## Local API and configuration

Daily and weekly workspace overviews use the existing model wrapper and appear
in usage history, including failed attempts and unknown costs. Each scheduled
execution has its own request ID. Overviews use current workspace totals, not
activity within the last day or week; the cadence controls when the snapshot is
generated. Each call has no retries, a 60-second abort deadline and a maximum of
512 output tokens. Conversation and message rows are committed together after
generation succeeds. Earlier generated conversations are retained unchanged.

`GET /api/models/catalog?mode=chat|image|video|embedding` returns the normalized catalogs grouped by provider (`{ catalogs: { openrouter: { chat, image, video, embedding } } }`) together with `providers`, which reports each provider's display name and whether this instance holds its credentials. `POST /api/models/catalog` refreshes one category (`{ "mode": "image" }`) or everything (`{}`); both accept an optional `providerId`. `POST /api/models/library` accepts `{ "action": "add"|"remove", "model": { "providerId", "modelId" } }`. `GET /api/models` returns `{ data, availability, recentFailures }`, where `availability` is keyed by `provider:model`; `PUT /api/models` accepts a complete strict preference object within 128 KiB and returns `{ data }`. Selected models and fallbacks must be compatible library members, fallback must differ from primary, and prices must be finite nonnegative numbers (maximum 1,000,000) or null. At most 100 model rate entries are accepted. `GET /api/usage` returns `{ data: { recent, totals, days } }`; it cannot query outside the local workspace. Responses are private/no-store and follow the normal local access checks.

Preferences include `version: 3`, `defaultMode`, three nullable `{ model, fallback }` mode objects whose members are model references, a nullable `embedding` reference, `library`, `legacyCandidates`, `rates`, `backupRetentionDays` and `backupMaxCount`. Version 1 and version 2 documents are still accepted and converted on read: version 1 becomes explicit migration candidates, and version 2's bare ids become OpenRouter references, because every model this application has called so far was reached through OpenRouter. `rates` is keyed by `provider:model`. Read the latest object before replacing it; the server owns and preserves the library field. Rates contain `inputPerMillion`, `outputPerMillion` and `perRequest`; null means unspecified. Semantic memory embeddings run only when an embedding model has been explicitly added and selected. Stored vectors are tagged with their model **and provider** and are only compared with vectors written by the same pair; a row without a recorded provider is left out of semantic matching rather than assumed. Changing the embedding model therefore falls back to keyword retrieval — the 嵌入模型 section on the page reports how many memories are in that state and offers an explicit, confirmed rebuild. Rebuilding issues one embedding request per memory and is never triggered automatically.

OpenRouter's official catalog endpoints are called by the local server and use the existing `OPENROUTER_API_KEY` when configured; the key is never returned to the browser. `EMBEDDING_MODEL_ID` is read only as a migration candidate when upgrading pre-library preferences and does not select a runtime model. Desktop encrypted key handling is unchanged. Preferences and library membership are included in [workspace backups](workspace-backups.md); catalog snapshots are a refreshable cache.
