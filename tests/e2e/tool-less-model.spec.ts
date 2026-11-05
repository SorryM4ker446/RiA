import { expect, test, type Page } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

const TOOL_LESS = "vendor/no-tools", SECOND_TOOL_LESS = "vendor/no-tools-2", CAPABLE = "vendor/with-tools";
const IMAGE = "vendor/picture";

async function library(page: Page, chat = TOOL_LESS) {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([
    fixtureLibraryItem(TOOL_LESS, ["chat"], { supportsTools: false }),
    fixtureLibraryItem(SECOND_TOOL_LESS, ["chat"], { supportsTools: false }),
    fixtureLibraryItem(CAPABLE, ["chat"]),
    fixtureLibraryItem(IMAGE, ["image"], { supportsTools: false }),
  ], { chat, image: IMAGE, video: null } as never) }));
}
const notice = (page: Page) => page.getByRole("alertdialog", { name: "当前模型的部分功能受限" });

test("a model that cannot call tools is confirmed before chatting, once for each model", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.message));
  await library(page);
  await page.goto("/chat");
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText(TOOL_LESS);
  await expect(notice(page)).toContainText("不支持工具调用");
  await page.screenshot({ path: test.info().outputPath("notice.png") });

  await notice(page).getByRole("button", { name: "继续使用" }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();

  // Coming back in the same run of the app does not ask again.
  await page.reload();
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  // Another model that cannot is its own decision.
  await page.getByRole("combobox", { name: "选择模型" }).click();
  await page.getByRole("option", { name: new RegExp(SECOND_TOOL_LESS) }).click();
  await expect(notice(page)).toContainText(SECOND_TOOL_LESS);
  await notice(page).getByRole("button", { name: "继续使用" }).click();
  await page.getByRole("combobox", { name: "选择模型" }).click();
  await page.getByRole("option", { name: new RegExp(CAPABLE) }).click();
  await expect(notice(page)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("declining opens the model menu, and leaving it without a change asks again", async ({ page }) => {
  await library(page);
  await page.goto("/chat");
  await notice(page).getByRole("button", { name: "更换模型" }).click();
  await expect(notice(page)).toHaveCount(0);
  const capable = page.getByRole("option", { name: new RegExp(CAPABLE) });
  await expect(capable, "the menu stays open for the choice").toBeVisible();

  await page.keyboard.press("Escape");
  await expect(notice(page), "no model was chosen, so the question stands").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(capable, "Escape is declining too").toBeVisible();
  await capable.click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "选择模型" })).toContainText(CAPABLE);
});

test("a capable model, a media mode and a template with no tools are not asked about", async ({ page }) => {
  await library(page, CAPABLE);
  await page.goto("/chat");
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  // The image model cannot call tools either, but image mode has no use for them.
  await page.unroute("**/api/models");
  await library(page);
  await page.addInitScript(() => localStorage.setItem("chat:prefs:draft", JSON.stringify({ modelMode: "image" })));
  await page.route("**/api/conversations", async route => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { data: [{ id: "bound", title: "Bound", lastMessageAt: "2026-08-30T00:00:00Z", messageCount: 0, assistantConfig: { templateId: "t", templateRevision: 1, name: "No tools", description: "", instructions: "Help.", model: null, tools: [], collections: [], usesMemory: true } }] } });
  });
  await page.route("**/api/conversations/bound**", route => route.fulfill({ json: { data: [] } }));
  await page.goto("/chat?conversationId=bound");
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);
});
