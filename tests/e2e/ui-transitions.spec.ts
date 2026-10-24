import { expect, test, type Page } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

test("the first launch is dark and the wordmark stays readable across saved themes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/dark/);
  const wordmark = page.locator(".workspace-brand-wordmark");
  await expect(wordmark).toHaveText("RiA");
  await expect(page.locator(".workspace-brand img")).toHaveCount(0);
  const darkColor = await wordmark.evaluate(node => getComputedStyle(node).color);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(wordmark).toHaveCSS("color", "rgb(24, 24, 27)");
  expect(darkColor).not.toBe("rgb(24, 24, 27)");
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(wordmark).toHaveText("RiA");
});

test("desktop settings hydrate before exposing controls supplied by preload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "riaDesktop", { value: {
      getSettings: async () => { throw new Error("Settings bridge unavailable in renderer fixture"); },
      getRuntimeInfo: async () => { throw new Error("Runtime bridge unavailable in renderer fixture"); },
    } });
  });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "应用偏好", exact: true }).click();
  await expect(page.getByRole("heading", { name: "关闭窗口时", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "全局快捷键", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("navigation sheets animate in both directions and return keyboard focus", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "打开导航" });
  await trigger.click();
  const navigation = page.getByRole("dialog", { name: "工作区导航" });
  await expect(navigation).toBeVisible();
  await expect(navigation).toHaveCSS("animation-name", "sheet-in");
  await page.keyboard.press("Shift+Tab");
  expect(await navigation.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await trigger.click();
  await navigation.getByRole("link", { name: "知识库", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(navigation).toBeHidden();
  await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
  await expect(page.locator("main h1")).toContainText("知识库");
  expect(errors).toEqual([]);
});

test("reduced motion keeps navigation and model tabs usable without animations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "打开导航" }).click();
  const navigation = page.getByRole("dialog", { name: "工作区导航" });
  await expect(navigation).toHaveCSS("animation-name", "none");
  await navigation.getByRole("button", { name: "设置", exact: true }).click();
  await expect(navigation).toBeHidden();
  await page.getByRole("dialog", { name: "设置", exact: true }).getByRole("tab", { name: "模型", exact: true }).click();
  const imageTab = page.getByRole("tab", { name: "图片生成", exact: true });
  await imageTab.click();
  await expect(imageTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "视频生成", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "视频生成", exact: true })).toHaveCount(1);
  await expect(page.getByRole("tabpanel", { name: "视频生成", exact: true })).toHaveCSS("animation-name", "none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("moving between a page and chat in the desktop app does not fade the see-through window", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // The desktop bridge is what makes the chat window see-through.
  await page.addInitScript(() => {
    Object.defineProperty(window, "riaDesktop", { value: { getSettings: async () => { throw new Error("not needed"); }, getRuntimeInfo: async () => { throw new Error("not needed"); } } });
  });
  await page.goto("/tasks");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-desktop", "true");
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { motion: string[] }).motion = seen;
    const record = (event: TransitionEvent | AnimationEvent) => {
      const target = event.target as Element;
      if (event instanceof TransitionEvent && event.propertyName === "background-color" && target.matches(".workspace-shell, .workspace-content")) seen.push(`${target.className.split(" ")[0]} background`);
      if (event instanceof AnimationEvent && target.matches(".chat-workspace")) seen.push("chat fade");
    };
    document.addEventListener("transitionrun", record, true);
    document.addEventListener("animationstart", record, true);
  });
  const navigation = page.getByRole("navigation", { name: "工作区导航" });
  for (const [link, path] of [["聊天", /\/chat$/], ["定时任务", /\/tasks$/], ["聊天", /\/chat$/]] as const) {
    await navigation.getByRole("link", { name: link, exact: true }).click();
    await expect(page).toHaveURL(path);
  }
  await expect(page.locator(".chat-workspace")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { motion: string[] }).motion)).toEqual([]);
});

type ReturnRecord = { welcome: boolean; stop: boolean; generating: boolean; newChatTitle: boolean; modelPlaceholder: boolean; earlySkeleton: boolean; composerTops: number[]; transcriptBoxes: string[]; toolLefts: number[]; actionLefts: number[] };

/**
 * Watches the chat page from the moment it mounts: every DOM state it commits
 * (a MutationObserver sees states that never reach a frame) and the position of
 * the composer and the transcript in every painted frame.
 */
