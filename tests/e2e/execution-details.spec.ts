import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { openExecutionDetails } from "../helpers/execution-records";

const now = "2026-10-20T00:00:00Z";
const budget = { maxSteps: null, maxFailures: null, deadlineMs: null };
const user = { id: "user", clientMessageId: "user", role: "user", content: "Inspect the files", createdAt: now };
async function workspace(page: Page) {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("fixture/chat", ["chat"])], { chat: "fixture/chat" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [
    { id: "details-chat", title: "Details conversation", messageCount: 1, lastMessageAt: now },
    { id: "other-chat", title: "Other conversation", messageCount: 1, lastMessageAt: now },
  ] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [user] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
}

for (const width of [1440, 390]) test(`saved summaries acquire full details without replacing expanded calls or moving the reader at ${width}px`, async ({ page }) => {
  const english = width === 390;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 600 });
  if (english) await page.addInitScript(() => localStorage.setItem("ui:locale", "en-US"));
  await workspace(page);
  const steps = Array.from({ length: 24 }, (_, index) => ({
    id: `step-${index}`, toolCallId: `call-${index}`, position: index + 1, kind: "tool", toolName: "searchKnowledge",
    state: "done", input: { query: `query-${index}` }, output: { results: "summary" },
  }));
  let available = false, finished = false, detailRequests = 0, listRequests = 0;
  await page.route("**/api/conversations/*/runs?*", route => {
    const detail = new URL(route.request().url()).searchParams.has("runId");
    if (detail) detailRequests++; else listRequests++;
    const message = { id: "saved-answer", clientMessageId: "saved-answer", role: "assistant", createdAt: now,
      content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "Done", runId: "details-run",
        contextBudget: { checks: 8, compactions: 2, degraded: true, estimatedInputTokens: 4000, budget: { contextWindow: 32000, capacitySource: "catalog", counting: "conservative-utf8-estimate" } }, tools: steps.map(step => ({
        toolName: step.toolName, toolCallId: step.toolCallId, state: "output-available", input: step.input, output: { content: `Full result for ${step.toolCallId}` },
      })) }),
    };
    return route.fulfill({ json: { data: detail ? available ? message : null : [{
      id: "details-run", ...(available ? { messageId: "saved-answer" } : {}), goal: "Inspect the files", startedAt: now,
      status: finished ? "succeeded" : "running", steps, budget,
    }] } });
  });
  await page.goto("/chat?conversationId=details-chat");
  await page.getByRole("button", { name: english ? "Execution records" : "执行记录", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: english ? "Execution records" : "执行记录", exact: true });
  const request = drawer.locator(".run-record-trigger");
  await request.click();
  const calls = drawer.getByRole("region", { name: english ? "Tool calls" : "工具调用", exact: true }).locator("details");
  await expect(calls).toHaveCount(24);
  const selected = drawer.locator('[data-call-id="call-5"]');
  await selected.locator("summary").click();
  await expect(selected.getByRole("status")).toContainText(english ? "Waiting for full details" : "正在等待完整详情");
  await expect(selected.locator("pre")).toContainText("query-5");
  await selected.locator("summary").scrollIntoViewIfNeeded();
  const before = (await selected.locator("summary").boundingBox())!.y;
  await selected.evaluate(node => { (window as Window & { originalCallNode?: Element }).originalCallNode = node; });

  steps.push({ ...steps[0], id: "step-24", toolCallId: "call-24", position: 25 });
  await expect(calls).toHaveCount(25);
  await expect(calls.first()).toHaveAttribute("data-call-id", "call-24");
  await expect(selected).toHaveAttribute("open", "");
  expect((await selected.locator("summary").boundingBox())!.y).toBeCloseTo(before, 0);

  available = true;
  await expect(selected.locator("pre").last()).toContainText("Full result for call-5");
  await expect(request).toContainText(english ? "In progress" : "进行中");
  finished = true;
  await expect(calls).toHaveCount(25);
  await expect(request).toHaveAttribute("aria-expanded", "true");
  await expect(request).toContainText(english ? "Completed" : "已完成");
  await expect(drawer).toContainText(english ? "Context compacted 2 times" : "本次调用压缩了 2 次上下文");
  await expect(drawer).toContainText(english ? "incomplete historical excerpts were used" : "已使用不完整的历史摘录");
  await expect(selected).toHaveAttribute("open", "");
  await expect(calls.first()).not.toHaveAttribute("open");
  await expect(selected.getByRole("status")).toHaveCount(0);
  expect(await selected.evaluate(node => node === (window as Window & { originalCallNode?: Element }).originalCallNode)).toBe(true);
  expect((await selected.locator("summary").boundingBox())!.y).toBeCloseTo(before, 0);
  expect(detailRequests).toBeGreaterThanOrEqual(2);
  const settledRequests = { listRequests, detailRequests };
  await page.clock.install();
  await page.clock.runFor(4500);
  expect({ listRequests, detailRequests }).toEqual(settledRequests);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await drawer.screenshot({ path: join(tmpdir(), `ria-unified-execution-${width}.png`), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("terminal details arriving after a saved summary open automatically and preserve an explicit collapse", async ({ page }) => {
  await workspace(page);
  let available = false, finished = false;
  await page.route("**/api/conversations/*/runs?*", route => {
    const detail = new URL(route.request().url()).searchParams.has("runId");
    const message = { id: "terminal-answer", clientMessageId: "terminal-answer", role: "assistant", createdAt: now,
      content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "", runId: "terminal-run",
        tools: ["terminal-call", "manually-closed"].map(toolCallId => ({ toolName: "runTerminalCommand", toolCallId, state: "approval-requested",
          input: { command: "echo terminal-ready" }, approval: { id: `approval-${toolCallId}` } })),
      }),
    };
    return route.fulfill({ json: { data: detail ? available ? message : null : [{
      id: "terminal-run", ...(available ? { messageId: "terminal-answer" } : {}), goal: "Inspect the files", startedAt: now,
      status: finished ? "waiting_approval" : "running", budget,
      steps: ["terminal-call", "manually-closed"].map((toolCallId, index) => ({ id: `step-${toolCallId}`, toolCallId, position: index + 1, kind: "tool", toolName: "runTerminalCommand", state: "running" })),
    }] } });
  });
  await page.goto("/chat?conversationId=details-chat");
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "执行记录", exact: true });
  await drawer.locator(".run-record-trigger").click();
  const call = drawer.locator('[data-call-id="terminal-call"]');
  const manuallyClosed = drawer.locator('[data-call-id="manually-closed"]');
  await expect(call).not.toHaveAttribute("open");
  await manuallyClosed.locator("summary").click();
  await expect(manuallyClosed).toHaveAttribute("open", "");
  await manuallyClosed.locator("summary").click();
  await expect(manuallyClosed).not.toHaveAttribute("open");
  await call.evaluate(node => { (window as Window & { originalCallNode?: Element }).originalCallNode = node; });
  available = true;
  await expect(call.getByRole("button", { name: "返回聊天批准", exact: true })).toBeVisible();
  await expect(call).toHaveAttribute("open", "");
  await expect(manuallyClosed).not.toHaveAttribute("open");
  await expect(manuallyClosed.getByRole("button", { name: "返回聊天批准", exact: true })).toBeHidden();
  expect(await call.evaluate(node => node === (window as Window & { originalCallNode?: Element }).originalCallNode)).toBe(true);
  await call.locator("summary").click();
  await expect(call).not.toHaveAttribute("open");
  const settled = page.waitForResponse(async response => response.url().includes("/runs?limit=") &&
    (await response.json()).data[0]?.status === "waiting_approval");
  finished = true;
  await settled;
  await expect(drawer.locator(".run-record-trigger")).toContainText("等待批准");
  await expect(call).not.toHaveAttribute("open");
  await call.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(call).toHaveAttribute("open", "");
});

