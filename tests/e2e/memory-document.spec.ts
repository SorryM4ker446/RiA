import { expect, test, type Page, type Route } from "@playwright/test";

type Note = { line: number; text: string };
type Topic = { id: string; title: string; summary: string; updatedAt: string; notes: Note[] };
const NOW = "2026-10-12T08:00:00.000Z";
const view = (revision: number, topics: Topic[], unsorted: Note[] = [], extra: Record<string, unknown> = {}) => ({ data: {
  content: [...topics.flatMap(topic => topic.notes), ...unsorted].length ? `# MEMORY\n\n## About the user\n${[...topics.flatMap(topic => topic.notes), ...unsorted].map(note => `- ${note.text}`).join("\n")}\n` : "",
  revision, updatedAt: NOW, topics, unsorted, settled: !unsorted.length && topics.every(topic => topic.summary), organizing: false, ...extra,
} });
const hobbies = (notes: string[]): Topic => ({ id: "hobbies", title: "爱好", summary: "绘画和园艺方面的兴趣。", updatedAt: NOW, notes: notes.map((text, index) => ({ line: index + 1, text })) });
const work: Topic = { id: "work", title: "工作", summary: "他们是一名护士。", updatedAt: NOW, notes: [{ line: 3, text: "Works as a nurse in Shanghai." }] };

async function memoryRoute(page: Page, handle: (route: Route, method: string) => Promise<void> | void) {
  await page.route("**/api/memory/document*", route => handle(route, route.request().method()));
}
const openRia = async (page: Page) => {
  await page.goto("/chat?settings=ria");
  return page.getByRole("dialog");
};

test("Your RiA leads to the sorted memory and to MEMORY.md, and is gone from the knowledge page", async ({ page }) => {
  await memoryRoute(page, route => route.fulfill({ json: view(3, [hobbies(["Draws.", "Keeps a garden."]), work]) }));
  await page.goto("/knowledge");
  await expect(page.getByRole("heading", { name: "知识条目", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "长期记忆" })).toHaveCount(0);

  const settings = await openRia(page);
  const tabs = await settings.getByRole("tab").allTextContents();
  expect(tabs.indexOf("你的 RiA"), "it follows the application preferences").toBe(tabs.indexOf("应用偏好") + 1);
  await expect(settings).toContainText("2 个主题 · 3 条内容");
  await expect(settings).toContainText("MEMORY.md");
  await page.screenshot({ path: test.info().outputPath("home.png") });

  await settings.getByRole("button", { name: "管理" }).click();
  const row = settings.getByRole("listitem").filter({ hasText: "爱好" });
  await expect(row).toContainText("绘画和园艺方面的兴趣。");
  await expect(row).toContainText("更新于");
  await expect(settings.getByRole("button", { name: "你的 RiA" })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("topics.png") });

  await row.getByRole("button", { name: /爱好/ }).first().click();
  await expect(settings.getByRole("heading", { name: "爱好" })).toBeVisible();
  await expect(settings.getByText("上次更新")).toBeVisible();
  await expect(settings.getByText("绘画和园艺方面的兴趣。")).toBeVisible();
  await expect(settings.getByText("Keeps a garden.")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("topic.png") });
  await settings.getByRole("button", { name: "记忆", exact: true }).click();
  await settings.getByRole("button", { name: "你的 RiA" }).click();

  await settings.getByRole("button", { name: "查看" }).click();
  await expect(settings.getByRole("heading", { name: "MEMORY.md" })).toBeVisible();
  await expect(settings.locator(".memory-source")).toContainText("## About the user");
  await expect(settings.locator(".memory-source")).toContainText("- Works as a nurse in Shanghai.");
  await page.screenshot({ path: test.info().outputPath("source.png") });
});