async function recordChatReturn(page: Page) {
  await page.evaluate(() => {
    const seen = { welcome: false, stop: false, generating: false, newChatTitle: false, modelPlaceholder: false, earlySkeleton: false, composerTops: [] as number[], transcriptBoxes: [] as string[], toolLefts: [] as number[], actionLefts: [] as number[] };
    let skeletonSince: number | null = null;
    (window as unknown as { chatReturn: typeof seen }).chatReturn = seen;
    const check = () => {
      if (document.querySelector(".chat-welcome")) seen.welcome = true;
      if (document.querySelector('.chat-workspace button[aria-label="停止"]')) seen.stop = true;
      const toolbar = document.querySelector(".chat-toolbar");
      if (toolbar?.textContent?.includes("生成中")) seen.generating = true;
      if (toolbar?.querySelector("h3")?.textContent === "新会话") seen.newChatTitle = true;
      // The model is already chosen; "选择模型" in its place would be a claim that it is not.
      if (document.querySelector('.chat-workspace [aria-label="选择模型"]')?.textContent?.includes("选择模型")) seen.modelPlaceholder = true;
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
    const frame = () => {
      check();
      const composer = document.querySelector(".chat-workspace textarea");
      const transcript = document.querySelector("[data-testid=message-list]");
      if (composer) seen.composerTops.push(Math.round(composer.getBoundingClientRect().top));
      if (transcript) { const box = transcript.getBoundingClientRect(); seen.transcriptBoxes.push(`${Math.round(box.top)}:${Math.round(box.height)}`); }
      const tools = document.querySelector('.chat-workspace [aria-label="选择工具"]');
      if (tools) seen.toolLefts.push(Math.round(tools.getBoundingClientRect().left));
      // Conversation controls count only once painted: hidden, they may still settle.
      const actions = document.querySelector(".chat-toolbar-actions");
      const assistant = document.getElementById("chat-assistant");
      if (actions && assistant && getComputedStyle(actions).visibility === "visible") seen.actionLefts.push(Math.round(assistant.getBoundingClientRect().left));
      // A placeholder painted within a quick load's first frames is the flash being avoided.
      const skeleton = document.querySelector<HTMLElement>("[data-testid=message-skeleton]");
      if (!skeleton) skeletonSince = null;
      else {
        skeletonSince ??= performance.now();
        const style = getComputedStyle(skeleton);
        if (performance.now() - skeletonSince < 150 && style.visibility === "visible" && Number(style.opacity) > 0) seen.earlySkeleton = true;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return () => page.evaluate(() => (window as unknown as { chatReturn: ReturnRecord }).chatReturn);
}

for (const reducedMotion of [false, true]) {
  test(`returning to chat goes straight from the placeholder to the restored conversation${reducedMotion ? " with reduced motion" : ""}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    const chat = { id: "returning-conversation", title: "Returning conversation", lastMessageAt: "2026-10-24T00:00:00Z", messageCount: 4 };
    const history = Array.from({ length: 4 }, (_, index) => ({ id: `return-${index}`, clientMessageId: null, role: index % 2 ? "assistant" : "user", content: `Returning message ${index}. `.repeat(16), status: "success" }));
    const modelSettings = modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" });
    // Open gates on the first visit; the return visit holds each read so every
    // state chat passes through on the way back can be looked at.
    const gates = { settings: Promise.resolve(), list: Promise.resolve(), history: Promise.resolve() };
    await page.route("**/api/models", async route => { await gates.settings; await route.fulfill({ json: modelSettings }); });
    await page.route("**/api/conversations", async route => { await gates.list; await route.fulfill({ json: { data: [chat] } }); });
    let historyRequests = 0;
    await page.route("**/api/conversations/*/messages", async route => { historyRequests++; await gates.history; await route.fulfill({ json: { data: history } }); });
    await page.route("**/api/conversations/*/runs**", route => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
    const navigation = page.getByRole("navigation", { name: "工作区导航" });
    await page.goto("/chat");
    await expect(page.getByText("Returning message 3.", { exact: false }).first()).toBeVisible();
    await navigation.getByRole("link", { name: "定时任务", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);

    const release = { settings: () => {}, list: () => {}, history: () => {} };
    gates.settings = new Promise(resolve => { release.settings = resolve; });
    gates.list = new Promise(resolve => { release.list = resolve; });
    gates.history = new Promise(resolve => { release.history = resolve; });
    try {
      const read = await recordChatReturn(page);
      const historyBefore = historyRequests;
      await navigation.getByRole("link", { name: "聊天", exact: true }).click();
      await expect(page).toHaveURL(/\/chat$/);

      // Nothing is known yet: the transcript is reserved, not declared empty, and
      // reading the saved settings is not presented as a running turn.
      const skeleton = page.getByTestId("message-skeleton");
      await expect(skeleton).toBeAttached();
      await expect(page.locator(".chat-toolbar h3")).toHaveText("");
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
      // A load that is quick enough never paints the placeholder; a slow one still does.
      const reveal = await skeleton.evaluate(node => ({ delay: getComputedStyle(node).animationDelay, animations: node.getAnimations().length }));
      if (reducedMotion) {
        // Animations are off, so the delay is a timer: hidden until it marks the placeholder late.
        expect(reveal.animations).toBe(0);
        await expect(skeleton).toHaveAttribute("data-late", "true");
        await expect(skeleton).toBeVisible();
      } else expect(reveal.delay).toBe("0.2s");
      // Conversation controls wait for the conversation instead of appearing one by one.
      await expect(page.locator(".chat-toolbar-actions")).toHaveCSS("visibility", "hidden");
      await expect.poll(() => skeleton.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
      // The remembered conversation's history is asked for while the list is still outstanding,
      // rather than after it answers.
      await expect.poll(() => historyRequests).toBe(historyBefore + 1);

      // The conversation is known before its history is: still the placeholder.
      release.settings();
      release.list();
      await expect(page.locator(".chat-toolbar h3")).toHaveText(chat.title);
      await expect(skeleton).toBeAttached();
      await expect(page.locator(".chat-welcome")).toHaveCount(0);

      release.history();
      await expect(page.getByText("Returning message 3.", { exact: false }).first()).toBeVisible();
      await expect(skeleton).toHaveCount(0);
      await expect.poll(() => page.getByTestId("message-list").evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      const seen = await read();
      expect(seen).toMatchObject({ welcome: false, stop: false, generating: false, newChatTitle: false, modelPlaceholder: false, earlySkeleton: false });
      await expect(page.getByRole("checkbox", { name: "不记长期记忆", exact: true })).toBeVisible();
      // Content changed inside the transcript; nothing around it moved.
      expect(new Set(seen.composerTops).size).toBe(1);
      expect(new Set(seen.transcriptBoxes).size).toBe(1);
      // The model name arriving does not push the tool picker, and the toolbar controls appear in place.
      expect(new Set(seen.toolLefts).size).toBe(1);
      expect(seen.actionLefts.length).toBeGreaterThan(0);
      expect(new Set(seen.actionLefts).size).toBe(1);
    } finally { release.settings(); release.list(); release.history(); }
  });
}

for (const stale of ["deleted", "archived"] as const) {
  test(`a remembered conversation that was ${stale} since the last visit gives way without an error or its messages`, async ({ page }) => {
    const kept = { id: "kept-conversation", title: "Kept conversation", lastMessageAt: "2026-10-24T00:00:00Z", messageCount: 2 };
    const gone = { id: "gone-conversation", title: "Gone conversation", lastMessageAt: "2026-10-23T00:00:00Z", messageCount: 2, archived: true };
    const messages = (prefix: string) => Array.from({ length: 2 }, (_, index) => ({ id: `${prefix}-${index}`, clientMessageId: null, role: index % 2 ? "assistant" : "user", content: `${prefix} message ${index}.`, status: "success" }));
    const modelSettings = modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" });
    let releaseList!: () => void;
    const list = new Promise<void>(resolve => { releaseList = resolve; });
    const notFound = { status: 404, json: { error: { code: "NOT_FOUND", message: "Conversation not found" } } };
    await page.route("**/api/models", route => route.fulfill({ json: modelSettings }));
    await page.route("**/api/conversations", async route => { await list; await route.fulfill({ json: { data: [kept] } }); });
    await page.route(`**/api/conversations/${gone.id}`, route => route.fulfill(stale === "deleted" ? notFound : { json: { data: gone } }));
    // The remembered conversation's history answers first, before the list can say it is gone.
    await page.route(`**/api/conversations/${gone.id}/messages`, route => route.fulfill(stale === "deleted" ? notFound : { json: { data: messages("Gone") } }));
    await page.route(`**/api/conversations/${kept.id}/messages`, route => route.fulfill({ json: { data: messages("Kept") } }));
    await page.route("**/api/conversations/*/runs**", route => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
    await page.addInitScript(id => {
      if (!sessionStorage.getItem("remembered")) { localStorage.setItem("chat:last-active-id", id); sessionStorage.setItem("remembered", "1"); }
      const seen = { error: false, gone: false };
      (window as unknown as { staleRestore: typeof seen }).staleRestore = seen;
      new MutationObserver(() => {
        const text = document.body.textContent ?? "";
        if (text.includes("请求失败") || text.includes("请重新加载会话后再发送")) seen.error = true;
        if (text.includes("Gone message")) seen.gone = true;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, gone.id);
    await page.goto("/chat");
    await expect.poll(() => page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).some(entry => entry.name.includes("/gone-conversation/messages")))).toBe(true);
    // Not yet confirmed: nothing to send to.
    await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    releaseList();
    await expect(page.getByText("Kept message 1.", { exact: true })).toBeVisible();
    await expect(page.locator(".chat-toolbar h3")).toHaveText(kept.title);
    expect(await page.evaluate(() => (window as unknown as { staleRestore: { error: boolean; gone: boolean } }).staleRestore)).toEqual({ error: false, gone: false });
    expect(await page.evaluate(() => localStorage.getItem("chat:last-active-id"))).toBe(kept.id);
  });
}
