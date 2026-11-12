import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_MODEL } from "../../src/config/model";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { openRecentConversations } from "../helpers/conversations";

// The conversations in the sidebar, against a mocked service: their sections,
// what their dots say, and what their menu changes, on the chat page and off it.

type Summary = { id: string; title: string; lastMessageAt: string; messageCount: number; pinned?: boolean; archived?: boolean; awaitingApproval?: boolean; answering?: boolean; unread?: boolean; task?: { id: string; model: null; running: boolean } | null };
const now = new Date().toISOString();
const summary = (id: string, title: string, extra: Partial<Summary> = {}): Summary => ({ id, title, lastMessageAt: now, messageCount: 1, ...extra });

async function panels(page: Page) {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem(DEFAULT_MODEL, ["chat"])], { chat: DEFAULT_MODEL }) }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
}

/** A service holding `chats`, which PATCH changes and the list reads back. */
async function service(page: Page, chats: Summary[]) {
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: chats.filter(chat => !chat.archived), pageInfo: { nextCursor: null, hasMore: false } } }));
  await page.route(/\/api\/conversations\/[^/?]+$/, async route => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const chat = chats.find(item => item.id === id);
    if (!chat) return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      patches.push({ id, body });
      Object.assign(chat, body);
    }
    await route.fulfill({ json: { data: chat } });
  });
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [] } }));
  return patches;
}