test("a running call opens automatically and closes once it completes, while a finished call stays closed until opened", async ({ page }) => {
  await workspace(page);
  let finished = false;
  const answer = () => ({ id: "live-answer", clientMessageId: "live-answer", role: "assistant", createdAt: now,
    content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "", runId: "live-run",
      tools: [
        { toolName: "searchKnowledge", toolCallId: "earlier-call", state: "output-available", input: { query: "earlier" }, output: { content: "Earlier result" } },
        finished
          ? { toolName: "searchKnowledge", toolCallId: "live-call", state: "output-available", input: { query: "live" }, output: { content: "Live result" } }
          : { toolName: "searchKnowledge", toolCallId: "live-call", state: "input-available", input: { query: "live" } },
      ],
    }),
  });
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [user, answer()] } }));
  await page.route("**/api/conversations/*/runs?*", route => {
    const detail = new URL(route.request().url()).searchParams.has("runId");
    return route.fulfill({ json: { data: detail ? answer() : [{
      id: "live-run", messageId: "live-answer", goal: "Inspect the files", startedAt: now, status: finished ? "succeeded" : "running", budget,
      steps: [
        { id: "step-earlier", toolCallId: "earlier-call", position: 1, kind: "tool", toolName: "searchKnowledge", state: "done" },
        { id: "step-live", toolCallId: "live-call", position: 2, kind: "tool", toolName: "searchKnowledge", state: finished ? "done" : "running" },
      ],
    }] } });
  });
  await page.goto("/chat?conversationId=details-chat");
  const drawer = await openExecutionDetails(page);
  const live = drawer.locator('[data-call-id="live-call"]');
  const earlier = drawer.locator('[data-call-id="earlier-call"]');
  await expect(live.getByText("输入参数", { exact: true })).toBeVisible();
  await expect(live).toHaveAttribute("open", "");
  await expect(earlier).not.toHaveAttribute("open");
  finished = true;
  await expect(drawer.locator(".run-record-trigger")).toContainText("已完成");
  await expect(live.locator("summary")).toHaveText("工具详情：searchKnowledge · 执行完成");
  await expect(live).not.toHaveAttribute("open");
  await expect(earlier).not.toHaveAttribute("open");
  await live.locator("summary").click();
  await expect(live.getByText("执行结果", { exact: true })).toBeVisible();
});

