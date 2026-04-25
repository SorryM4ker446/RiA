import { test, expect, type Page } from "@playwright/test";

type Task = {
  id: string;
  title: string;
  details: string | null;
  dueDate: string | null;
  priority: "low" | "medium" | "high";
  status: "todo" | "in_progress" | "done";
  createdAt: string;
  updatedAt: string;
};

type KnowledgeEntry = {
  id: string;
  key: string;
  value: string;
  score: number | null;
  createdAt: string;
  updatedAt: string;
};

async function setupP0ApiMocks(page: Page) {
  const now = new Date().toISOString();
  const tasks: Task[] = [];
  const knowledgeEntries: KnowledgeEntry[] = [];
  const chatId = "e2e-chat";

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        json: {
          data: {
            id: chatId,
            title: "E2E Chat",
            createdAt: now,
            updatedAt: now,
            lastMessageAt: now,
            messageCount: 0,
          },
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        data: [
          {
            id: chatId,
            title: "E2E Chat",
            createdAt: now,
            updatedAt: now,
            lastMessageAt: now,
            messageCount: 0,
          },
        ],
      },
    });
  });

  await page.route("**/api/conversations/**/messages", async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ json: { data: { id: crypto.randomUUID(), ...body, createdAt: now } } });
      return;
    }
    await route.fulfill({ json: { data: [] } });
  });

  await page.route("**/api/tasks**", async (route) => {
    await route.fulfill({ json: { data: tasks } });
  });

  await page.route("**/api/tasks/*", async (route) => {
    const id = route.request().url().split("/").pop() ?? "";
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Task not found" } } });
      return;
    }

    if (route.request().method() === "PATCH") {
      const body = JSON.parse(route.request().postData() || "{}");
      tasks[index] = { ...tasks[index], ...body, updatedAt: new Date().toISOString() };
      await route.fulfill({ json: { data: tasks[index] } });
      return;
    }

    if (route.request().method() === "DELETE") {
      tasks.splice(index, 1);
      await route.fulfill({ json: { success: true } });
      return;
    }

    await route.fulfill({ json: { data: tasks[index] } });
  });

  await page.route("**/api/knowledge**", async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      const entry: KnowledgeEntry = {
        id: crypto.randomUUID(),
        key: body.key,
        value: body.value,
        score: 0.85,
        createdAt: now,
        updatedAt: now,
      };
      knowledgeEntries.unshift(entry);
      await route.fulfill({ status: 201, json: { data: entry } });
      return;
    }

    await route.fulfill({ json: { data: knowledgeEntries } });
  });

  await page.route("**/api/knowledge/*", async (route) => {
    const id = route.request().url().split("/").pop() ?? "";
    const index = knowledgeEntries.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      knowledgeEntries.splice(index, 1);
    }
    await route.fulfill({ json: { success: true } });
  });

  await page.route("**/api/tools/run", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");

    if (body.tool === "webSearch") {
      expect(body.input).not.toHaveProperty("maxResults");
      await route.fulfill({
        json: {
          tool: "webSearch",
          data: {
            query: body.input.query,
            requestId: "e2e-tavily-request",
            results: [
              {
                title: "P0 Tools Readiness Source",
                url: "https://example.com/p0-tools",
                snippet: "Mocked Tavily result used by the P0 tools readiness E2E flow.",
                score: 0.94,
                source: "tavily",
              },
            ],
          },
          assistantText:
            "已完成 Web Search，返回 1 条结果。\n\n结论：P0 tools readiness 的搜索结果已可用于综合判断。搜索来源可在下方展开查看。",
        },
      });
      return;
    }

    if (body.tool === "createTask") {
      const task: Task = {
        id: crypto.randomUUID(),
        title: body.input.title,
        details: body.input.details ?? null,
        dueDate: body.input.dueDate ?? null,
        priority: body.input.priority ?? "medium",
        status: "todo",
        createdAt: now,
        updatedAt: now,
      };
      tasks.unshift(task);
      await route.fulfill({
        json: {
          tool: "createTask",
          data: {
            taskId: task.id,
            title: task.title,
            details: task.details,
            dueDate: task.dueDate,
            priority: task.priority,
            status: task.status,
            createdAt: task.createdAt,
          },
          assistantText: `已创建任务「${task.title}」，当前状态为 todo。`,
        },
      });
      return;
    }

    if (body.tool === "searchKnowledge") {
      const result = knowledgeEntries.find((entry) =>
        `${entry.key} ${entry.value}`.toLowerCase().includes(String(body.input.query).toLowerCase()),
      );
      await route.fulfill({
        json: {
          tool: "searchKnowledge",
          data: {
            query: body.input.query,
            total: result ? 1 : 0,
            results: result
              ? [
                  {
                    id: result.id,
                    title: result.key,
                    snippet: result.value,
                    source: "memory",
                    score: 1,
                  },
                ]
              : [],
          },
          assistantText: result
            ? `根据你的知识库记忆，${result.value}`
            : `我在当前知识库里没有找到和“${body.input.query}”直接相关的内容。`,
        },
      });
      return;
    }

    await route.fulfill({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR", message: "Unsupported tool" } },
    });
  });
}