test("conversations sort into pinned, scheduled tasks and the rest, and say which need attention", async ({ page }) => {
  await panels(page);
  const patches = await service(page, [
    summary("pinned", "置顶的会话", { pinned: true }),
    summary("brief", "每日简报", { task: { id: "t1", model: null, running: true } }),
    summary("weekly", "周报", { task: { id: "t2", model: null, running: false }, lastMessageAt: new Date(Date.now() - 86_400_000).toISOString() }),
    summary("waiting", "等着批准的会话", { awaitingApproval: true }),
    summary("plain", "普通会话"),
    summary("elsewhere", "别处在回答", { answering: true, lastMessageAt: new Date(Date.now() - 2 * 60_000).toISOString() }),
    summary("unseen", "没看过的回答", { unread: true, lastMessageAt: new Date(Date.now() - 3 * 60_000).toISOString() }),
    // Last in what the service returns (a conversation kept from beyond its first page), yet the latest.
    summary("latest", "刚刚回答的会话", { lastMessageAt: new Date(Date.now() + 60_000).toISOString() }),
  ]);
  await page.goto("/chat");
  const sidebar = await openRecentConversations(page);
  const section = (name: string) => sidebar.getByRole("region", { name, exact: true });
  await expect(section("置顶").locator(".sidebar-chat-open")).toHaveText(["置顶的会话"]);
  await expect(section("定时任务").locator(".sidebar-chat-open")).toHaveText([/^每日简报/, /^周报/]);
  // The rest in one list, most recently active first.
  await expect(section("最近").locator(".sidebar-chat-open")).toHaveText([/^刚刚回答的会话/, /^等着批准的会话/, /^普通会话/, /^别处在回答/, /^没看过的回答/]);
  // A task's conversation carries its marker; the others do not.
  await expect(section("定时任务").getByRole("img", { name: "定时任务的会话", exact: true })).toHaveCount(2);
  await expect(section("最近").getByRole("img", { name: "定时任务的会话", exact: true })).toHaveCount(0);
  // New conversations start from the + beside the list's name.
  await expect(sidebar.getByRole("button", { name: "新会话", exact: true })).toBeVisible();

  // The dot, and the words a screen reader hears for it.
  const row = (title: string) => sidebar.getByRole("button", { name: new RegExp(`^${title}`) });
  await expect(row("每日简报")).toHaveAccessibleName(/任务运行中/);
  await expect(row("每日简报").locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "task");
  await expect(row("等着批准的会话")).toHaveAccessibleName(/等你批准/);
  await expect(row("等着批准的会话").locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "approval");
  await expect(row("周报").locator(".sidebar-chat-dot")).not.toHaveAttribute("data-state", /.+/);
  // Answering in another window or by the service, and an answer not opened yet.
  await expect(row("别处在回答")).toHaveAccessibleName(/正在回答/);
  await expect(row("别处在回答").locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "working");
  await expect(row("没看过的回答")).toHaveAccessibleName(/有新回答/);
  await expect(row("没看过的回答").locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "unread");
  // Opened, it is read: the dot goes, and the service is told.
  await row("没看过的回答").click();
  await expect(page.locator(".chat-toolbar h3")).toHaveText("没看过的回答");
  await expect(row("没看过的回答").locator(".sidebar-chat-dot")).not.toHaveAttribute("data-state", /.+/);
  await expect.poll(() => patches.some(patch => patch.id === "unseen" && patch.body.unread === false)).toBe(true);
  await expect(row("普通会话").locator(".sidebar-chat-dot")).not.toHaveAttribute("data-state", /.+/);

  // A section folds away, and stays folded the next time the app opens.
  const header = sidebar.getByRole("button", { name: "定时任务", exact: true });
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(row("每日简报")).toHaveCount(0);
  // It eases shut rather than vanishing, and nothing in it can be reached while shut.
  const fold = section("定时任务").locator(".sidebar-chat-fold");
  await expect.poll(() => fold.evaluate(node => node.getBoundingClientRect().height)).toBe(0);
  await expect(fold).toHaveAttribute("inert", "");
  await page.reload();
  const reopened = await openRecentConversations(page);
  await expect(reopened.getByRole("button", { name: "定时任务", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(reopened.getByRole("button", { name: /^每日简报/ })).toHaveCount(0);
  await reopened.getByRole("button", { name: "定时任务", exact: true }).click();
  await expect(reopened.getByRole("button", { name: /^每日简报/ })).toBeVisible();
});

test("a conversation opens from any page, and its menu pins and archives it", async ({ page }) => {
  await panels(page);
  const patches = await service(page, [summary("alpha", "Alpha"), summary("beta", "Beta")]);
  await page.goto("/tasks");
  const sidebar = await openRecentConversations(page);
  const row = (title: string) => sidebar.getByRole("button", { name: new RegExp(`^${title}`) });
  await row("Beta").click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.locator(".chat-toolbar h3")).toHaveText("Beta");
  await expect(row("Beta")).toHaveAttribute("aria-current", "true");

  // Pinned, it moves up into its own section.
  await sidebar.getByRole("button", { name: "会话操作：Beta", exact: true }).click();
  await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect(sidebar.getByRole("region", { name: "置顶", exact: true }).getByRole("button", { name: /^Beta/ })).toBeVisible();
  expect(patches).toEqual([{ id: "beta", body: { pinned: true } }]);

  // Archiving the open conversation takes it out of the list and opens the next one.
  await sidebar.getByRole("button", { name: "会话操作：Beta", exact: true }).click();
  await page.getByRole("menuitem", { name: "归档", exact: true }).click();
  await expect(row("Beta")).toHaveCount(0);
  await expect(page.getByText("已归档", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-toolbar h3")).toHaveText("Alpha");
  await expect(row("Alpha")).toHaveAttribute("aria-current", "true");
  expect(patches.at(-1)).toEqual({ id: "beta", body: { archived: true } });
});

test("the conversation answering in this window shows it, and stops when the answer ends", async ({ page }) => {
  await panels(page);
  await service(page, [summary("talk", "Talk")]);
  await page.route("**/api/conversations/talk/messages", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { data: [] } });
    const body = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { data: { id: `row-${body.clientMessageId}`, clientMessageId: body.clientMessageId, role: body.role, content: body.content, createdAt: now } } });
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/chat", async route => {
    await held;
    const chunks = [{ type: "start", messageId: "answer" }, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "Done" }, { type: "text-end", id: "a" }, { type: "finish", finishReason: "stop" }];
    await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  });
  await page.goto("/chat");
  const sidebar = await openRecentConversations(page);
  const row = sidebar.getByRole("button", { name: /^Talk/ });
  await expect(page.locator(".chat-toolbar h3")).toHaveText("Talk");
  await page.getByPlaceholder(/输入你的问题/).fill("Hello");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(row).toHaveAccessibleName(/正在回答/);
  await expect(row.locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "working");
  release();
  await expect(page.getByText("Done", { exact: true })).toBeVisible();
  await expect(row.locator(".sidebar-chat-dot")).not.toHaveAttribute("data-state", /.+/);
});