test("legacy summaries remain readable after a detail load failure and can recover on reopening", async ({ page }) => {
  await workspace(page);
  let fail = true;
  await page.route("**/api/conversations/*/runs?*", route => {
    if (new URL(route.request().url()).searchParams.has("runId")) return route.fulfill(fail
      ? { status: 503, json: { error: { message: "Detail service temporarily unavailable" } } }
      : { json: { data: null } });
    return route.fulfill({ json: { data: [{ id: "legacy-run", goal: "Inspect the files", status: "succeeded", startedAt: now, budget,
      steps: [{ id: "legacy-step", position: 1, kind: "tool", toolName: "runTerminalCommand", state: "done", input: { command: "short saved summary" }, output: { stdout: "string" } }],
    }] } });
  });
  await page.goto("/chat?conversationId=details-chat");
  const trigger = page.getByRole("button", { name: "执行记录", exact: true });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "执行记录", exact: true });
  await drawer.locator(".run-record-trigger").click();
  const call = drawer.locator('[data-call-id="legacy-step"]');
  await expect(call.locator("summary")).toHaveText("工具详情：执行终端命令 · 执行完成");
  await call.locator("summary").click();
  await expect(call.locator("pre")).toContainText("short saved summary");
  await expect(drawer.getByRole("alert")).toContainText("Detail service temporarily unavailable");
  await expect(call.getByRole("status")).toContainText("完整详情暂不可用");
  await expect(call.getByRole("region", { name: "终端命令", exact: true })).toHaveCount(0);
  fail = false;
  await page.keyboard.press("Escape");
  await trigger.click();
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  await call.locator("summary").click();
  await expect(call.locator("pre")).toContainText("short saved summary");
});

