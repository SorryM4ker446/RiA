export type ToolMemoryPresentation = {
  title: string;
  toolLabel: string;
  summary: string;
  excerpt: string;
};

const toolLabels: Record<string, string> = {
  webSearch: "联网搜索",
  searchKnowledge: "知识检索",
  createTask: "任务记录",
};
const fieldNames = new Set(["version", "tool", "trigger", "time", "fingerprint", "quality", "summary", "tags", "assistant"]);

/** Recognize the stored tool-memory envelope without rewriting its contents. */
export function presentToolMemory(key: string, value: string): ToolMemoryPresentation | null {
  const identity = /^tool:([a-zA-Z][\w-]*):(.+)$/.exec(key);
  if (!identity || !value.startsWith("version=tool-memory-v1\n") && !value.startsWith("version=tool-memory-v1\r\n")) return null;
  const fields = new Map<string, string>();
  let current = "";
  for (const line of value.split(/\r?\n/)) {
    const match = /^([a-zA-Z]\w*)=(.*)$/.exec(line);
    if (match) {
      if (!fieldNames.has(match[1]) || fields.has(match[1])) return null;
      current = match[1]; fields.set(current, match[2]);
    } else if (current === "summary" || current === "assistant") {
      fields.set(current, `${fields.get(current)}\n${line}`);
    } else return null;
  }
  const summary = fields.get("summary")?.trim();
  const time = fields.get("time"); const quality = fields.get("quality");
  if (fields.get("version") !== "tool-memory-v1" || fields.get("tool") !== identity[1] || !summary
    || !["auto", "manual"].includes(fields.get("trigger") ?? "")
    || !time || !Number.isFinite(new Date(time).getTime())
    || !fields.get("fingerprint")?.match(/^[a-f0-9]+$/i)
    || !quality?.trim() || !Number.isFinite(Number(quality)) || Number(quality) < 0 || Number(quality) > 1) return null;
  const query = /「([^」\n]+)」/.exec(summary)?.[1];
  return {
    title: query || identity[2].replace(/-/g, " "),
    toolLabel: toolLabels[identity[1]] ?? "工具记录",
    summary,
    excerpt: fields.get("assistant")?.trim() ?? "",
  };
}
