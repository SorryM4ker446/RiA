import { expect, test } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

// Deleting an item folds it away so the content after it slides up, instead of
// the page jumping when the list reloads without it.
test("deleting a backup folds its card away without the page jumping", async ({ page }) => {
  let backups = [
    { id: "backup-first", createdAt: "2026-10-03T09:46:45Z", bytes: 3_400 },
    { id: "backup-second", createdAt: "2026-10-02T09:46:45Z", bytes: 3_100 },
  ];
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("fixture/chat", ["chat"])], { chat: "fixture/chat" }) }));
  await page.route("**/api/backups", route => route.fulfill({ json: { data: backups } }));
  await page.route("**/api/backups/backup-first", async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    backups = backups.filter(entry => entry.id !== "backup-first");
    await route.fulfill({ json: { data: { deleted: true } } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/backups");
  const second = page.getByRole("article", { name: /backup-second/ });
  await expect(second).toBeVisible();
  await page.getByRole("article", { name: /backup-first/ }).getByRole("button", { name: "删除备份", exact: true }).click();
  // Record where the following card is on every frame from the confirmation on.
  await page.evaluate(() => {
    const target = [...document.querySelectorAll("article")].find(node => node.getAttribute("aria-label")?.includes("backup-second"))!;
    const positions: number[] = [];
    (window as unknown as { positions: number[] }).positions = positions;
    const sample = () => { if (!target.isConnected) return; positions.push(target.getBoundingClientRect().top); requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
  });
  await page.getByRole("button", { name: "确认删除备份", exact: true }).click();
  await expect(page.getByRole("article", { name: /backup-first/ })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "备份文件已永久删除" })).toBeVisible();
  await page.waitForTimeout(400);
  const positions = await page.evaluate(() => (window as unknown as { positions: number[] }).positions);
  const steps = positions.slice(1).map((top, index) => Math.abs(top - positions[index]));
  const travelled = Math.abs(positions.at(-1)! - positions[0]);
  expect(travelled, JSON.stringify(positions)).toBeGreaterThan(100);
  expect(Math.max(...steps), JSON.stringify(positions)).toBeLessThan(40);
});
