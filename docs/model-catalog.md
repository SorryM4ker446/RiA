# Maintaining the model catalog

Model names are no longer compiled into the application. `src/config/model.ts` is a legacy list kept only for the offline consistency script and the test fixtures; nothing under `src/` imports it at runtime, and `npm run models:check` validates that file rather than any user-visible catalog.

What a user sees comes from two places, and they are deliberately separate:

- **官方目录** — rows discovered from the provider's own endpoints, cached locally and refreshable. Discovering a model grants no right to call it.
- **我的模型** — the entries the user explicitly added. Only these can be selected, and only these pass the server-side check before any provider call.

Each provider has one adapter under `src/lib/models/providers/`; `index.ts` is the registry and `types.ts` the contract they all satisfy. An adapter owns that provider's conventions and nothing else: how to read its catalog, what shape a model id has there, how to build a chat/image/video/embedding model, and whether this instance holds its credentials. Everything above that file — the library, the defaults, the fallbacks, the leases, the usage log — identifies a model by `{ providerId, modelId }` and never reads a provider's protocol. To add a provider: write the adapter, register it in `src/lib/models/providers/index.ts`, add its id to `providerIds` in `src/lib/models/preferences-schema.ts`, and add the credential to the desktop settings store. A test fails the build if a registered adapter's id is not in that list, because otherwise a library row could name a provider the application cannot call.

Adding a provider is therefore not a change to any call site. It is also not free: the adapter must implement the protocol it claims, and a model that appears in a catalog is not evidence that the adapter handles every capability it advertises.

## Caching and failure

Each provider and category is cached for 24 hours. A failed refresh keeps the last good snapshot, marks it stale, and records why: rejected credentials, HTTP status, timeout, oversized or malformed body, unreachable host. These are distinguished on purpose — a rejected credential needs a settings change, an unreachable host usually does not. A category that fails never clears the others, and a catalog that parses with a few bad rows keeps the rows that validated and reports the skipped count.

## Availability is not routing

Library entries are annotated with what the catalogs currently say about them, and the page shows it. None of these states changes which model a call uses: a delisted model keeps its entry, its media recipes and its history, and is never silently replaced. A catalog that could not be read is reported as unavailable rather than as having delisted everything, because the absence of a row is a fact about the read, not about the model.

## Offline check

`npm run models:check` validates the legacy static file: ID shape, required labels and capabilities, duplicates, and that each default exists in its group. It reads no network and needs no key. It is a guard on a file the application no longer uses at runtime, so a green run says nothing about live provider availability.

To review a provider's own catalog without spending anything, save a model-list response outside the repository and compare it:

```powershell
npm run models:check -- --snapshot "D:\model-review\models.json"
```

The comparison uses `data[].id` and `architecture.input_modalities` / `output_modalities` from the [OpenRouter model-list contract](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-endpoints). It flags missing entries, unavailable capability metadata and modality changes, and exits nonzero when review is needed. A partial or modality-specific snapshot can report missing items that still exist elsewhere; review them rather than deleting them automatically.

Real-provider acceptance is a separate, explicitly authorized check. Never treat a synthetic snapshot or a passing offline check as proof of current availability, price, quality or successful generation.
