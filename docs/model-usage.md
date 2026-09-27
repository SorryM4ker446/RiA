# Model settings and usage

Open **模型与用量** from the chat sidebar or Settings. Browser and Electron share the same local SQLite preferences. Browse the official OpenRouter chat, image, video and embedding catalogs, then add models to **我的模型**. Only library members appear in chat selectors or pass server-side call validation. New installations have an empty library and no selected defaults. Explicitly created new conversations use configured defaults; existing conversations retain their local controls.

Catalog categories refresh on demand and are cached locally for 24 hours. A failed refresh keeps the last successful snapshot and marks it stale. Each response is bounded, timed out and validated before it replaces a snapshot. Removing a model clears matching defaults and fallbacks atomically and prevents subsequent calls using a conversation's stale selection. Calls already submitted to the provider may finish; calls that have not yet reached the provider are rejected. Previous saved model IDs migrate to explicit candidates and are never enabled automatically. The installed provider can still report a model unavailable after it appears in the official catalog.

OpenRouter image models aggregate capabilities across providers. When a user adds an image-generation model, the app also requests its official per-endpoint records and marks reference-image support only when an endpoint advertises `input_references`. This describes available endpoints; upstream routing and availability can still change.

## Optional fallback

Automatic fallback is disabled by default. Each mode can specify one distinct backup model. Enabling it authorizes at most one additional model attempt and can incur additional charges. Successful media results and generation recipes identify the model actually used; the usage table lists primary and fallback attempts separately.

Chat falls back only before content is exposed and when no tools participate. After text, reasoning or a tool call starts, failure is reported without switching models. Cancellation, timeouts, provider authentication/permission/parameter errors and incompatible image input never trigger fallback. Eligible failures include an unavailable model (404), provider throttling (429), server errors and transport failures. Auxiliary nonstreaming chat/tool-planning and embedding calls are observed but do not use the configured chat fallback. Their existing SDK retry behavior remains separate from the main chat/media attempt limit.

Image/video fallback retains the request's prompt/options and requires a library model compatible with reference images. For image generation, reference-image support must be confirmed by endpoint data; if endpoint data cannot be read, text-only generation remains available. The media library's **按原参数重新生成** action always uses the recorded model, so its reproducibility contract is unchanged. A quota counts logical generation requests; fallback attempts are bounded but are not a provider spending limit. Failed or interrupted requests can still be billed.

## Usage and estimates

Each observed model attempt records its actual model ID, mode, result, duration, tokens when supplied, error code and fallback flag. It stores no new copy of prompts, keys or provider error bodies. Calls for chat context, intent/planning and embeddings are included when they run inside an authenticated application request. HTTP validation/configuration failures before reaching a model do not create model-attempt records. Duration measures the model attempt rather than the entire HTTP request.

The page shows the latest 100 calls and totals over the last 30 days. New recorded attempts opportunistically remove records older than 90 days and retain at most 5,000 records. No calls means no usage-retention maintenance. Backups preserve the currently retained history.

Cost values have three explicit sources:

- **上游返回**: a numeric OpenRouter cost reported through the installed provider adapter.
- **配置估算**: user-entered USD prices per million input/output tokens, or per image/video request. Media per-request pricing takes precedence. There is no price feed or automatic exchange-rate conversion.
- **未报告 / 未配置**: unknown. Missing tokens or rates do not become zero. An explicitly configured or reported zero remains zero.

The known-cost total omits unknown costs and shows the number of unknown attempts beside it. A failed attempt does not get a synthetic per-request charge; an upstream-reported charge is retained. Usage recording is best effort: a storage failure logs the sanitized `model.usage.write_failed` event without discarding a successful model answer. Process termination or provider omissions can leave missing usage. This is an estimate/history view, not a complete billing ledger; check the provider's bill for payment decisions.

## Local API and configuration

`GET /api/models/catalog?mode=chat|image|video|embedding` returns one normalized catalog and its cache state. `POST /api/models/catalog` refreshes one category (`{ "mode": "image" }`) or all categories (`{}`). `POST /api/models/library` accepts `{ "action": "add"|"remove", "modelId": "provider/model" }`. `GET /api/models` returns `{ data, recentFailures }`; `PUT /api/models` accepts a complete strict preference object within 128 KiB and returns `{ data }`. Selected models and fallbacks must be compatible library members, fallback must differ from primary, and prices must be finite nonnegative numbers (maximum 1,000,000) or null. At most 100 model rate entries are accepted. `GET /api/usage` returns `{ data: { recent, totals, days } }`; it cannot query outside the local workspace. Responses are private/no-store and follow the normal local access checks.

Preferences include `version: 2`, `defaultMode`, three nullable `{ modelId, fallbackId }` mode objects, nullable `embeddingModelId`, `library`, `legacyCandidates`, `rates`, `backupRetentionDays` and `backupMaxCount`. Read the latest object before replacing it; the server owns and preserves the library field. Rates contain `inputPerMillion`, `outputPerMillion` and `perRequest`; null means unspecified. Semantic memory embeddings run only when an embedding model has been explicitly added and selected. Stored vectors are tagged with their model ID and only compared with vectors from that same model; changing models falls back to keyword retrieval until memories are updated.

OpenRouter's official catalog endpoints are called by the local server and use the existing `OPENROUTER_API_KEY` when configured; the key is never returned to the browser. `EMBEDDING_MODEL_ID` is read only as a migration candidate when upgrading pre-library preferences and does not select a runtime model. Desktop encrypted key handling is unchanged. Preferences and library membership are included in [workspace backups](workspace-backups.md); catalog snapshots are a refreshable cache.
