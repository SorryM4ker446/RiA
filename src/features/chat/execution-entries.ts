import { t } from "@/lib/locale";
import type { UIMessage } from "ai";
import type { RunView } from "@/lib/agent/runs";
import { isToolPart, readText } from "./page-utils";

export function executionEntries(runs: RunView[], messages: UIMessage[]) {
  const assistants = messages.filter(message => message.role === "assistant");
  const byRun = new Map<string, UIMessage>();
  const byMessage = new Map(assistants.map(message => [message.id, message]));
  const goals = new Map<string, string>();
  let question = "";
  for (const message of messages) {
    if (message.role === "user") question = readText(message);
    if (message.role !== "assistant") continue;
    goals.set(message.id, question || readText(message) || t("ui.chat.execution-entries.toolAndSourceDetails"));
    const metadata = message.metadata as { runId?: string; runIds?: string[] } | undefined;
    for (const id of [...(metadata?.runIds ?? []), ...(metadata?.runId ? [metadata.runId] : [])]) byRun.set(id, message);
  }
  type Entry = { key: string; run?: RunView; message?: UIMessage; messageId?: string; goal: string; stages: number };
  const entries: Entry[] = [];
  const grouped = new Map<string, Entry>();
  const attached = new Set<string>();
  for (const run of [...runs].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))) {
    const message = byRun.get(run.id) ?? (run.messageId ? byMessage.get(run.messageId) : undefined);
    const messageId = message?.id ?? run.messageId;
    const key = messageId ? `message:${messageId}` : run.id;
    if (messageId) attached.add(messageId);
    const entry = grouped.get(key);
    if (entry?.run) {
      entry.run = { ...entry.run, steps: [...run.steps, ...entry.run.steps] };
      entry.stages++;
    } else {
      const next = { key, run, message, messageId, goal: run.goal, stages: 1 };
      grouped.set(key, next);
      entries.push(next);
    }
  }
  for (const message of [...assistants].reverse()) {
    if (attached.has(message.id) || !(message.parts.some(isToolPart) || Boolean(message.metadata))) continue;
    entries.push({ key: `message:${message.id}`, message, messageId: message.id, goal: goals.get(message.id)!, stages: 0 });
  }
  return entries;
}
