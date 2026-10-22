import { expect, test, type Locator, type Page } from "@playwright/test";
import { splitMarkdownBlocks } from "../../src/components/chat/markdown-blocks";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

const now = "2026-08-30T00:00:00Z";

// Constructs whose rendering depends on what surrounds them across blank lines.
const document = [
  "# 修复报告",
  "这是一段包含 **加粗**、_斜体_、~~删除线~~、`行内代码` 与 [链接](https://example.com) 的说明，以及自动链接 https://example.org。",
  "副标题\n------",
  "## 1. 松散列表与续行",
  "- 第一项\n\n- 第二项\n\n  第二项的续行段落\n\n- 第三项",
  "1. 有序一\n\n2. 有序二\n\n10) 另一种编号",
  "- 列表里的代码\n\n  ```ts\n  const value = load();\n\n  more code here();\n  ```\n\n- 列表继续",
  "## 2. 代码块",
  "````md\n```js\n\nconst nested = 1;\n```\n\n仍然在代码块里\n````",
  "~~~\n\ntilde code\n   ~~~",
  "    indented code\n\n    still indented",
  "### 3. 引用、表格与任务",
  "> 引用第一行\n>\n> 引用第二段\n延续行",
  "| 项目 | 修复前 | 修复后 |\n|---|---:|:---:|\n| 耗时 | 144 s | 34 s |\n| 长任务 | 786 | 3 |",
  "- [ ] 待办\n\n- [x] 完成",
  "* * *",
  "最后一段。中英文 mixed text、数字 12345 与符号 → ✓。",
].join("\n\n");
// Paused inside the fence nested in a list item: a block still being written.
const pausedAt = document.indexOf("more code here");
// A leading comment renders nothing but keeps the text as one parsed document.
const whole = (text: string) => `<!-- whole -->\n\n${text}`;

test("the reference renders whole while the streamed document is split", () => {
  // Without this the comparison below could silently compare split with split.
  for (const [text, blocks] of [[document, 10], [document.slice(0, pausedAt), 3]] as const) {
    expect(splitMarkdownBlocks(whole(text))).toHaveLength(1);
    expect(splitMarkdownBlocks(text).length).toBeGreaterThanOrEqual(blocks);
  }
});

async function prepare(page: Page) {
  const history = [
    { id: "row-u1", clientMessageId: "u1", role: "user", content: "完整", createdAt: now },
    { id: "row-full", clientMessageId: "whole-full", role: "assistant", content: whole(document), createdAt: now },
    { id: "row-u2", clientMessageId: "u2", role: "user", content: "一半", createdAt: now },
    { id: "row-part", clientMessageId: "whole-part", role: "assistant", content: whole(document.slice(0, pausedAt)), createdAt: now },
  ];
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "visual", title: "Visual", lastMessageAt: now, messageCount: history.length }] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: history } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  await page.addInitScript(({ text, pausedAt }) => {
    const state = window as unknown as { releaseStream?: () => void; streamPaused?: boolean; streamClosed?: boolean };
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!new URL(url, location.href).pathname.endsWith("/api/chat")) return original(input, init);
      const encoder = new TextEncoder();
      const send = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      const released = new Promise<void>(resolve => { state.releaseStream = resolve; });
      const deltas = async (controller: ReadableStreamDefaultController, from: number, to: number) => {
        for (let offset = from; offset < to; offset += 7) {
          controller.enqueue(send({ type: "text-delta", id: "answer", delta: text.slice(offset, Math.min(offset + 7, to)) }));
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(send({ type: "start", messageId: "streamed" }));
          controller.enqueue(send({ type: "text-start", id: "answer" }));
          await deltas(controller, 0, pausedAt);
          state.streamPaused = true;
          await released;
          await deltas(controller, pausedAt, text.length);
          controller.enqueue(send({ type: "text-end", id: "answer" }));
          controller.enqueue(send({ type: "finish", finishReason: "stop" }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          state.streamClosed = true;
        },
      }), { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    };
  }, { text: document, pausedAt });
}

