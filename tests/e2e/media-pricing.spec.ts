import { expect, test } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { openRouterVideoPrices } from "../../src/lib/models/catalog-prices";

test("media price details display real units and all specifications without expanding catalog rows", async ({ page }, info) => {
  const image = fixtureLibraryItem("fixture/image", ["image"], { name: "多规格图片模型", priceInfo: { error: false, updatedAt: "2026-10-16T18:00:00Z", rates: [
    { billable: "output_image", unit: "image", costUsd: "0.04", variant: "low_1k", provider: "Provider A" },
    { billable: "output_image", unit: "image", costUsd: "0.08", variant: "medium_2k", provider: "Provider B" },
    { billable: "output_image", unit: "token", costUsd: "0.00003", provider: "Provider C" },
    { billable: "input_image", unit: "megapixel", costUsd: "0.06", provider: "Provider C" },
    { billable: "input_image", unit: "image", costUsd: "0", provider: "Provider A" },
  ] } });
  const video = fixtureLibraryItem("fixture/video", ["video"], { name: "多规格视频模型", priceInfo: { error: false, updatedAt: "2026-10-16T18:00:00Z", rates: openRouterVideoPrices({ cents_per_video_output_second_1080p: "14", duration_seconds_with_audio_4k: "0.30", video_tokens_4k_with_video_input: "0.0000024", cents_per_megapixel_second_creative: "5", minimum_cents_per_generation: "56" }) } });
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([]) }));
  await page.route("**/api/models/catalog?*", route => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    const models = mode === "image" ? [image, fixtureLibraryItem("fixture/unavailable", ["image"], { priceInfo: { rates: [], updatedAt: null, error: true } }), fixtureLibraryItem("fixture/empty", ["image"], { priceInfo: { rates: [], updatedAt: "2026-10-16T18:00:00Z", error: false } })] : mode === "video" ? [video] : [];
    return route.fulfill({ json: { catalogs: { openrouter: { [mode!]: { models, fetchedAt: "2026-10-16T18:00:00Z", stale: false, source: "cache", error: null, skipped: 0 } } } } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/models");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("tab", { name: "图片生成", exact: true }).click();
    const results = page.getByRole("region", { name: "模型目录结果", exact: true });
    await expect(results).toContainText("图像输出 · 低质量 · 1K $0.04/张");
    await expect(results).toContainText("报价暂不可用，请刷新目录重试");
    await expect(results).toContainText("服务商暂未提供报价");
    await expect(results).not.toContainText("$30/M image tokens");
    const trigger = page.getByRole("button", { name: "多规格图片模型的全部报价", exact: true });
    await trigger.click();
    const details = page.getByRole("dialog", { name: "多规格图片模型的价格明细", exact: true });
    for (const value of ["$30/M image tokens", "$0.06/MP", "$0/张", "中质量 · 2K", "Provider B"]) await expect(details).toContainText(value);
    await expect(details.getByRole("listitem")).toHaveCount(5);
    await page.screenshot({ path: info.outputPath(`image-price-details-${width}.png`), animations: "disabled" });
    const box = (await details.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click(); await trigger.click(); await expect(details).toHaveCount(0);
    await page.getByRole("tab", { name: "视频生成", exact: true }).click();
    await page.getByRole("button", { name: "多规格视频模型的全部报价", exact: true }).click();
    const videoDetails = page.getByRole("dialog", { name: "多规格视频模型的价格明细", exact: true });
    for (const value of ["1080p", "$0.14/秒", "含音频 · 4K", "$0.3/秒", "$2.4/M video tokens", "4K · 含视频输入", "$0.05/MP·秒", "最低 $0.56/次"]) await expect(videoDetails).toContainText(value);
    await videoDetails.getByRole("list", { name: "全部计费规格" }).evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
    await expect(videoDetails.getByText("最低 $0.56/次", { exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`video-price-details-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`usage history opens a scrollable drawer, reveals batches and preserves filtering at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([]) }));
    await page.route("**/api/models/catalog?*", route => route.fulfill({ json: { catalogs: {} } }));
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `usage-${i}`, modelId: `fixture/model-${i}`, modelProvider: "openrouter", mode: "chat", source: "chat", status: i ? "success" : "interrupted", fallback: i === 1, durationMs: 1234, inputTokens: i ? 123 : null, outputTokens: i ? 456 : null, costUsd: i ? 0 : null, estimatedUsd: 0.001, costSource: i ? "provider" : "unknown", errorCode: i ? null : "PROCESS_INTERRUPTED", createdAt: "2026-10-16T18:00:00Z" }));
    let reads = 0;
    await page.route("**/api/usage*", route => {
      reads++;
      const source = new URL(route.request().url()).searchParams.get("source");
      const recent = source === "summary" ? [] : source === "chat" ? rows.slice(0, 1) : rows;
      return route.fulfill({ json: { data: { recent, totals: { requests: recent.length, inputTokens: null, outputTokens: null, costUsd: 0, unknownCostRequests: 1 } } } });
    });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/models");
    await page.getByLabel("后台每日调用次数").fill("2");
    // Usage is its own section of the settings; the unsaved limit waits in the models section.
    await page.getByRole("tab", { name: "用量", exact: true }).click();
    const trigger = page.getByRole("button", { name: "查看调用明细", exact: true });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "模型调用明细", exact: true });
    const list = drawer.getByRole("region", { name: "调用明细列表", exact: true });
    await expect(list.getByRole("listitem")).toHaveCount(8);
    for (const value of ["进程中断", "未知", "PROCESS_INTERRUPTED", "$0.000000"]) await expect(list).toContainText(value);
    await list.evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
    await expect(list.getByRole("listitem")).toHaveCount(16);
    await list.evaluate(node => node.scrollTo({ top: 0, behavior: "instant" }));
    await expect(list.getByRole("listitem")).toHaveCount(16);
    expect(reads).toBe(1);
    await page.screenshot({ path: info.outputPath(`usage-drawer-${width}.png`), animations: "disabled" });
    const bounds = (await drawer.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await drawer.getByRole("combobox", { name: "明细调用来源", exact: true }).click();
    await page.getByRole("option", { name: "历史摘要", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(0);
    await expect(list).toContainText("暂无模型调用记录。");
    await drawer.getByRole("combobox", { name: "明细调用来源", exact: true }).click();
    await page.getByRole("option", { name: "聊天", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("listbox")).toHaveCount(0);
    expect(reads).toBe(3);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("combobox", { name: "调用来源", exact: true })).toContainText("聊天");
    await page.getByRole("tab", { name: "模型", exact: true }).click();
    await expect(page.getByLabel("后台每日调用次数")).toHaveValue("2");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
