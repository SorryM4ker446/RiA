import { generateText } from "ai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveModelId } from "@/config/model";
import { getChatModel } from "@/lib/ai/client";
import { truncateTitle } from "@/lib/ai/ui-message";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import { saveMemory } from "@/lib/memory/store";
import { createTask, createTaskInputSchema } from "@/tools/definitions/create-task";
import { searchKnowledge, searchKnowledgeInputSchema } from "@/tools/definitions/search-knowledge";
import { runWebSearch, webSearchInput } from "@/tools/definitions/web-search";

type ToolExecutionContext<Input> = {
  userId: string;
  input: Input;
  modelId?: string;
};

type ToolAssistantTextContext<Input, Output> = {
  input: Input;
  output: Output;
  modelId?: string;
};

type ManualToolDescriptor<Input = unknown, Output = unknown> = {
  inputSchema: z.ZodType<Input>;
  execute: (context: ToolExecutionContext<Input>) => Promise<Output>;
  buildAssistantText?: (context: ToolAssistantTextContext<Input, Output>) => Promise<string> | string;
  deriveMemorySeed?: (input: Input) => string;
};

const runToolSchema = z.object({
  tool: z.string().min(1),
  input: z.unknown(),
  modelId: z.string().optional(),
  mode: z.literal("chat"),
});

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
    // Fall back to deterministic summary when synthesis fails.
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

function stringifyForMemory(value: unknown, maxLength = 1600): string {
  let text = "";

  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "empty";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function inferMemorySeed(input: unknown, fallback: string): string {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (input && typeof input === "object") {
    const candidateKeys = [
      "query",
      "title",
      "task",
      "prompt",
      "keyword",
      "keywords",
      "topic",
      "name",
      "content",
      "text",
      "url",
    ];

    for (const key of candidateKeys) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return fallback;
}

function buildGenericAssistantText(tool: string, output: unknown): string {
  if (output && typeof output === "object") {
    const maybeMessage = (output as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) {
      return maybeMessage.trim();
    }
  }
  return `已完成工具「${tool}」调用。`;
}

async function persistManualToolMemory(params: {
  userId: string;
  tool: string;
  input: unknown;
  output: unknown;
  assistantText: string;
  memorySeed?: string;
}) {
  const timestamp = new Date().toISOString();
  const seed = truncateTitle(
    inferMemorySeed(params.memorySeed ?? params.input, params.tool),
    40,
  );
  const normalizedSeed = seed || params.tool;

  const inputMemory = [
    `time=${timestamp}`,
    "type=manual-tool-input",
    `tool=${params.tool}`,
    `payload=${stringifyForMemory(params.input)}`,
  ].join("\n");

  const outputMemory = [
    `time=${timestamp}`,
    "type=manual-tool-output",
    `tool=${params.tool}`,
    `assistant=${stringifyForMemory(params.assistantText, 800)}`,
    `payload=${stringifyForMemory(params.output)}`,
  ].join("\n");

  await Promise.allSettled([
    saveMemory({
      userId: params.userId,
      key: truncateTitle(`tool:${params.tool}:input:${normalizedSeed}`, 60),
      value: inputMemory,
      score: 0.45,
    }),
    saveMemory({
      userId: params.userId,
      key: truncateTitle(`tool:${params.tool}:output:${normalizedSeed}`, 60),
      value: outputMemory,
      score: 0.5,
    }),
  ]);
}

const MANUAL_TOOL_CATALOG: Record<string, ManualToolDescriptor<any, any>> = {
  searchKnowledge: {
    inputSchema: searchKnowledgeInputSchema,
    execute: async ({ userId, input }: ToolExecutionContext<z.infer<typeof searchKnowledgeInputSchema>>) =>
      searchKnowledge(userId, input),
    buildAssistantText: async ({ output, modelId }) => buildSearchAssistantText({ result: output, modelId }),
    deriveMemorySeed: (input: z.infer<typeof searchKnowledgeInputSchema>) => input.query,
  },
  createTask: {
    inputSchema: createTaskInputSchema,
    execute: async ({ userId, input }: ToolExecutionContext<z.infer<typeof createTaskInputSchema>>) =>
      createTask(userId, input),
    buildAssistantText: ({ output }) => buildCreateTaskAssistantText(output),
    deriveMemorySeed: (input: z.infer<typeof createTaskInputSchema>) => input.title,
  },
  webSearch: {
    inputSchema: webSearchInput,
    execute: async ({ input }: ToolExecutionContext<z.infer<typeof webSearchInput>>) => runWebSearch(input),
    buildAssistantText: ({ output }) => buildWebSearchAssistantText(output),
    deriveMemorySeed: (input: z.infer<typeof webSearchInput>) => input.query,
  },
};

export async function POST(req: NextRequest) {
  try {
    const user = await getOrCreateRequestUser(req);
    const parsed = runToolSchema.safeParse(await req.json());

    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid tool request",
          details: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const tool = parsed.data.tool.trim();
    const descriptor = MANUAL_TOOL_CATALOG[tool as keyof typeof MANUAL_TOOL_CATALOG];
    if (!descriptor) {
      return Response.json(
        {
          error: `Unsupported tool: ${tool}`,
          supportedTools: Object.keys(MANUAL_TOOL_CATALOG),
        },
        { status: 400 },
      );
    }

    const parsedInput = descriptor.inputSchema.safeParse(parsed.data.input);
    if (!parsedInput.success) {
      return Response.json(
        {
          error: "Invalid tool input",
          details: parsedInput.error.flatten(),
        },
        { status: 400 },
      );
    }

    const data = await descriptor.execute({
      userId: user.id,
      input: parsedInput.data,
      modelId: parsed.data.modelId,
    });

    const assistantText = descriptor.buildAssistantText
      ? await descriptor.buildAssistantText({
          input: parsedInput.data,
          output: data,
          modelId: parsed.data.modelId,
        })
      : buildGenericAssistantText(tool, data);

    try {
      await persistManualToolMemory({
        userId: user.id,
        tool,
        input: parsedInput.data,
        output: data,
        assistantText,
        memorySeed: descriptor.deriveMemorySeed?.(parsedInput.data),
      });
    } catch (memoryError) {
      console.warn("tools.run memory.persist warning", memoryError);
    }

    return Response.json({
      tool,
      data,
      assistantText,
    });
  } catch (error) {
    console.error("/api/tools/run POST error", error);
    return Response.json({ error: "Failed to run tool" }, { status: 500 });
  }
}
