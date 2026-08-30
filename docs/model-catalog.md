# Maintaining the model catalog

`src/config/model.ts` is the curated, shared source for chat, image and video choices. Default IDs are explicit: reordering a list does not change the default. `MODEL_CATALOG_REVISION` records a local catalog edit, not the date provider availability was verified. The application never refreshes this list silently or switches a valid saved choice based on a remote response.

Run the offline consistency check before a release or after editing model choices:

```powershell
npm run models:check
```

The check validates IDs, required labels/capabilities, duplicates and membership of each default. Existing server tests run the same assertions, so CI does not depend on network access or provider credentials for this check.

To review provider changes, save a current model-list JSON response from the provider outside Git, then compare it without making model calls:

```powershell
npm run models:check -- --snapshot "D:\model-review\models.json"
```

The comparison uses `data[].id` and `architecture.input_modalities` / `output_modalities` from the [OpenRouter model-list contract](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). It flags missing entries, unavailable capability metadata and modality changes, and exits nonzero when review is needed. The command only reads the file, accepts at most 16 MiB, does not fetch or rewrite anything, and never needs a key. A partial or modality-specific snapshot can report missing items that still exist elsewhere; review them rather than deleting them automatically.

For an intentional update, verify the exact ID and applicable endpoint/capabilities, edit the curated entry, increment the revision date, and explicitly decide whether the default should change. Run the catalog, server, browser and desktop checks. Removed saved IDs already normalize to the configured default; chat API input still rejects unsupported IDs. Review preview and free-tier entries before each release, and never treat a synthetic snapshot test as proof of current availability, price, quality or successful generation. Real-provider acceptance is a separate, explicitly authorized check.
