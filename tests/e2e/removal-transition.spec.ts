import { expect, test } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { chooseRowAction } from "../helpers/row-menu";
import { toasts } from "../helpers/toast";
import { watchLayout } from "../helpers/layout-watch";

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
  // The import area keeps its distance from the backup actions above it.
  const actions = (await page.getByRole("button", { name: "创建备份", exact: true }).boundingBox())!;
  const importArea = (await page.getByText("导入备份", { exact: true }).boundingBox())!;
  expect(importArea.y - (actions.y + actions.height)).toBeGreaterThanOrEqual(12);
  const removed = (await page.getByRole("article", { name: /backup-first/ }).boundingBox())!;
  await chooseRowAction(page, page.getByRole("article", { name: /backup-first/ }), "删除备份");
  // Record where the following card is on every frame from the confirmation on.
  const layout = await watchLayout(page, { following: second });
  await page.getByRole("button", { name: "确认删除备份", exact: true }).click();
  await expect(page.getByRole("article", { name: /backup-first/ })).toHaveCount(0);
  await expect(toasts(page).getByText("备份文件已永久删除")).toBeVisible();
  await page.waitForTimeout(400);
  const positions = (await layout.read()).frames.following.map(box => box.top);
  const steps = positions.slice(1).map((top, index) => Math.abs(top - positions[index]));
  const travelled = Math.abs(positions.at(-1)! - positions[0]);
  // The following row moves up by the removed row's height, spread over many frames.
  expect(travelled, JSON.stringify(positions)).toBeGreaterThan(removed.height * 0.9);
  expect(Math.max(...steps), JSON.stringify(positions)).toBeLessThan(40);
});
