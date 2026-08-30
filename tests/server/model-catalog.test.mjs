import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogGroups, checkCatalog, compareCatalogSnapshot } from "../../scripts/check-model-catalog.mjs";

test("curated model defaults remain explicit and catalog identifiers stay valid", () => {
  assert.doesNotThrow(() => checkCatalog());
  assert.doesNotThrow(() => checkCatalog(catalogGroups.map((group) => ({ ...group, models: [...group.models].reverse() }))));
  assert.throws(() => checkCatalog([{ ...catalogGroups[0], defaultId: "missing/model" }]), /default/);
  assert.throws(() => checkCatalog([{ ...catalogGroups[0], models: [catalogGroups[0].models[0], catalogGroups[0].models[0]] }]), /Duplicate/);
});

test("model snapshot comparisons flag removals and modality changes without updating the catalog", () => {
  const snapshot = { data: catalogGroups.flatMap((group) => group.models.map((model) => ({
    id: model.id, architecture: { input_modalities: model.supportsImageInput ? ["text", "image"] : ["text"], output_modalities: [group.output] },
  }))) };
  assert.deepEqual(compareCatalogSnapshot(snapshot), []);
  snapshot.data.shift();
  snapshot.data[0].architecture.input_modalities = ["image"];
  snapshot.data[1].architecture.output_modalities = [];
  delete snapshot.data[2].architecture;
  const issues = compareCatalogSnapshot(snapshot);
  assert.deepEqual(issues.map((issue) => issue.reason), ["missing-from-snapshot", "image-input-capability-changed", "output-capability-changed", "capabilities-unavailable"]);
  assert.throws(() => compareCatalogSnapshot({ data: "invalid" }));
  assert.doesNotThrow(() => checkCatalog());
});
