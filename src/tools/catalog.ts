import { generateText, type ToolSet } from "ai";
import { z } from "zod";
import { resolveModelId } from "@/config/model";
import { getChatModel } from "@/lib/ai/client";
import { createTask, createTaskInputSchema } from "@/tools/definitions/create-task";
import { searchKnowledge, searchKnowledgeInputSchema } from "@/tools/definitions/search-knowledge";
import { runWebSearch, webSearchInput } from "@/tools/definitions/web-search";

export type ToolMode = "chat" | "image" | "video";
export type ToolTriggerType = "manual" | "auto";
export type ToolExecutionState = "output-available" | "output-error";

type ToolExecutionContext<Input> = {
  userId: string;
  input: Input;
  modelId?: string;
  trigger: ToolTriggerType;
};

type ToolAssistantTextContext<Input, Output> = {
  input: Input;
  output: Output;
  modelId?: string;
  trigger: ToolTriggerType;
};

export type ToolMemoryDraft = {
  seed: string;
  summary: string;
  quality: number;
  score: number;
  tags?: string[];
};

type ToolMemoryContext<Input, Output> = {
  input: Input;
  output: Output;
  assistantText: string;
  trigger: ToolTriggerType;
  modelId?: string;
};

export type ManualFieldMeta = {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "datetime-local";
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{
    label: string;
    value: string;
  }>;
};

export type ManualToolMeta = {
  enabled: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  primaryFieldKey: string;
  primaryFieldLabel: string;
  fields: ManualFieldMeta[];
};

export type ToolMemoryPolicy<Input, Output> = {
  enabled: boolean;
  minQuality: number;
  summarize: (context: ToolMemoryContext<Input, Output>) => ToolMemoryDraft | null;
};

type ToolDescriptor<Input = unknown, Output = unknown> = {
  id: string;
  displayName: string;
  description: string;
  modeSupport: ToolMode[];
  manual: ManualToolMeta;
  auto: {
    enabled: boolean;
    intentHint: string;
  };
  inputSchema: z.ZodType<Input>;
  execute: (context: ToolExecutionContext<Input>) => Promise<Output>;
  buildAssistantText: (context: ToolAssistantTextContext<Input, Output>) => Promise<string> | string;
  memory: ToolMemoryPolicy<Input, Output>;
};

export type AnyToolDescriptor = ToolDescriptor<any, any>;

export type PublicToolCatalogItem = {
  id: string;
  displayName: string;
  description: string;
  modeSupport: ToolMode[];
  manual: ManualToolMeta;
  auto: {
    enabled: boolean;
    intentHint: string;
  };
};

function buildSearchFallbackText(result: Awaited<ReturnType<typeof searchKnowledge>>): string {
  if (result.total === 0 || result.results.length === 0) {
    return `我在当前知识库里没有找到和“${result.query}”直接相关的内容。`;
  }

  const top = result.results[0];
  const sourceLabel = top.source === "memory" ? "根据你的知识库记忆" : "根据内置知识";
  return `${sourceLabel}，${top.snippet}`;
}

async function buildSearchAssistantText(params: {
  result: Awaited<ReturnType<typeof searchKnowledge>>;
  modelId?: string;
}): Promise<string> {
  const { result, modelId } = params;

  if (result.total === 0 || result.results.length === 0) {
    return buildSearchFallbackText(result);
  }

  const references = result.results.slice(0, 5).map((item, index) => ({
    index: index + 1,
    title: item.title,
    snippet: item.snippet,
    source: item.source,
    score: item.score,
  }));

  try {
    const answer = await generateText({
      model: getChatModel(resolveModelId(modelId)),
      system:
        "你是一个严谨的中文助手。先基于给定知识库事实，再结合常识推理给出综合回答。不要编造知识库没有的信息；若证据不足请明确说明。",
      prompt: [
        `用户问题：${result.query}`,
        "",
        "知识库检索结果（按相关性排序）：",
        JSON.stringify(references, null, 2),
        "",
        "请输出：1) 结论；2) 基于知识库的依据；3) 结合你的推理补充（若有不确定请标注）。",
      ].join("\n"),
    });

    const text = answer.text.trim();
    if (text) return text;
  } catch {
    // Fallback to deterministic summary when synthesis fails.
  }

  return buildSearchFallbackText(result);
}