const markdown = (page: Page, id: string) => page.locator(`[data-message-id="${id}"] .markdown-message`);
// Screenshots with animations disabled leave an empty, inert style attribute on
// animated elements anywhere on the page, including ones not being captured.
const markup = (locator: Locator) => locator.evaluate(node => node.innerHTML.replace(/ style=""/g, "").replace(/>\s+</g, "><").trim());
// Overlays that sit above the transcript depend on scroll position, not on the message.
const hideOverlays = ".chat-transcript-content > .sticky, .message-navigator { visibility: hidden !important; }";

/** Compares two PNG screenshots in the browser, which already has a decoder. */
async function pixelDifference(page: Page, first: Buffer, second: Buffer) {
  return page.evaluate(async ([a, b]) => {
    const decode = async (base64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [x, y] = [await decode(a), await decode(b)];
    if (x.width !== y.width || x.height !== y.height) {
      return { width: x.width, height: x.height, otherWidth: y.width, otherHeight: y.height, differingPixels: x.width * x.height, totalPixels: x.width * x.height, maxChannelDelta: 255 };
    }
    let differingPixels = 0, maxChannelDelta = 0;
    for (let index = 0; index < x.data.length; index += 4) {
      let pixelDelta = 0;
      for (let channel = 0; channel < 4; channel++) pixelDelta = Math.max(pixelDelta, Math.abs(x.data[index + channel] - y.data[index + channel]));
      if (pixelDelta) differingPixels++;
      maxChannelDelta = Math.max(maxChannelDelta, pixelDelta);
    }
    return { width: x.width, height: x.height, otherWidth: y.width, otherHeight: y.height, differingPixels, totalPixels: x.width * x.height, maxChannelDelta };
  }, [first.toString("base64"), second.toString("base64")] as const);
}

async function expectSameRendering(page: Page, streamed: Locator, reference: Locator, moment: string) {
  // Rendered text: the whole document also has unrendered newlines between top-level blocks.
  await expect.poll(() => streamed.innerText(), { message: `${moment}: streamed text settles` }).toBe(await reference.innerText());
  expect(await markup(streamed), `${moment}: markup`).toBe(await markup(reference));
  await page.mouse.move(0, 0);
  const options = { animations: "disabled", caret: "hide", style: hideOverlays } as const;
  const [split, joined] = [await streamed.screenshot(options), await reference.screenshot(options)];
  await test.info().attach(`${moment}-split.png`, { body: split, contentType: "image/png" });
  await test.info().attach(`${moment}-whole.png`, { body: joined, contentType: "image/png" });
  const diff = await pixelDifference(page, split, joined);
  // Identical content at two page positions already differs by a few
  // anti-aliased edge pixels by at most 3 levels; a real change is far larger.
  expect([diff.otherWidth, diff.otherHeight], `${moment}: same size`).toEqual([diff.width, diff.height]);
  expect(diff.maxChannelDelta, `${moment}: ${JSON.stringify(diff)}`).toBeLessThanOrEqual(16);
  expect(diff.differingPixels / diff.totalPixels, `${moment}: ${JSON.stringify(diff)}`).toBeLessThan(0.001);
}

for (const { width, theme } of [{ width: 1440, theme: "dark" }, { width: 390, theme: "light" }]) {
  test(`streamed markdown split into blocks looks identical to the whole document at ${width}px in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page);
    await page.goto("/chat");
    // The theme control is in the desktop sidebar.
    if (theme === "light") await page.getByRole("button", { name: "切换主题", exact: true }).click();
    // Everything fits without scrolling, so following the stream cannot move an element mid-capture.
    await page.setViewportSize({ width, height: 12_000 });
    await expect(markdown(page, "whole-part")).toBeVisible();
    await page.getByPlaceholder(/输入你的问题/).fill("go");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { streamPaused?: boolean }).streamPaused === true);
    await expectSameRendering(page, markdown(page, "streamed"), markdown(page, "whole-part"), `${width}-${theme}-mid-stream`);
    await page.evaluate(() => (window as unknown as { releaseStream: () => void }).releaseStream());
    await page.waitForFunction(() => (window as unknown as { streamClosed?: boolean }).streamClosed === true);
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await expectSameRendering(page, markdown(page, "streamed"), markdown(page, "whole-full"), `${width}-${theme}-complete`);
  });
}
