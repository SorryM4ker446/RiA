import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCatalogPrices } from "../../src/features/models/catalog-pricing";

test("catalog token prices convert to dollars per million without rounding small nonzero rates to free", () => {
  assert.deepEqual(formatCatalogPrices({ completion: "1e-5", prompt: "0.0000025", input_cache_read: "0.0000000001" }), [
    "$2.5/M input tokens", "$10/M output tokens", "$0.0001/M cache read tokens",
  ]);
  assert.deepEqual(formatCatalogPrices({ prompt: "0", completion: "0.0" }), ["$0/M input tokens", "$0/M output tokens"]);
});

test("per-image, per-request and video prices retain their billing units", () => {
  assert.deepEqual(formatCatalogPrices({ image: "0.04", request: "0.003", duration_seconds: "0.08", image_output: "0.12" }), [
    "$0.04/input image", "$0.003/request", "$0.08/second", "$0.12/output image",
  ]);
});

test("missing and invalid prices are never presented as free and unknown units remain unconverted", () => {
  assert.deepEqual(formatCatalogPrices({}), []);
  for (const raw of ["", " ", "NaN", "Infinity", "-1", "1e308", "0x10"]) {
    assert.deepEqual(formatCatalogPrices({ prompt: raw }), ["input tokens: 价格未提供"]);
  }
  assert.deepEqual(formatCatalogPrices({ unknown_sku: "0.05" }), ["unknown_sku: 0.05"]);
  assert.deepEqual(formatCatalogPrices({ constructor: "0.05" }), ["constructor: 0.05"]);
});