function buildCreateTaskAssistantText(result: Awaited<ReturnType<typeof createTask>>): string {
  const due = result.dueDate ? `，截止时间 ${new Date(result.dueDate).toLocaleString("zh-CN")}` : "";
  return `已创建任务「${result.title}」${due}，当前状态为 ${result.status}。`;
}

function buildWebSearchAssistantText(result: Awaited<ReturnType<typeof runWebSearch>>): string {
  const count = Array.isArray(result.results) ? result.results.length : 0;
  if (count === 0) {
    return `已执行 Web Search，但暂未返回可用结果：${result.query}`;
  }
  return `已完成 Web Search，返回 ${count} 条结果。`;
}

const TOOL_CATALOG: Record<string, AnyToolDescriptor> = {
  searchKnowledge: {
    id: "searchKnowledge",
    displayName: "知识检索",
    description: "检索项目知识库（memory + 内置知识）并返回可引用结果。",
    modeSupport: ["chat"],
    manual: {
      enabled: true,
      label: "手动：知识检索",
      placeholder: "输入要检索的关键词...（Enter 手动触发）",
      submitLabel: "执行工具",
      primaryFieldKey: "query",
      primaryFieldLabel: "检索词",
      fields: [
        {
          key: "topK",
          label: "topK",
          type: "number",
          min: 1,
          max: 8,
          step: 1,
          defaultValue: "4",
        },
      ],
    },
    auto: {
      enabled: true,
      intentHint: "当用户明确要求检索项目知识/资料/信息时使用。",
    },
    inputSchema: searchKnowledgeInputSchema,
    execute: async ({ userId, input }) => searchKnowledge(userId, input),
    buildAssistantText: async ({ output, modelId }) =>
      buildSearchAssistantText({
        result: output,
        modelId,
      }),
    memory: {
      enabled: true,
      minQuality: 0.25,
      summarize: ({ input, output }) => {
        const result = output as Awaited<ReturnType<typeof searchKnowledge>>;
        if (!result.results.length) return null;
        const best = result.results[0];
        if ((best.score ?? 0) < 0.18) return null;

        const summary =
          result.results.length === 1
            ? `查询「${input.query}」命中 1 条：${best.title}（${best.source}）`
            : `查询「${input.query}」命中 ${result.total} 条，首条为 ${best.title}（${best.source}）`;

        return {
          seed: input.query,
          summary,
          quality: Math.max(0.2, Math.min(1, best.score ?? 0)),
          score: 0.55 + Math.min(0.35, (best.score ?? 0) * 0.3),
          tags: ["knowledge", `source:${best.source}`],
        };
      },
    },
  },
  createTask: {
    id: "createTask",
    displayName: "创建任务",
    description: "为当前用户创建任务，支持详情、优先级和截止时间。",
    modeSupport: ["chat"],
    manual: {
      enabled: true,
      label: "手动：创建任务",
      placeholder: "输入任务标题...（Enter 手动触发）",
      submitLabel: "执行工具",
      primaryFieldKey: "title",
      primaryFieldLabel: "任务标题",
      fields: [
        {
          key: "details",
          label: "任务详情",
          type: "text",
          placeholder: "任务详情（可选）",
        },
        {
          key: "priority",
          label: "优先级",
          type: "select",
          defaultValue: "medium",
          options: [
            { label: "low", value: "low" },
            { label: "medium", value: "medium" },
            { label: "high", value: "high" },
          ],
        },
        {
          key: "dueDate",
          label: "截止时间",
          type: "datetime-local",
        },
      ],
    },
    auto: {
      enabled: true,
      intentHint: "当用户明确要求创建任务、待办或提醒事项时使用。",
    },
    inputSchema: createTaskInputSchema,
    execute: async ({ userId, input }) => createTask(userId, input),
    buildAssistantText: ({ output }) => buildCreateTaskAssistantText(output),
    memory: {
      enabled: true,
      minQuality: 0.5,
      summarize: ({ output }) => {
        const result = output as Awaited<ReturnType<typeof createTask>>;
        if (!result.taskId) return null;

        const summary = [
          `任务「${result.title}」已创建`,
          `status=${result.status}`,
          `priority=${result.priority}`,
          result.dueDate ? `due=${result.dueDate}` : "due=none",
        ].join("，");

        return {
          seed: result.taskId,
          summary,
          quality: 0.95,
          score: 0.9,
          tags: ["task", `status:${result.status}`, `priority:${result.priority}`],
        };
      },
    },
  },
  webSearch: {
    id: "webSearch",
    displayName: "Web Search",
    description: "通过网络搜索获取外部信息。",
    modeSupport: ["chat"],
    manual: {
      enabled: true,
      label: "手动：Web 搜索",
      placeholder: "输入要搜索的关键词...（Enter 手动触发）",
      submitLabel: "执行工具",
      primaryFieldKey: "query",
      primaryFieldLabel: "搜索词",
      fields: [],
    },
    auto: {
      enabled: false,
      intentHint: "一期自动语义触发暂不启用 webSearch。",
    },
    inputSchema: webSearchInput,
    execute: async ({ input }) => runWebSearch(input),
    buildAssistantText: ({ output }) => buildWebSearchAssistantText(output),
    memory: {
      enabled: true,
      minQuality: 0.4,
      summarize: ({ input, output }) => {
        const result = output as Awaited<ReturnType<typeof runWebSearch>>;
        const count = Array.isArray(result.results) ? result.results.length : 0;
        if (count <= 0) return null;

        return {
          seed: input.query,
          summary: `Web 搜索「${input.query}」返回 ${count} 条结果。`,
          quality: Math.min(0.9, 0.45 + count * 0.05),
          score: 0.6,
          tags: ["web-search"],
        };
      },
    },
  },
};

