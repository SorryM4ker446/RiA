import { generateText, Output, type ToolSet } from "ai";
import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";
import { resolveModelId } from "@/config/model";
import { getChatModel } from "@/lib/ai/client";
import { logToolExecution } from "@/lib/server/tool-log";
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

type ToolBudgetExceededContext = {
  input: unknown;
  remainingResultBudget: number;
};

type ToolPrepareInputContext<Input> = {
  userId: string;
  input: Input;
  modelId?: string;
  trigger: ToolTriggerType;
  remainingResultBudget?: number;
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
    examples?: string[];
    resultBudget?: {
      inputKey: string;
      maxPerTurn: number;
    };
  };
  inputSchema: z.ZodType<Input>;
  prepareInput?: (context: ToolPrepareInputContext<Input>) => Promise<Input> | Input;
  buildBudgetExceededOutput?: (context: ToolBudgetExceededContext) => Output;
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
    examples?: string[];
    resultBudget?: {
      inputKey: string;
      maxPerTurn: number;
    };
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

function buildWebSearchFallbackText(result: Awaited<ReturnType<typeof runWebSearch>>): string {
  const count = Array.isArray(result.results) ? result.results.length : 0;
  if (count === 0) {
    return `已执行 Web Search，但暂未返回可用结果：${result.query}`;
  }
  const references = result.results
    .slice(0, 5)
    .map((item, index) => `${index + 1}. [${item.title}](${item.url})${item.snippet ? `：${item.snippet}` : ""}`)
    .join("\n");

  return [`已完成 Web Search，返回 ${count} 条结果。`, "", "可在下方展开查看搜索来源。", references].join("\n");
}

async function resolveWebSearchInput(params: {
  input: z.infer<typeof webSearchInput>;
  modelId?: string;
  trigger: ToolTriggerType;
  maxResultsLimit?: number;
}): Promise<z.infer<typeof webSearchInput>> {
  if (typeof params.input.maxResults === "number") {
    return params.input;
  }

  const maxResultsLimit =
    typeof params.maxResultsLimit === "number" && Number.isFinite(params.maxResultsLimit)
      ? Math.max(1, Math.min(10, Math.trunc(params.maxResultsLimit)))
      : 10;

  try {
    const { output } = await generateText({
      model: getChatModel(resolveModelId(params.modelId)),
      output: Output.object({
        schema: z.object({
          maxResults: z.number().int().min(1).max(maxResultsLimit),
        }),
      }),
      system: [
        "You choose how many web search results to retrieve before answering.",
        `Return only a valid integer in maxResults from 1 to ${maxResultsLimit}.`,
        "Use 1-3 for narrow factual lookups, 4-6 for normal questions, 7-10 for comparisons, reviews, recommendations, or fast-changing topics that need source diversity.",
        "Balance answer quality with latency and cost.",
      ].join(" "),
      prompt: [
        `Trigger: ${params.trigger}`,
        `User search query: ${params.input.query}`,
        "",
        "Decide maxResults for this web search.",
      ].join("\n"),
    });

    return {
      ...params.input,
      maxResults: output.maxResults,
    };
  } catch (error) {
    console.warn("webSearch result-count planning failed", error);
    return {
      ...params.input,
      maxResults: Math.min(5, maxResultsLimit),
    };
  }
}

async function buildWebSearchAssistantText(params: {
  result: Awaited<ReturnType<typeof runWebSearch>>;
  modelId?: string;
}): Promise<string> {
  const { result, modelId } = params;
  const count = Array.isArray(result.results) ? result.results.length : 0;
  if (count === 0) {
    return buildWebSearchFallbackText(result);
  }

  const references = result.results.slice(0, 5).map((item, index) => ({
    index: index + 1,
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    score: item.score,
    source: item.source,
  }));

  try {
    const answer = await generateText({
      model: getChatModel(resolveModelId(modelId)),
      system:
        "你是一个严谨的中文研究助手。你会基于 Web Search 结果回答用户问题，先综合判断，再给出清晰结论。必须区分搜索事实和你的推理，不能编造来源没有的信息。",
      prompt: [
        `用户问题：${result.query}`,
        "",
        "Web Search 结果（按相关性排序）：",
        JSON.stringify(references, null, 2),
        "",
        "请用中文输出：",
        "1. 直接结论或建议；",
        "2. 搜索结果中的关键依据，引用格式使用 [1]、[2]；",
        "3. 你的综合推理与不确定性；",
        "4. 不要在正文末尾单独列出来源清单，来源会由界面根据工具结果单独折叠展示。",
      ].join("\n"),
    });

    const text = answer.text.trim();
    if (text) return text;
  } catch (error) {
    console.warn("webSearch synthesis failed", error);
  }

  return buildWebSearchFallbackText(result);
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
      examples: [
        "查一下我的知识库里有没有这方面记录",
        "从已有知识里找一下这个关键词",
        "检索项目资料并总结",
      ],
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
      examples: [
        "帮我创建一个待办",
        "把这件事加入任务",
        "记录一个明天要做的任务",
      ],
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
      fields: [
        {
          key: "maxResults",
          label: "结果数（可空）",
          type: "number",
          min: 1,
          max: 10,
          step: 1,
          placeholder: "留空由模型决定",
        },
      ],
    },
    auto: {
      enabled: true,
      intentHint: "当用户明确要求联网、搜索、查询最新信息、外部事实、网页来源、链接或实时资料时使用。",
      resultBudget: {
        inputKey: "maxResults",
        maxPerTurn: 10,
      },
      examples: [
        "联网搜索并评价这个游戏",
        "帮我查一下最新消息",
        "找几个外部来源对比一下",
        "搜索网页资料并给我结论",
      ],
    },
    inputSchema: webSearchInput,
    prepareInput: ({ input, modelId, trigger, remainingResultBudget }) =>
      resolveWebSearchInput({
        input,
        modelId,
        trigger,
        maxResultsLimit: remainingResultBudget,
      }),
    buildBudgetExceededOutput: ({ input }) => {
      const query =
        input && typeof input === "object" && "query" in input && typeof input.query === "string"
          ? input.query
          : "";

      return {
        query,
        results: [],
      };
    },
    execute: async ({ input }) => runWebSearch(input),
    buildAssistantText: ({ output, modelId }) =>
      buildWebSearchAssistantText({
        result: output,
        modelId,
      }),
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

