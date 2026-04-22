import { generateText } from "ai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveModelId } from "@/config/model";
import { getChatModel } from "@/lib/ai/client";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import { createTask, createTaskInputSchema } from "@/tools/definitions/create-task";
import { searchKnowledge, searchKnowledgeInputSchema } from "@/tools/definitions/search-knowledge";

const runToolSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("searchKnowledge"),
    input: searchKnowledgeInputSchema,
    modelId: z.string().optional(),
    mode: z.literal("chat"),
  }),
  z.object({
    tool: z.literal("createTask"),
    input: createTaskInputSchema,
    modelId: z.string().optional(),
    mode: z.literal("chat"),
  }),
]);

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

    if (parsed.data.tool === "searchKnowledge") {
      const data = await searchKnowledge(user.id, parsed.data.input);
      const assistantText = await buildSearchAssistantText({
        result: data,
        modelId: parsed.data.modelId,
      });
      return Response.json({
        tool: parsed.data.tool,
        data,
        assistantText,
      });
    }

    const data = await createTask(user.id, parsed.data.input);
    return Response.json({
      tool: parsed.data.tool,
      data,
      assistantText: buildCreateTaskAssistantText(data),
    });
  } catch (error) {
    console.error("/api/tools/run POST error", error);
    return Response.json({ error: "Failed to run tool" }, { status: 500 });
  }
}
