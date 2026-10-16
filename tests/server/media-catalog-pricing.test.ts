import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogPriceInfoSchema, openRouterImagePrices, openRouterVideoPrices } from "../../src/lib/models/catalog-prices";
import { formatMediaPrice, formatPriceVariant } from "../../src/features/models/catalog-pricing";
import { openRouterProvider } from "../../src/lib/models/providers/openrouter";

test("image quotes preserve billing units, resolution variants and distinct provider rates", () => {
  const quotes = openRouterImagePrices({ endpoints: [
    { provider_name: "Provider A", pricing: [
      { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "low_2k" },
      { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "low_2k" },
      { billable: "input_image", unit: "image", cost_usd: 0 },
      { billable: "output_image", unit: "token", cost_usd: 0.00003 },
      { billable: "output_image", unit: "megapixel", cost_usd: 0.014 },
    ] },
    { provider_name: "Provider B", pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.05, variant: "low_2k" }] },
  ] });
  assert.equal(quotes.error, false);
  assert.equal(quotes.rates.length, 5);
  const formatted = quotes.rates.map(formatMediaPrice);
  assert.deepEqual(formatted[0], { label: "图像输出", amount: "$0.04/张", spec: "低质量 · 2K", provider: "Provider A" });
  assert.equal(formatted[1].amount, "$0/张");
  assert.equal(formatted[2].amount, "$30/M image tokens");
  assert.equal(formatted[3].amount, "$0.014/MP");
  assert.equal(formatted[4].provider, "Provider B");
});

test("video SKUs convert cents, preserve minimum charges and describe audio, input and resolution", () => {
  const rates = openRouterVideoPrices({
    cents_per_image_input: "1", cents_per_video_output_second_1080p: "14",
    duration_seconds_with_audio_4k: "0.30", reference_duration_seconds_768p: "0.07",
    image_to_video_duration_seconds_720p: "0.10", text_to_video_duration_seconds_1080p: "0.12",
    cents_per_second_video_continuation_2k: "31", cents_per_megapixel_second_precise: "3.5",
    video_tokens_4k_with_video_input: "0.0000024", video_tokens_without_audio: "0.0000012",
    minimum_cents_per_generation: "56", future_sku: "12", duration_seconds: "-1",
  }).map(formatMediaPrice);
  assert.deepEqual(rates.map(rate => rate.amount), ["$0.01/张", "$0.14/秒", "$0.3/秒", "$0.07/秒", "$0.1/秒", "$0.12/秒", "$0.31/秒", "$0.035/MP·秒", "$2.4/M video tokens", "$1.2/M video tokens", "最低 $0.56/次", "计费单位待确认（原始值 12）", "价格未提供"]);
  assert.deepEqual(rates.slice(1, 10).map(rate => rate.spec), ["1080p", "含音频 · 4K", "768p", "图生视频 · 720p", "文生视频 · 1080p", "视频续接 · 2K", "精确模式", "4K · 含视频输入", "无音频"]);
  assert.equal(rates[3].label, "参考视频输入");
  assert.equal(formatPriceVariant("future_spec_1.5k"), "future · spec · 1.5K");
});

test("missing, malformed and unfamiliar media prices never become free", () => {
  assert.deepEqual(openRouterImagePrices({ endpoints: [{ pricing: [] }] }), { rates: [], error: false });
  assert.deepEqual(openRouterImagePrices({ data: [] }), { rates: [], error: true });
  const malformed = openRouterImagePrices({ endpoints: [{ pricing: [
    { billable: "output_image", unit: "image", cost_usd: "" },
    { billable: "output_image", unit: "image", cost_usd: -1 },
    { billable: "output_image", unit: "token", cost_usd: 1e308 },
    { billable: "output_image", unit: "future_unit", cost_usd: 1 },
  ] }] });
  assert.equal(malformed.error, true);
  assert.equal(formatMediaPrice(malformed.rates[0]).amount, "价格未提供");
  assert.equal(formatMediaPrice(malformed.rates[1]).amount, "计费单位待确认（原始值 1）");
});

test("image catalog price discovery is bounded, uses trusted URLs and isolates endpoint failures", async t => {
  let active = 0, peak = 0;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/images/models")) return Response.json({ data: Array.from({ length: 20 }, (_, i) => ({ id: `fixture/image-${i}`, endpoints: "https://untrusted.invalid/prices" })) });
    assert.ok(url.startsWith("https://openrouter.ai/api/v1/images/models/fixture/image-"));
    assert.ok(options.signal);
    active++; peak = Math.max(peak, active);
    await Promise.resolve(); active--;
    return url.endsWith("image-1/endpoints") ? new Response("failed", { status: 503 }) : Response.json({ endpoints: [{ provider_name: "Fixture", pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04, variant: "2k" }] }] });
  });
  const catalog = await openRouterProvider.fetchCatalog("image", new AbortController().signal);
  assert.equal(catalog.models.length, 20);
  assert.equal(catalog.invalidRows, 0);
  assert.equal(calls.length, 21);
  assert.ok(peak > 1 && peak <= 6);
  assert.equal(catalog.models[1].priceInfo.error, true);
  assert.equal(catalog.models[0].priceInfo.rates[0].variant, "2k");
  for (const model of catalog.models) assert.ok(catalogPriceInfoSchema.safeParse(model.priceInfo).success);
});

test("video catalogs retain every SKU even when legacy price keys are too long or pricing is empty", async t => {
  const skus = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`future_sku_${i}`, "0.1"]));
  skus.video_tokens_1080p_with_video_input = "0.0000047";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "fixture/video", pricing: {}, pricing_skus: skus }] }));
  const catalog = await openRouterProvider.fetchCatalog("video", new AbortController().signal);
  assert.equal(catalog.models[0].priceInfo.rates.length, 16);
  assert.equal(formatMediaPrice(catalog.models[0].priceInfo.rates.at(-1)).amount, "$4.7/M video tokens");
  assert.ok(catalogPriceInfoSchema.safeParse(catalog.models[0].priceInfo).success);
});

test("cancelling image price discovery stops queued requests and keeps the catalog browsable", async t => {
  const controller = new AbortController();
  let endpointReads = 0;
  t.mock.method(globalThis, "fetch", async input => {
    if (String(input).endsWith("/images/models")) return Response.json({ data: Array.from({ length: 20 }, (_, i) => ({ id: `fixture/image-${i}` })) });
    endpointReads++; controller.abort();
    throw new DOMException("Cancelled", "AbortError");
  });
  const catalog = await openRouterProvider.fetchCatalog("image", controller.signal);
  assert.equal(endpointReads, 1);
  assert.equal(catalog.models.length, 20);
  assert.ok(catalog.models.every(model => model.priceInfo.error));
});