export function getToolDescriptor(toolId: string): AnyToolDescriptor | null {
  return TOOL_CATALOG[toolId] ?? null;
}

export function listToolDescriptors(mode?: ToolMode): AnyToolDescriptor[] {
  const tools = Object.values(TOOL_CATALOG);
  if (!mode) return tools;
  return tools.filter((tool) => tool.modeSupport.includes(mode));
}

export function listManualToolDescriptors(mode: ToolMode): AnyToolDescriptor[] {
  return listToolDescriptors(mode).filter((tool) => tool.manual.enabled);
}

export function listAutoToolDescriptors(mode: ToolMode): AnyToolDescriptor[] {
  return listToolDescriptors(mode).filter((tool) => tool.auto.enabled);
}

export function listPublicToolCatalog(mode?: ToolMode): PublicToolCatalogItem[] {
  return listToolDescriptors(mode).map((tool) => ({
    id: tool.id,
    displayName: tool.displayName,
    description: tool.description,
    modeSupport: tool.modeSupport,
    manual: tool.manual,
    auto: tool.auto,
  }));
}

export function isToolSupportedInMode(toolId: string, mode: ToolMode): boolean {
  const descriptor = getToolDescriptor(toolId);
  if (!descriptor) return false;
  return descriptor.modeSupport.includes(mode);
}

export function createChatToolSet(userId: string, options?: { toolIds?: string[] }): ToolSet {
  const allowed = new Set(options?.toolIds ?? []);
  const hasRestriction = allowed.size > 0;
  const descriptors = listToolDescriptors("chat").filter((tool) =>
    hasRestriction ? allowed.has(tool.id) : true,
  );

  const entries = descriptors.map((tool) => [
    tool.id,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (input: unknown) =>
        tool.execute({
          userId,
          input,
          trigger: "auto",
        }),
    },
  ]);

  return Object.fromEntries(entries);
}
