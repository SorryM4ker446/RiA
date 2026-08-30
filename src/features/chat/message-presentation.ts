import { UIMessage } from "ai";
import type { SearchSourceItem, TaskItem } from "@/features/chat/types";
import { documentSourceSchema, type DocumentSource } from "@/lib/documents/types";

export function getDocumentSources(message: UIMessage): DocumentSource[] {
  if (message.role !== "assistant") return [];
  const metadata = message.metadata as { documentSources?: unknown } | undefined;
  const candidates: unknown[] = Array.isArray(metadata?.documentSources) ? metadata.documentSources.slice(0, 8) : [];
  for (const part of message.parts) {
    if (part.type !== "tool-searchKnowledge" || part.state !== "output-available") continue;
    const output = part.output as { results?: { reference?: unknown }[] } | undefined;
    if (Array.isArray(output?.results)) candidates.push(...output.results.slice(0, 8).map(item => item?.reference));
  }
  return [...new Map(candidates.flatMap(source => {
    const result = documentSourceSchema.safeParse(source);
    return result.success ? [[result.data.chunkId, result.data] as const] : [];
  })).values()].slice(0, 8);
}

export function resolveMessageSourceTag(params: {
  role: UIMessage["role"];
  toolParts: Array<Extract<UIMessage["parts"][number], { type: `tool-${string}` }>>;
}): { label: string; variant: "outline" | "success" | "secondary" } | null {
  const { role, toolParts } = params;

  if (role === "system") {
    return { label: "来源：系统", variant: "secondary" };
  }

  if (role !== "assistant") {
    return null;
  }

  if (toolParts.length === 0) {
    return { label: "来源：上下文推理", variant: "outline" };
  }

  const toolNames = new Set(toolParts.map((part) => part.type.replace(/^tool-/, "")));
  if (toolNames.has("webSearch")) {
    return { label: "来源：搜索工具 + 模型推理", variant: "success" };
  }
  if (toolNames.has("searchKnowledge")) {
    return { label: "来源：知识库工具 + 模型推理", variant: "success" };
  }
  if (toolNames.has("createTask")) {
    return { label: "来源：任务工具结果", variant: "success" };
  }
  return { label: "来源：工具结果", variant: "success" };
}

export function formatTaskStatus(status: TaskItem["status"]): string {
  if (status === "todo") return "待处理";
  if (status === "in_progress") return "进行中";
  return "已完成";
}

export function formatTaskPriority(priority: TaskItem["priority"]): string {
  if (priority === "high") return "高";
  if (priority === "medium") return "中";
  return "低";
}

export function getWebSearchSources(
  toolParts: Array<Extract<UIMessage["parts"][number], { type: `tool-${string}` }>>,
): SearchSourceItem[] {
  return toolParts.flatMap((part) => {
    if (part.type !== "tool-webSearch" || part.state !== "output-available") {
      return [];
    }

    const output = "output" in part ? part.output : null;
    if (!output || typeof output !== "object" || !("results" in output) || !Array.isArray(output.results)) {
      return [];
    }

    return output.results
      .filter(
        (item): item is SearchSourceItem =>
          item &&
          typeof item === "object" &&
          "title" in item &&
          typeof item.title === "string" &&
          "url" in item &&
          typeof item.url === "string",
      )
      .map((item) => ({
        title: item.title,
        url: item.url,
        ...(typeof item.snippet === "string" ? { snippet: item.snippet } : {}),
        ...(typeof item.score === "number" || item.score === null ? { score: item.score } : {}),
      }));
  });
}
