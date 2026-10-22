import type { Page } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "./model-fixture";

const now = "2026-08-30T00:00:00Z";

export const longAnswer = Array.from({ length: 12 }, (_, i) => `## 第 ${i} 节\n\n这是一段较长的说明文字，包含 **加粗**、\`行内代码\` 和 [链接](https://example.com)。`.repeat(3)
  + `\n\n| 列 A | 列 B | 列 C |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n\`\`\`ts\nconst value${i} = compute(${i});\nconsole.log(value${i});\n\`\`\`\n`).join("\n");

/** A single long report of the kind a model writes in one reply, ending with `report-complete-<sections>`. */
export function longReport(sections: number) {
  return Array.from({ length: sections }, (_, i) => `## ${i + 1}. 问题分析 ${i + 1}\n\n`
    + `本节说明第 ${i + 1} 个问题的原因、影响范围和修复方式，包含 **重点**、\`代码引用\` 与 [参考链接](https://example.com/${i})。`.repeat(2)
    + `\n\n- 现象：页面在第 ${i + 1} 步之后停止响应\n- 原因：状态在渲染期间被重复计算\n- 修复：缓存已完成的结果\n\n`
    + `| 项目 | 修复前 | 修复后 |\n|---|---|---|\n| 耗时 | ${i * 3 + 40} ms | ${i % 7 + 3} ms |\n\n`
    + `\`\`\`ts\nfunction step${i}() {\n  const value = load(${i});\n\n  return render(value);\n}\n\`\`\`\n`).join("\n") + `\nreport-complete-${sections}`;
}

const toolOutput = (index: number) => ({ status: "completed", exitCode: 0, stdout: `line ${index}\n`.repeat(2048).slice(0, 16 * 1024) });

/** A saved conversation whose answers carry long markdown and terminal calls with large output. */
export function heavyHistory(size: number, toolsPerAnswer: number) {
  return Array.from({ length: size }, (_, i) => ({
    id: `row-${i}`, clientMessageId: `m-${i}`, role: i % 2 ? "assistant" : "user", createdAt: now,
    content: i % 2 === 0 ? `问题 ${i}` : toolsPerAnswer === 0 ? longAnswer : "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({
      type: "assistant-tool-message", text: longAnswer,
      tools: Array.from({ length: toolsPerAnswer }, (_, t) => ({ toolName: "runTerminalCommand", toolCallId: `h-${i}-${t}`, state: "output-available",
        input: { command: `Get-Content log-${t}.txt`, binding: { cwd: "D:\\Projects\\ria-demo" } }, output: toolOutput(t) })),
    }),
  }));
}

export type StreamLoad = { elapsed: number; longTasks: number; longTaskTotal: number; maxLongTask: number; frameP50: number; frameP95: number; frameMax: number };

type StreamOptions = { streamTools: number; cpu?: number; openRecords?: boolean; answer?: string; deltaSize?: number };

/**
 * Streams a reply in real time (one delta every 20ms after its tool calls) into a
 * conversation with the given history and reports how the main thread kept up.
 */
export async function measureStream(page: Page, history: ReturnType<typeof heavyHistory>, options: StreamOptions) {
  const answer = options.answer ?? longAnswer;
  // The last visible line shows the whole reply has been rendered.
  const endMarker = answer.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("```")).at(-1)!;
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "load", title: "Load", lastMessageAt: now, messageCount: history.length }] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: history } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  await page.addInitScript(({ answer, tools, output, deltaSize }) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!new URL(url, location.href).pathname.endsWith("/api/chat")) return original(input, init);
      const encoder = new TextEncoder();
      const send = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      const pause = () => new Promise(resolve => setTimeout(resolve, 20));
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(send({ type: "start", messageId: "streamed" }));
          for (let index = 0; index < tools; index++) {
            const toolCallId = `live-${index}`;
            controller.enqueue(send({ type: "tool-input-available", toolCallId, toolName: "runTerminalCommand", input: { command: `Get-Content live-${index}.txt` } }));
            await pause();
            controller.enqueue(send({ type: "tool-output-available", toolCallId, output }));
            await pause();
          }
          controller.enqueue(send({ type: "text-start", id: "answer" }));
          for (let offset = 0; offset < answer.length; offset += deltaSize) {
            controller.enqueue(send({ type: "text-delta", id: "answer", delta: answer.slice(offset, offset + deltaSize) }));
            await pause();
          }
          controller.enqueue(send({ type: "text-end", id: "answer" }));
          controller.enqueue(send({ type: "finish", finishReason: "stop" }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          (window as unknown as { streamClosed?: boolean }).streamClosed = true;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    };
  }, { answer, tools: options.streamTools, output: toolOutput(0), deltaSize: options.deltaSize ?? 6 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/chat");
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.waitFor();
  if (history.length) await page.locator("[data-message-id]").nth(history.length - 1).waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpu ?? 1 });
  await page.evaluate(() => {
    const probe = { long: [] as number[], gaps: [] as number[], done: false };
    (window as unknown as { streamProbe: typeof probe }).streamProbe = probe;
    new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.long.push(entry.duration); }).observe({ type: "longtask" });
    let last = performance.now();
    const tick = () => { const now = performance.now(); probe.gaps.push(now - last); last = now; if (!probe.done) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await composer.fill("go");
  const started = Date.now();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // The records drawer is modal, so it can only be opened once the reply is under way.
  if (options.openRecords) {
    await page.getByRole("button", { name: "执行记录", exact: true }).click({ timeout: 0 });
    await page.getByRole("dialog", { name: "执行记录", exact: true }).locator(".run-record-trigger").first().click({ timeout: 0 });
  }
  await page.waitForFunction(() => (window as unknown as { streamClosed?: boolean }).streamClosed === true, null, { timeout: 0, polling: 500 });
  await page.locator("[data-message-id]").last().getByText(endMarker).waitFor({ state: "attached", timeout: 0 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const elapsed = Date.now() - started;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const probe = await page.evaluate(() => {
    const probe = (window as unknown as { streamProbe: { long: number[]; gaps: number[]; done: boolean } }).streamProbe;
    probe.done = true;
    return probe;
  });
  const gaps = [...probe.gaps].sort((a, b) => a - b);
  const at = (fraction: number) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))] ?? 0);
  return {
    elapsed, longTasks: probe.long.length, longTaskTotal: Math.round(probe.long.reduce((sum, value) => sum + value, 0)),
    maxLongTask: Math.round(Math.max(0, ...probe.long)), frameP50: at(.5), frameP95: at(.95), frameMax: Math.round(gaps.at(-1) ?? 0),
  } satisfies StreamLoad;
}
