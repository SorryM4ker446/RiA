import { expect, test, type Page } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

const now = "2026-11-17T09:00:00Z";
const answerText = [
  "这是一个 TypeScript 函数：",
  "",
  "```ts",
  "export function add(a: number, b: number): number {",
  "  // 两数相加",
  "  return a + b;",
  "}",
  "```",
  "",
  "质能方程 $E=mc^2$，以及积分：",
  "",
  "\\[\\int_0^1 x^2\\,dx = \\frac{1}{3}\\]",
  "",
  "价格是 $5 和 $10，不是公式。",
  "",
  "```mermaid",
  "graph LR",
  "  A[开始] --> B{判断}",
  "  B -->|是| C[结束]",
  "```",
  "",
  "```mermaid",
  "graph LR",
  "  A -->",
  "```",
  "",
  "```",
  "plain text block",
  "```",
].join("\n");
const history = [
  { id: "row-u", clientMessageId: "user-1", role: "user", content: "演示一下代码、公式和图表", createdAt: now },
  { id: "row-a", clientMessageId: "assistant-1", role: "assistant", content: answerText, createdAt: now },
];

async function open(page: Page) {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "chat-rich", title: "渲染", lastMessageAt: now, messageCount: history.length }] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: history } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/conversations/events", route => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\nevent: ready\ndata: {\"answering\":[]}\n\n" }));
  await page.goto("/chat?conversationId=chat-rich");
  const answer = page.getByTestId("message-list").locator('[data-message-role="assistant"]').last();
  await expect(answer).toContainText("这是一个 TypeScript 函数");
  return answer;
}

test("code is highlighted under a header with its language and a copy control", async ({ page }) => {
  const answer = await open(page);
  const code = answer.locator(".code-block").first();
  await expect(code.locator(".code-block-lang")).toHaveText("ts");
  await expect(code.locator(".hljs-keyword").first()).toHaveText("export");
  await expect(code.locator(".hljs-comment")).toHaveText("// 两数相加");
  await expect(code.getByRole("button", { name: "复制代码" })).toBeVisible();
  // A fence without a language is plain text, not guessed at.
  const plain = answer.locator(".code-block").filter({ hasText: "plain text block" });
  await expect(plain.locator(".code-block-lang")).toHaveText("文本");
  await expect(plain.locator("[class^='hljs-']")).toHaveCount(0);
});

test("formulas are typeset, and dollar amounts stay text", async ({ page }) => {
  const answer = await open(page);
  await expect(answer.locator(".katex")).toHaveCount(2);
  await expect(answer.locator(".katex-display")).toHaveCount(1);
  await expect(answer).toContainText("价格是 $5 和 $10，不是公式。");
  // The formula's own text is kept for screen readers and copying (KaTeX's MathML).
  await expect(answer.locator(".katex annotation").first()).toHaveText("E=mc^2");
});

test("a diagram is drawn, its source is one click away, and one that does not parse shows its source and why", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const answer = await open(page);
  const diagrams = answer.locator(".mermaid-block");
  await expect(diagrams).toHaveCount(2);
  const drawn = diagrams.first();
  await expect(drawn.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.locator(".mermaid-diagram")).toContainText("判断");
  await drawn.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("answer-rendering.png"), animations: "disabled", fullPage: false });
  await drawn.getByRole("button", { name: "源码" }).click();
  await expect(drawn.locator("pre")).toContainText("A[开始] --> B{判断}");
  await drawn.getByRole("button", { name: "图表" }).click();
  await expect(drawn.locator(".mermaid-diagram svg")).toBeVisible();
  const broken = diagrams.nth(1);
  await expect(broken).toHaveAttribute("data-state", "failed", { timeout: 15_000 });
  await expect(broken.getByRole("status")).toContainText("这段图表没能画出来");
  await expect(broken.locator("pre")).toContainText("A -->");
  // Nothing Mermaid leaves behind while drawing stays in the page.
  await expect(page.locator("body > [id^='dmermaid']")).toHaveCount(0);
});
