import { expect, test as base, type Page } from "@playwright/test";
import { trackChatStreams, waitForChatStream } from "../helpers/chat-stream";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";

type App = Awaited<ReturnType<typeof startStandaloneServer>>;
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer({ modelFixture: true });
  try { await provide(runtime); } finally { await runtime.close(); }
} });

async function send(page: Page, app: App, text: string) {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "清单与提问" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await trackChatStreams(page);
  await page.getByPlaceholder(/输入你的问题/).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}
const answer = (page: Page) => page.getByTestId("message-list").locator('[data-message-role="assistant"]').last();

test("a task checklist shows while the work runs, with the current step above the composer, and goes once the answer is written", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 860 });
  await send(page, app, "OFFLINE_PLAN_SLOW 把主题改成蓝色");
  const plan = answer(page).getByRole("region", { name: "任务清单", exact: true });
  await expect(plan).toBeVisible();
  await expect(plan.getByRole("button", { name: /任务清单/ })).toContainText("0/3");
  await expect(plan.getByRole("listitem")).toHaveText(["读取现有配置进行中", "修改主题颜色未开始", "运行测试未开始"]);
  // The checklist says what is happening; the plain "replying" line is not shown beside it.
  await expect(answer(page).locator(".reply-pending")).toHaveCount(0);
  const strip = page.locator(".plan-strip");
  await expect(strip).toHaveText("正在：读取现有配置1/3");
  await page.screenshot({ path: test.info().outputPath("task-plan.png"), animations: "disabled" });
  // The checklist and questions are not listed among the tools the answer used.
  await expect(answer(page)).not.toContainText("任务清单、");
  await waitForChatStream(page);
  await expect(answer(page)).toContainText("三个步骤都完成了。");
  // Once the answer is written the card and the strip fold away (a transition, not a jump); the calls stay in the execution record.
  await expect(plan).toHaveCount(0);
  const folds = page.locator(".reveal").filter({ has: page.locator(".task-plan, .plan-strip") });
  await expect(folds).toHaveCount(2);
  for (const fold of await folds.all()) {
    await expect(fold).toHaveAttribute("data-state", "closed");
    expect(await fold.evaluate(element => getComputedStyle(element).transitionDuration.split(",").some(duration => parseFloat(duration) > 0))).toBe(true);
  }
  await expect(strip).toBeHidden();
  await page.reload();
  await expect(answer(page)).toContainText("三个步骤都完成了。");
  await expect(answer(page).getByRole("region", { name: "任务清单", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("one question with one choice is answered by choosing, and the answer stays in the conversation", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await send(page, app, "OFFLINE_ASK 帮我写周报");
  const card = page.getByRole("region", { name: "需要你回答的问题", exact: true });
  await expect(card.getByRole("heading", { name: "报告用哪种格式？" })).toBeVisible();
  await expect(card.getByText("格式", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("输入你的回答，或在上方选择…")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("question-card.png"), animations: "disabled" });
  // A number picks that option. The options wait while the stream that asked is closing; keys need them ready.
  const first = card.getByRole("radio", { name: /Markdown/ });
  await expect(first).toBeEnabled();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("2");
  await waitForChatStream(page);
  await expect(card).toBeHidden();
  await expect(answer(page)).toContainText("离线回答：收到 Word");
  await expect(answer(page).locator(".question-record")).toContainText("报告用哪种格式？Word");
  await page.reload();
  await expect(answer(page).locator(".question-record")).toContainText("报告用哪种格式？Word");
});

test("several questions go one after another, with several choices, Other in your own words, and Back", async ({ page, app }) => {
  await send(page, app, "OFFLINE_ASK_TWO 帮我写周报");
  const card = page.getByRole("region", { name: "需要你回答的问题", exact: true });
  await expect(card).toContainText("1/2");
  const next = card.getByRole("button", { name: "下一题", exact: true });
  await expect(next).toBeDisabled();
  await card.getByRole("button", { name: "其他…", exact: true }).click();
  await card.getByRole("textbox", { name: "其他…" }).fill("用我自己的话：纯文本");
  await next.click();
  await expect(card).toContainText("2/2");
  await card.getByRole("checkbox", { name: /摘要/ }).click();
  await card.getByRole("checkbox", { name: /附录/ }).click();
  await card.getByRole("button", { name: "上一题", exact: true }).click();
  await expect(card.getByRole("textbox", { name: "其他…" })).toHaveValue("用我自己的话：纯文本");
  await card.getByRole("button", { name: "下一题", exact: true }).click();
  await expect(card.getByRole("checkbox", { name: /摘要/ })).toHaveAttribute("aria-checked", "true");
  await card.getByRole("button", { name: "提交", exact: true }).click();
  await waitForChatStream(page);
  await expect(answer(page)).toContainText("用我自己的话：纯文本");
  await expect(answer(page)).toContainText("摘要");
  await expect(answer(page)).toContainText("附录");
});

test("a question can be skipped, or answered by typing in the message box", async ({ page, app }) => {
  await send(page, app, "OFFLINE_ASK 帮我写周报");
  const card = page.getByRole("region", { name: "需要你回答的问题", exact: true });
  await card.getByRole("button", { name: "跳过", exact: true }).click();
  await waitForChatStream(page);
  await expect(answer(page)).toContainText("你跳过了");
  await expect(answer(page).locator(".question-record")).toContainText("已跳过");

  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_ASK 再写一份");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(card.getByRole("heading", { name: "报告用哪种格式？" })).toBeVisible();
  await page.getByPlaceholder("输入你的回答，或在上方选择…").fill("用我自己的话就行");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await waitForChatStream(page);
  await expect(answer(page)).toContainText("用我自己的话就行");
});
