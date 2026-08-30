import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=", "base64");

test("chunked uploads without Content-Length receive a structured size error", async ({ baseURL }) => {
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(new URL("/api/media/upload", baseURL), {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=oversized-upload" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("Chunked upload timed out")));
    const chunk = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < 23; index++) request.write(chunk);
    request.end();
  });
  expect(result.status).toBe(413);
  expect(JSON.parse(result.body).error.code).toBe("PAYLOAD_TOO_LARGE");
});

test("multipart uploads above the Proxy default retain the existing attachment limits", async ({ request }) => {
  const paddedPng = Buffer.alloc(6 * 1024 * 1024);
  png.copy(paddedPng);
  const form = new FormData();
  form.append("files", new Blob([paddedPng], { type: "image/png" }), "first.png");
  form.append("files", new Blob([paddedPng], { type: "image/png" }), "second.png");
  const encoded = new Response(form);
  const uploaded = await request.post("/api/media/upload", {
    headers: { "Content-Type": encoded.headers.get("content-type")! },
    data: Buffer.from(await encoded.arrayBuffer()),
  });
  expect(uploaded.status()).toBe(201);
  const assets = (await uploaded.json()).data as Array<{ url: string; byteSize: number }>;
  try {
    expect(assets).toHaveLength(2);
    for (const asset of assets) {
      expect(asset.byteSize).toBe(paddedPng.length);
      expect(Number((await request.head(asset.url)).headers()["content-length"])).toBe(paddedPng.length);
    }
  } finally {
    for (const asset of assets) await request.delete(asset.url);
  }
});

test("real uploaded media renders after reload and survives conversation deletion until explicit removal", async ({ page, request }) => {
  const uploaded = await request.post("/api/media/upload", { multipart: { files: { name: "saved.png", mimeType: "image/png", buffer: png } } });
  expect(uploaded.status()).toBe(201);
  const asset = (await uploaded.json()).data[0];
  const title = `Media ${randomUUID()}`;
  const created = await request.post("/api/conversations", { data: { title } });
  const chat = (await created.json()).data;
  let newerChatId: string | undefined;
  try {
    const saved = await request.post(`/api/conversations/${chat.id}/messages`, { data: {
      role: "assistant", content: "__IMAGE_RESULT__:" + JSON.stringify({ type: "image-result", assetId: asset.assetId, modelId: "test", text: "Persistent media" }),
    } });
    expect(saved.status()).toBe(201);
    await page.goto("/chat");
    await page.getByRole("button", { name: new RegExp(title) }).click();
    const image = page.getByRole("img", { name: "Generated", exact: true });
    await expect(image).toHaveAttribute("src", asset.url);
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const newer = await request.post("/api/conversations", { data: { title: `Newer ${randomUUID()}` } });
    newerChatId = (await newer.json()).data.id;
    await page.reload();
    await expect(image).toHaveAttribute("src", asset.url);
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const history = await request.get(`/api/conversations/${chat.id}/messages`);
    expect(JSON.stringify(await history.json())).not.toContain("base64");
    expect((await request.delete(asset.url)).status()).toBe(409);
    expect((await request.delete(`/api/conversations/${chat.id}`)).ok()).toBe(true);
    expect((await request.get(asset.url)).ok()).toBe(true);
    expect((await request.delete(asset.url)).ok()).toBe(true);
    expect((await request.get(asset.url)).status()).toBe(404);
  } finally {
    if (newerChatId) await request.delete(`/api/conversations/${newerChatId}`);
    await request.delete(`/api/conversations/${chat.id}`);
    await request.delete(asset.url);
  }
});

test("composer uploads binary attachments and sends only references to chat", async ({ page, request }) => {
  const title = `Attachment ${randomUUID()}`;
  const chat = (await (await request.post("/api/conversations", { data: { title } })).json()).data;
  let fileUrl = "";
  await page.route("**/api/chat", async (route) => {
    const payload = route.request().postDataJSON();
    const file = payload.messages.at(-1).parts.find((part: { type: string }) => part.type === "file");
    expect(file.url).toMatch(/^\/api\/media\/[0-9a-f-]{36}$/);
    expect(JSON.stringify(payload)).not.toContain("base64");
    fileUrl = file.url;
    const chunks = [{ type: "start", messageId: "answer" }, { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "Attachment received" }, { type: "text-end", id: "text" }, { type: "finish", finishReason: "stop" }];
    await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  });
  try {
    await page.goto("/chat");
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "attached.png", mimeType: "image/png", buffer: png });
    await page.getByPlaceholder(/输入你的问题/).fill("Describe this");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("Attachment received", { exact: true })).toBeVisible();
    expect((await request.get(fileUrl)).ok()).toBe(true);
  } finally {
    await request.delete(`/api/conversations/${chat.id}`);
    if (fileUrl) await request.delete(fileUrl);
  }
});

test("image generation UI persists the asset response and reloads the protected image", async ({ page, request }) => {
  const uploaded = await request.post("/api/media/upload", { multipart: { files: { name: "generated.png", mimeType: "image/png", buffer: png } } });
  const asset = (await uploaded.json()).data[0];
  const title = `Generation ${randomUUID()}`;
  const chat = (await (await request.post("/api/conversations", { data: { title } })).json()).data;
  await page.route("**/api/image", (route) => route.fulfill({ json: { modelId: "test-image", asset } }));
  try {
    await page.goto("/chat");
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await page.getByRole("combobox").filter({ hasText: "聊天模式" }).click();
    await page.getByRole("option", { name: "文生图模式", exact: true }).click();
    await page.getByPlaceholder(/描述你想生成的图片/).fill("A tiny image");
    const persisted = page.waitForResponse((response) => response.url().endsWith(`/api/conversations/${chat.id}/messages`) && response.request().method() === "POST" && response.request().postDataJSON()?.role === "assistant");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("图片生成完成 · test-image", { exact: true })).toBeVisible();
    expect((await persisted).status()).toBe(201);
    const history = await request.get(`/api/conversations/${chat.id}/messages`);
    const messages = (await history.json()).data;
    expect(messages.find((message: { role: string }) => message.role === "assistant").content).toContain(asset.assetId);
    expect(JSON.stringify(messages)).not.toContain("base64");
    await page.reload();
    const image = page.getByRole("img", { name: "Generated", exact: true });
    await expect(image).toHaveAttribute("src", asset.url);
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
  } finally {
    await request.delete(`/api/conversations/${chat.id}`);
    await request.delete(asset.url);
  }
});

test("storage cleanup requires confirmation and displays its result", async ({ page }) => {
  let cleanups = 0;
  await page.route("**/api/media", (route) => route.fulfill({ json: { data: { assetCount: 3, totalBytes: 1048576, referencedCount: 1, unreferencedCount: 2, reclaimableCount: cleanups ? 0 : 2, looseFileCount: 0, graceHours: 24 } } }));
  await page.route("**/api/media/cleanup", (route) => { cleanups += 1; return route.fulfill({ json: { data: { removedCount: 2, freedBytes: 1048576, failedCount: 0 } } }); });
  await page.goto("/storage");
  await expect(page.getByText("1.00 MiB", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清理未使用媒体" }).click();
  expect(cleanups).toBe(0);
  await page.getByRole("button", { name: "确认清理过期文件" }).click();
  await expect(page.getByRole("status")).toContainText("已清理 2 个文件");
  expect(cleanups).toBe(1);
});
