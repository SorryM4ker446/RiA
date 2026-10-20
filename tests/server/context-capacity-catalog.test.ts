import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createTestDatabase } from "../helpers/database";
const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { getModelProvider } = await import("@/lib/models/providers");
const { addModel, getModelPreferences } = await import("@/lib/models/preferences");
after(async () => { await db.$disconnect(); cleanup(); });

test("OpenRouter and DeepSeek capacities survive catalog discovery and adding a model to the library", async t => {
  const rows = {
    openrouter: { id: "fixture/code-model", name: "Code model", context_length: 128_000, top_provider: { context_length: 96_000, max_completion_tokens: 12_000 }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"] },
    deepseek: { id: "deepseek-fixture", context_window: 64_000, max_output_tokens: 8192, output_modalities: ["text"] },
  };
  t.mock.method(globalThis, "fetch", async input => new Response(JSON.stringify({ data: [String(input).includes("openrouter.ai") ? rows.openrouter : rows.deepseek] }), { headers: { "content-type": "application/json" } }));
  for (const providerId of ["openrouter", "deepseek"] as const) {
    const discovered = await getModelProvider(providerId).fetchCatalog("chat", new AbortController().signal);
    assert.equal(discovered.models.length, 1);
    const model = discovered.models[0];
    assert.equal(model.contextLength, providerId === "openrouter" ? 96_000 : 64_000);
    assert.equal(model.maxOutputTokens, providerId === "openrouter" ? 12_000 : 8192);
    await db.modelCatalogSnapshot.create({ data: { providerId, mode: "chat", fetchedAt: new Date(), models: discovered.models as never } });
    const added = await addModel({ providerId, modelId: model.modelId });
    assert.equal(added.data.maxOutputTokens, model.maxOutputTokens);
    assert.equal((await getModelPreferences()).library.find(row => row.providerId === providerId)?.contextLength, model.contextLength);
  }
});