test("a note is deleted only once the server agrees, and the last one takes its topic and returns to the list", async ({ page }) => {
  let current = view(4, [hobbies(["Draws.", "Keeps a garden."]), work]);
  const deletions: string[] = [];
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await memoryRoute(page, async (route, method) => {
    if (method === "DELETE") {
      deletions.push(new URL(route.request().url()).search);
      if (deletions.length === 1) await held;
      current = deletions.length === 1 ? view(5, [hobbies(["Keeps a garden."]), work]) : view(6, [work]);
    }
    await route.fulfill({ json: current });
  });
  const settings = await openRia(page);
  await settings.getByRole("button", { name: "管理" }).click();
  await settings.getByRole("listitem").filter({ hasText: "爱好" }).getByRole("button", { name: /爱好/ }).first().click();

  const note = settings.getByRole("listitem").filter({ hasText: "Draws." });
  const next = settings.getByRole("listitem").filter({ hasText: "Keeps a garden." });
  await next.evaluate(element => { (element as HTMLElement).dataset.same = "yes"; });
  await note.hover();
  await note.getByRole("button", { name: "删除这条" }).click();
  await expect.poll(() => deletions.length).toBe(1);
  await expect(note, "nothing leaves before the server has agreed").toBeVisible();
  await expect(next.getByRole("button", { name: "删除这条" })).toBeDisabled();
  release();
  await expect(note).toHaveCount(0);
  expect(deletions).toEqual(["?revision=4&lines=1"]);
  await expect(next, "the rows that stay are the same rows").toHaveAttribute("data-same", "yes");

  await next.hover();
  await next.getByRole("button", { name: "删除这条" }).click();
  await expect(settings.getByRole("heading", { name: "记忆", exact: true })).toBeVisible();
  await expect(settings.getByRole("listitem").filter({ hasText: "爱好" })).toHaveCount(0);
  await expect(settings.getByRole("listitem").filter({ hasText: "工作" })).toBeVisible();
});

