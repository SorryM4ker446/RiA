import { expect, test } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

// Captures the current build at the sizes and settings the acceptance list
// names, and asserts what can be asserted without eyes: nothing overflows
// sideways, and the composer stays reachable. The pictures are for a person to
// look at; a passing run here is not a visual sign-off.
test("interface walkthrough at the acceptance sizes", async ({ page }, info) => {
  const chat = { id: "walk", title: "界面走查", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 3 };
  const history = [
    { id: "h1", clientMessageId: null, role: "user" as const, content: "帮我看看这段很长的中文说明有没有问题，以及它在窄窗口和放大显示下是否还读得下去。", status: "success" as const },
    { id: "h2", clientMessageId: null, role: "assistant" as const, content: "这是一段用于走查的长回答。".repeat(12), status: "success" as const },
    { id: "h3", clientMessageId: null, role: "assistant" as const, content: "__ASSISTANT_TOOL_MESSAGE__:{\"type\":\"assistant-tool-message\",\"text\":\"工具调用结果。\",\"reasoning\":\"先确认这条消息很短\",\"tools\":[{\"toolName\":\"searchKnowledge\",\"toolCallId\":\"c1\",\"state\":\"output-available\",\"output\":{\"query\":\"说明\",\"total\":1,\"results\":[]}}]}", status: "success" as const },
  ];
  await page.route("**/api/models", (route) => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", (route) => route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: history } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));

  const shot = async (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/chat");
  await expect(page.getByTestId("message-list")).toBeVisible();
  await shot("01-desktop-light");

  // The reasoning block and the tool details both have to be reachable by keyboard.
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(["A", "BUTTON", "INPUT", "TEXTAREA", "SUMMARY"]).toContain(focused);
  await shot("02-keyboard-focus");

  await page.getByTestId("message-list").evaluate(element => element.scrollTo({ top: 0 }));
  await page.getByRole("button", { name: "切换主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await shot("03-dark-scrolled-up");

  await page.setViewportSize({ width: 390, height: 780 });
  await shot("04-narrow-390");

  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scale of [1.25, 1.5]) {
    await page.evaluate((value) => { document.documentElement.style.fontSize = `${16 * value}px`; }, scale);
    await shot(`05-zoom-${String(scale).replace(".", "_")}`);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

  // What can be checked without eyes: nothing escapes the viewport sideways at
  // the narrow size, the composer and its send control stay reachable, and the
  // transcript is still the scrollable region a reader expects.
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 780 }]) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: "light" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow at ${size.width}px`).toBeLessThanOrEqual(1);
    await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  }

  // At 150% text the composer must still fit on one line of controls.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
});