function capNumericInputValue(input: unknown, key: string, maxValue: number): unknown {
  if (!input || typeof input !== "object" || !Number.isFinite(maxValue)) {
    return input;
  }

  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= maxValue) {
    return input;
  }

  return {
    ...(input as Record<string, unknown>),
    [key]: Math.max(0, Math.trunc(maxValue)),
  };
}

function readNumericInputValue(input: unknown, key: string): number | null {
  if (!input || typeof input !== "object" || !(key in input)) {
    return null;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createChatToolSet(userId: string, options?: { modelId?: string; toolIds?: string[] }): ToolSet {
  const allowed = new Set(options?.toolIds ?? []);
  const hasRestriction = allowed.size > 0;
  const resultBudgetUsed = new Map<string, number>();
  const descriptors = listToolDescriptors("chat").filter((tool) =>
    hasRestriction ? allowed.has(tool.id) : true,
  );

  const entries = descriptors.map((tool) => [
    tool.id,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (input: unknown) => {
        const startedAt = Date.now();
        try {
          const budget = tool.auto.resultBudget;
          const usedBudget = resultBudgetUsed.get(tool.id) ?? 0;
          const remainingResultBudget = budget ? budget.maxPerTurn - usedBudget : undefined;
          if (budget && typeof remainingResultBudget === "number" && remainingResultBudget <= 0) {
            if (tool.buildBudgetExceededOutput) {
              const output = tool.buildBudgetExceededOutput({
                input,
                remainingResultBudget: 0,
              });

              logToolExecution({
                toolId: tool.id,
                trigger: "auto",
                state: "output-available",
                durationMs: Date.now() - startedAt,
                userId,
              });

              return output;
            }

            throw new ApiError({
              code: "VALIDATION_ERROR",
              message: `Tool ${tool.id} exceeded the per-turn result budget.`,
              details: {
                inputKey: budget.inputKey,
                maxPerTurn: budget.maxPerTurn,
                used: usedBudget,
                remaining: 0,
              },
            });
          }

          const cappedInput =
            budget && typeof remainingResultBudget === "number"
              ? capNumericInputValue(input, budget.inputKey, remainingResultBudget)
              : input;
          const parsedInput = tool.inputSchema.safeParse(cappedInput);
          if (!parsedInput.success) {
            throw new ApiError({
              code: "VALIDATION_ERROR",
              message: `Invalid ${tool.id} tool input`,
              details: parsedInput.error.flatten(),
            });
          }

          const preparedInput = tool.prepareInput
            ? await tool.prepareInput({
                userId,
                input: parsedInput.data,
                modelId: options?.modelId,
                trigger: "auto",
                remainingResultBudget,
              })
            : parsedInput.data;
          const preparedParsedInput = tool.inputSchema.safeParse(preparedInput);
          if (!preparedParsedInput.success) {
            throw new ApiError({
              code: "VALIDATION_ERROR",
              message: `Invalid ${tool.id} tool input`,
              details: preparedParsedInput.error.flatten(),
            });
          }

          if (budget) {
            const requestedBudget = readNumericInputValue(preparedParsedInput.data, budget.inputKey);
            if (requestedBudget === null) {
              throw new ApiError({
                code: "VALIDATION_ERROR",
                message: `Tool ${tool.id} did not provide required budget field: ${budget.inputKey}`,
                details: {
                  inputKey: budget.inputKey,
                  maxPerTurn: budget.maxPerTurn,
                  used: usedBudget,
                  remaining: remainingResultBudget,
                },
              });
            }

            if (typeof remainingResultBudget === "number" && requestedBudget > remainingResultBudget) {
              throw new ApiError({
                code: "VALIDATION_ERROR",
                message: `Tool ${tool.id} exceeded the per-turn result budget.`,
                details: {
                  inputKey: budget.inputKey,
                  requested: requestedBudget,
                  maxPerTurn: budget.maxPerTurn,
                  used: usedBudget,
                  remaining: remainingResultBudget,
                },
              });
            }

            resultBudgetUsed.set(tool.id, usedBudget + requestedBudget);
          }

          const output = await tool.execute({
            userId,
            input: preparedParsedInput.data,
            modelId: options?.modelId,
            trigger: "auto",
          });
          const requestId =
            output && typeof output === "object" && "requestId" in output && typeof output.requestId === "string"
              ? output.requestId
              : undefined;

          logToolExecution({
            toolId: tool.id,
            trigger: "auto",
            state: "output-available",
            durationMs: Date.now() - startedAt,
            userId,
            requestId,
          });

          return output;
        } catch (error) {
          logToolExecution({
            toolId: tool.id,
            trigger: "auto",
            state: "output-error",
            durationMs: Date.now() - startedAt,
            userId,
            errorCode: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
          });
          throw error;
        }
      },
    },
  ]);

  return Object.fromEntries(entries);
}
