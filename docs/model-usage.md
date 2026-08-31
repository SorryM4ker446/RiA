# Model settings and usage

Open **模型与用量** from the chat sidebar or Settings. Browser and Electron share the same per-account SQLite preferences. Choose the default mode and a default model for chat, images and videos. Explicitly created new conversations use those defaults; existing conversations retain their local controls. Requests that omit `modelId` use the saved default for that mode.

The catalog remains a maintained local list, not a live provider capability probe. Stored models missing from it and recent provider HTTP 404 responses appear as warnings. Generation does not silently replace a removed saved default. Choose an available model and save the settings. Catalog maintenance and provider snapshot checks are described in [Model catalog maintenance](model-catalog.md).

## Optional fallback

Automatic fallback is disabled by default. Each mode can specify one distinct backup model. Enabling it authorizes at most one additional model attempt and can incur additional charges. Successful media results and generation recipes identify the model actually used; the usage table lists primary and fallback attempts separately.

Chat falls back only before content is exposed and when no tools participate. After text, reasoning or a tool call starts, failure is reported without switching models. Cancellation, timeouts, provider authentication/permission/parameter errors and incompatible image input never trigger fallback. Eligible failures include an unavailable model (404), provider throttling (429), server errors and transport failures. Auxiliary nonstreaming chat/tool-planning and embedding calls are observed but do not use the configured chat fallback. Their existing SDK retry behavior remains separate from the main chat/media attempt limit.

Image/video fallback retains the request's prompt/options and requires a catalog model compatible with reference images. The media library's **按原参数重新生成** action always uses the recorded model, so its reproducibility contract is unchanged. A quota counts logical generation requests; fallback attempts are bounded but are not a provider spending limit. Failed or interrupted requests can still be billed.

## Usage and estimates

Each observed model attempt records its actual model ID, mode, result, duration, tokens when supplied, error code and fallback flag. It stores no new copy of prompts, keys or provider error bodies. Calls for chat context, intent/planning and embeddings are included when they run inside an authenticated application request. HTTP validation/configuration failures before reaching a model do not create model-attempt records. Duration measures the model attempt rather than the entire HTTP request.

The page shows the latest 100 calls and totals over the last 30 days. New recorded attempts opportunistically remove records older than 90 days and retain at most 5,000 per account. No calls means no usage-retention maintenance. Backups preserve the currently retained history.

Cost values have three explicit sources:

- **上游返回**: a numeric OpenRouter cost reported through the installed provider adapter.
- **配置估算**: user-entered USD prices per million input/output tokens, or per image/video request. Media per-request pricing takes precedence. There is no price feed or automatic exchange-rate conversion.
- **未报告 / 未配置**: unknown. Missing tokens or rates do not become zero. An explicitly configured or reported zero remains zero.

The known-cost total omits unknown costs and shows the number of unknown attempts beside it. A failed attempt does not get a synthetic per-request charge; an upstream-reported charge is retained. Usage recording is best effort: a storage failure logs the sanitized `model.usage.write_failed` event without discarding a successful model answer. Process termination or provider omissions can leave missing usage. This is an estimate/history view, not a complete billing ledger; check the provider's bill for payment decisions.

## Local API and configuration

`GET /api/models` returns `{ data, catalogs, unavailable, recentFailures }`. `PUT /api/models` accepts a complete strict preference object within 64 KiB and returns `{ data }`. Model IDs must exist in the corresponding catalog, fallback must be different from primary, and prices must be finite nonnegative numbers (maximum 1,000,000) or null. At most 100 model rate entries are accepted. `GET /api/usage` returns `{ data: { recent, totals, days } }`; it cannot query another user. Responses are private/no-store and follow the normal API security checks.

Preferences include `version: 1`, `defaultMode`, three `{ modelId, fallbackId }` mode objects, `rates`, `backupRetentionDays` and `backupMaxCount`. Read the latest object before replacing it. Rates contain `inputPerMillion`, `outputPerMillion` and `perRequest`; null means unspecified. The UI presents rates for selected generation models; an embedding model's rate can also be set through this API.

No new environment variable, API key, external service or dependency is required. Existing `OPENROUTER_API_KEY`, optional `EMBEDDING_MODEL_ID` and desktop encrypted key handling remain unchanged. Settings and usage tables are included in normal Prisma/Electron migrations and [account backups](account-backups.md).