test("late details from a closed conversation cannot replace another conversation's matching call ID", async ({ page }) => {
  await workspace(page);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/conversations/*/runs?*", async route => {
    const url = new URL(route.request().url());
    const other = url.pathname.includes("other-chat");
    if (url.searchParams.has("runId")) {
      if (!other) { entered(); await gate; }
      await route.fulfill({ json: { data: { id: other ? "other-message" : "old-message", clientMessageId: other ? "other-message" : "old-message", role: "assistant", createdAt: now,
        content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "", runId: other ? "other-run" : "old-run",
          tools: [{ toolName: "searchKnowledge", toolCallId: "shared-call", state: "output-available", output: { content: other ? "Other result" : "Old result" } }],
        }),
      } } });
      return;
    }
    await route.fulfill({ json: { data: [{ id: other ? "other-run" : "old-run", goal: other ? "Other request" : "Old request", status: "succeeded", startedAt: now, budget,
      steps: [{ id: other ? "other-step" : "old-step", toolCallId: "shared-call", position: 1, kind: "tool", toolName: "searchKnowledge", state: "done" }],
    }] } });
  });
  try {
    await page.goto("/chat?conversationId=details-chat");
    const trigger = page.getByRole("button", { name: "执行记录", exact: true });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "执行记录", exact: true });
    await drawer.locator(".run-record-trigger").click();
    await requested;
    const aborted = page.waitForEvent("requestfailed", { predicate: request => request.url().includes("runId=old-run") });
    await page.keyboard.press("Escape");
    await aborted;
    await page.getByRole("button", { name: "会话列表", exact: true }).click();
    await page.locator('button[title="Other conversation"]').click();
    await trigger.click();
    await drawer.locator(".run-record-trigger").click();
    const call = drawer.locator('[data-call-id="shared-call"]');
    await call.locator("summary").click();
    await expect(call.locator("pre")).toContainText("Other result");
    release();
    await expect(drawer.locator(".run-record-trigger")).toContainText("Other request");
    await expect(call.locator("pre")).toContainText("Other result");
    await expect(drawer).not.toContainText("Old result");
  } finally { release(); }
});

for (const width of [1440, 390]) test(`the composer shows the latest request's context usage quietly and explains it on hover at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 700 });
  await workspace(page);
  const report = (estimatedInputTokens: number) => ({ checks: 3, compactions: 1, degraded: false, estimatedInputTokens, usageCalibration: 0.6,
    budget: { contextWindow: 32000, capacitySource: "catalog", counting: "character-class-estimate", inputTokens: 28000, triggerTokens: 20000 } });
  const answer = (estimatedInputTokens: number) => ({ id: "usage-answer", clientMessageId: "usage-answer", role: "assistant", createdAt: now,
    content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "Done", tools: [], contextBudget: report(estimatedInputTokens) }) });
  let used = 4000;
  await page.unroute("**/api/conversations/*/messages");
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [user, answer(used)] } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  await page.goto("/chat?conversationId=details-chat");
  const indicator = page.getByLabel("上下文已用约 13%", { exact: true });
  await expect(indicator).toHaveText("13%");
  await expect(indicator).toHaveAttribute("data-state", "normal");
  const tools = page.getByRole("combobox", { name: "选择工具", exact: false });
  const toolBox = await tools.boundingBox(), box = (await indicator.boundingBox())!;
  if (toolBox && width >= 768) expect(box.x).toBeGreaterThan(toolBox.x + toolBox.width - 1);
  expect(box.height).toBeLessThanOrEqual(28);
  await indicator.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("上次请求约 4,000 / 32,000 tokens");
  await expect(tooltip).toContainText("达到约 63% 时自动压缩");
  await expect(tooltip).toContainText("已压缩 1 次");
  await page.locator("form").first().screenshot({ path: testInfo.outputPath(`composer-${width}.png`) });

  used = 19000;
  await page.reload();
  const near = page.getByLabel("上下文已用约 59%", { exact: true });
  await expect(near).toHaveAttribute("data-state", "near");
});
