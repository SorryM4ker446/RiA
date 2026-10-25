import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCatalogPrices } from "../../src/features/models/catalog-pricing";

test("catalog token prices convert to dollars per million without rounding small nonzero rates to free", () => {
  assert.deepEqual(formatCatalogPrices({ completion: "1e-5", prompt: "0.0000025", input_cache_read: "0.0000000001" }), [
    "$2.5/百万输入 Token", "$10/百万输出 Token", "$0.0001/百万缓存读取 Token",
  ]);
  assert.deepEqual(formatCatalogPrices({ prompt: "0", completion: "0.0" }), ["$0/百万输入 Token", "$0/百万输出 Token"]);
});

test("per-image, per-request and video prices retain their billing units", () => {
  assert.deepEqual(formatCatalogPrices({ image: "0.04", request: "0.003", duration_seconds: "0.08", image_output: "0.12" }), [
    "$0.04/张输入图片", "$0.003/次请求", "$0.08/秒", "$0.12/张输出图片",
  ]);
});

test("missing and invalid prices are never presented as free and unknown units remain unconverted", () => {
  assert.deepEqual(formatCatalogPrices({}), []);
  for (const raw of ["", " ", "NaN", "Infinity", "-1", "1e308", "0x10"]) {
    assert.deepEqual(formatCatalogPrices({ prompt: raw }), ["输入 Token：价格未提供"]);
  }
  assert.deepEqual(formatCatalogPrices({ unknown_sku: "0.05" }), ["unknown_sku: 0.05"]);
  assert.deepEqual(formatCatalogPrices({ constructor: "0.05" }), ["constructor: 0.05"]);
});