test("a topic is deleted after asking, with all its notes, and everything can be deleted from MEMORY.md", async ({ page }) => {
  let current = view(4, [hobbies(["Draws.", "Paints."]), work]);
  const deletions: string[] = [];
  await memoryRoute(page, async (route, method) => {
    if (method === "DELETE") {
      deletions.push(new URL(route.request().url()).search);
      current = deletions.length === 1 ? view(5, [work]) : view(6, []);
    }
    await route.fulfill({ json: current });
  });
  const settings = await openRia(page);
  await settings.getByRole("button", { name: "管理" }).click();
  const row = settings.getByRole("listitem").filter({ hasText: "爱好" });
  await row.hover();
  await row.getByRole("button", { name: "删除主题 爱好" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("其中的 2 条内容");
  await dialog.getByRole("button", { name: "删除" }).click();
  await expect(row).toHaveCount(0);
  expect(deletions).toEqual(["?revision=4&lines=1,2"]);

  await settings.getByRole("button", { name: "你的 RiA" }).click();
  await settings.getByRole("button", { name: "查看" }).click();
  await settings.getByRole("button", { name: "全部删除" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "全部删除" }).click();
  await expect(settings).toContainText("还没有内容");
  expect(deletions.at(-1)).toBe("?revision=5&lines=".slice(0, 11));
  await expect(settings.getByRole("button", { name: "全部删除" })).toHaveCount(0);
});

test("a note can be reworded in place, and leaving the edit does not leave the settings", async ({ page }) => {
  let current = view(4, [hobbies(["Draws."])]);
  const edits: unknown[] = [];
  let refuse = true;
  await memoryRoute(page, async (route, method) => {
    if (method === "PATCH") {
      edits.push(route.request().postDataJSON());
      if (refuse) { refuse = false; return route.fulfill({ status: 409, json: { error: { code: "CONFLICT", message: "changed" } } }); }
      current = view(5, [{ ...hobbies(["Sketches every day."]), summary: "" }], [], { organizing: true });
    }
    await route.fulfill({ json: current });
  });
  const settings = await openRia(page);
  await settings.getByRole("button", { name: "管理" }).click();
  await settings.getByRole("listitem").filter({ hasText: "爱好" }).getByRole("button", { name: /爱好/ }).first().click();

  const note = settings.getByRole("listitem").filter({ hasText: "Draws." });
  await note.hover();
  await note.getByRole("button", { name: "修改这条" }).click();
  const editor = settings.getByRole("textbox", { name: "修改这条" });
  await expect(editor).toBeFocused();
  await editor.fill("Discarded.");
  await editor.press("Escape");
  await expect(settings).toBeVisible();
  await expect(settings.getByText("Draws.")).toBeVisible();
  expect(edits).toEqual([]);

  await note.hover();
  await note.getByRole("button", { name: "修改这条" }).click();
  await editor.fill("Sketches every day.");
  await editor.press("Enter");
  await expect.poll(() => edits.length).toBe(1);
  await expect(settings.getByRole("button", { name: "保存" })).toBeEnabled();
  await expect(editor, "a refused change keeps what was typed").toHaveValue("Sketches every day.");
  await expect(editor, "and the caret stays where it was").toBeFocused();
  await settings.getByRole("button", { name: "保存" }).click();
  await expect(settings.getByText("Sketches every day.")).toBeVisible();
  await expect(editor).toHaveCount(0);
  expect(edits.at(-1)).toEqual({ revision: 4, line: 1, text: "Sketches every day." });
  await expect(settings.getByText("摘要"), "a summary that may say the old thing is not shown").toHaveCount(0);
});

test("unsorted notes stay readable, get one try while the page is open, and show when sorting finishes", async ({ page }) => {
  const posts: string[] = [];
  let state: "failing" | "organizing" | "done" = "failing";
  const unsorted = [{ line: 1, text: "Draws." }];
  await memoryRoute(page, async (route, method) => {
    if (method === "POST") {
      posts.push(state);
      return route.fulfill({ json: state === "failing" ? view(2, [], unsorted) : view(2, [], unsorted, { organizing: true }) });
    }
    if (state === "organizing") { state = "done"; return route.fulfill({ json: view(2, [], unsorted, { organizing: true }) }); }
    return route.fulfill({ json: state === "done" && posts.length > 1 ? view(2, [hobbies(["Draws."])]) : view(2, [], unsorted) });
  });
  const settings = await openRia(page);
  await expect(settings).toContainText("1 条内容，等待整理");
  await expect.poll(() => posts.length, "one try").toBe(1);
  await settings.getByRole("button", { name: "管理" }).click();
  const row = settings.getByRole("listitem").filter({ hasText: "未归类" });
  await expect(row).toContainText("Draws.");
  await expect(row.getByRole("button", { name: /删除主题/ })).toHaveCount(0);
  await row.getByRole("button", { name: /未归类/ }).first().click();
  await expect(settings.getByText("Draws.")).toBeVisible();
  await settings.getByRole("button", { name: "记忆", exact: true }).click();

  state = "organizing";
  await settings.getByRole("button", { name: "重新整理" }).click();
  await expect(settings.getByRole("status")).toContainText("正在整理");
  await expect(settings.getByRole("listitem").filter({ hasText: "爱好" }), "it checks back while sorting").toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveCount(0);
  await expect(settings.getByRole("status")).toHaveCount(0);
});

test("a deletion the server refuses leaves the note in place, and a failed read can be tried again", async ({ page }) => {
  let reads = 0;
  let readFails = true;
  await memoryRoute(page, async (route, method) => {
    if (method === "DELETE") return route.fulfill({ status: 409, json: { error: { code: "CONFLICT", message: "changed" } } });
    reads += 1;
    if (readFails) return route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "down" } } });
    return route.fulfill({ json: reads > 2 ? view(8, [hobbies(["Draws.", "Added while you were looking."])]) : view(7, [hobbies(["Draws."])]) });
  });
  const settings = await openRia(page);
  await expect(settings).toContainText("没能读取记忆");
  await expect(settings.getByRole("button", { name: "管理" })).toHaveCount(0);
  readFails = false;
  await settings.getByRole("button", { name: "重试" }).click();

  await settings.getByRole("button", { name: "管理" }).click();
  await settings.getByRole("listitem").filter({ hasText: "爱好" }).getByRole("button", { name: /爱好/ }).first().click();
  const note = settings.getByRole("listitem").filter({ hasText: "Draws." });
  await note.hover();
  await note.getByRole("button", { name: "删除这条" }).click();
  await expect(settings.getByRole("listitem").filter({ hasText: "Added while you were looking." }), "it shows what is there now").toBeVisible();
  await expect(note).toBeVisible();
  expect((await note.boundingBox())?.height).toBeGreaterThan(20);
});