test.beforeEach(async ({ page }) => {
  await setupP0ApiMocks(page);
});

test("manual webSearch shows traceable source in chat UI", async ({ page }) => {
  await page.goto("/chat");
  await page.getByLabel("选择手动工具").click();
  await page.getByRole("option", { name: "手动：Web 搜索" }).click();
  await page.getByPlaceholder(/输入要搜索的关键词/).fill("P0 tools readiness");
  await page.getByRole("button", { name: "执行工具" }).click();

  await expect(page.getByText("已完成 Web Search")).toBeVisible();
  await page.getByText(/搜索来源（1）/).click();
  await expect(page.getByRole("link", { name: "P0 Tools Readiness Source" })).toHaveAttribute(
    "href",
    "https://example.com/p0-tools",
  );
  await expect(page.getByText(/工具详情：webSearch/)).toBeVisible();
});

test("createTask persists to task panel and status can move to done", async ({ page }) => {
  await page.goto("/chat");
  await page.getByLabel("选择手动工具").click();
  await page.getByRole("option", { name: "手动：创建任务" }).click();
  await page.getByPlaceholder(/输入任务标题/).fill("P0 E2E task");
  await page.getByRole("button", { name: "执行工具" }).click();

  const taskPanel = page.getByTestId("task-panel");
  await expect(taskPanel.getByText("P0 E2E task")).toBeVisible();
  await page.getByLabel("任务状态 P0 E2E task").click();
  await page.getByRole("option", { name: "已完成" }).click();
  await expect(taskPanel.getByText("已完成").first()).toBeVisible();
});

test("new knowledge entry can be retrieved by searchKnowledge", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("link", { name: /知识库/ }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await page.getByPlaceholder("知识标题").fill("P0 readiness keyword");
  await page.getByPlaceholder("知识内容").fill("P0 readiness knowledge entry visible to searchKnowledge.");
  await page.getByRole("button", { name: "新增知识" }).click();
  await expect(page.getByText("P0 readiness keyword")).toBeVisible();

  await page.getByRole("link", { name: /返回聊天/ }).click();
  await page.getByLabel("选择手动工具").click();
  await page.getByRole("option", { name: "手动：知识检索" }).click();
  await page.getByPlaceholder(/输入要检索的关键词/).fill("P0 readiness keyword");
  await page.getByRole("button", { name: "执行工具" }).click();

  await expect(page.getByText(/^根据你的知识库记忆，P0 readiness knowledge entry/)).toBeVisible();
  await expect(page.getByText(/工具详情：searchKnowledge/)).toBeVisible();
});
