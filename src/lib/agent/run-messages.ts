import { db } from "@/db";
import { decodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";

/** Resolve only explicit run links or an unambiguous legacy request window. */
export async function resolveRunMessage(chatId: string, run: { id: string; startedAt: Date }) {
  const candidates = await db.message.findMany({
    where: { chatId, role: "assistant", content: { contains: run.id } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
  });
  const explicit = candidates.find(message => {
    const payload = decodePersistedAssistantToolMessage(message.content);
    return payload?.runId === run.id || payload?.runIds?.includes(run.id);
  });
  if (explicit) return explicit;

  const question = await db.message.findFirst({ where: { chatId, role: "user", createdAt: { lte: run.startedAt } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!question) return null;
  // Tied user timestamps cannot identify a unique historical request.
  if (await db.message.count({ where: { chatId, role: "user", createdAt: question.createdAt } }) !== 1) return null;
  const next = await db.message.findFirst({ where: { chatId, role: "user", createdAt: { gt: question.createdAt } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const window = { gte: question.createdAt, ...(next ? { lt: next.createdAt } : {}) };
  const [count, replies] = await Promise.all([
    db.agentRun.count({ where: { chatId, startedAt: window } }),
    db.message.findMany({ where: { chatId, role: "assistant", createdAt: window }, take: 2 }),
  ]);
  if (count !== 1 || replies.length !== 1) return null;
  const payload = decodePersistedAssistantToolMessage(replies[0].content);
  if (!payload || payload.runId || payload.runIds?.length) return null;
  return replies[0];
}
