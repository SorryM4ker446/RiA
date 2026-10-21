import type { UIMessage } from "ai";
import { historicalText } from "@/lib/chat/context";
import { decodePersistedUserMessage, decodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { decodeMediaMessage } from "@/lib/media/message-codec";
import { db } from "@/db";
import { preferredModel } from "@/lib/models/preferences";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { summarizeTaskState, TASK_STATE_VERSION } from "./task-summary";
import { t } from "@/lib/locale";

/**
 * Compression for long conversations.
 *
 * The summary is written by the model, is stored against the message it covers,
 * and never replaces the messages: what the reader sees is still the original
 * text. The point is that the model stops being handed the same forty turns
 * every time, not that the history is thrown away.
 *
 * When no summary can be produced — no chat model, a failure, a refusal — the
 * caller keeps the bounded excerpts it already had. That fallback is not a
 * degraded mode to apologise for; it is what the excerpts are for.
 */

export type SummaryResult = { summary: string; upToMessageId: string; modelId: string } | null;

/** Turns are summarized once there are more of them than a window keeps. */
export const SUMMARY_TRIGGER_MESSAGES = 40;

export async function summarizeOlderTurns(params: {
  chatId: string;
  messages: { id: string; role: string; text: string }[];
  keepRecent: number;
  signal?: AbortSignal;
  force?: boolean;
  modelRef?: ModelRef;
}): Promise<SummaryResult> {
  const older = params.messages.slice(0, Math.max(0, params.messages.length - params.keepRecent));
  const lastCovered = older.at(-1);
  if ((!params.force && older.length < SUMMARY_TRIGGER_MESSAGES / 2) || !lastCovered) return null;
  // Read stored evidence, not a potentially stale browser transcript. Client
  // message identities are resolved alongside persisted identities.
  const snapshot = await db.$transaction(async tx => {
    const chat = await tx.chat.findUnique({ where: { id: params.chatId } });
    if (!chat) return null;
    const ids = older.map(message => message.id);
    const rows = await tx.message.findMany({ where: { chatId: chat.id, OR: [{ id: { in: ids } }, { clientMessageId: { in: ids } }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const covered = rows.find(row => row.id === lastCovered.id || row.clientMessageId === lastCovered.id);
    if (rows.length !== older.length || !covered || rows.at(-1)?.id !== covered.id) return null;
    const previousCovered = chat.summary && chat.summaryRevision === chat.historyRevision && chat.summaryUpToMessageId
      ? await tx.message.findFirst({ where: { id: chat.summaryUpToMessageId, chatId: chat.id } }) : null;
    const compare = (a: typeof covered, b: typeof covered) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (previousCovered && compare(previousCovered, covered) > 0) return null;
    const incremental = Boolean(previousCovered && chat.summary?.startsWith(TASK_STATE_VERSION));
    // The browser may only have a recent page. Cover every intervening stored
    // message, rather than silently skipping the gap after the last summary.
    const evidence = await tx.message.findMany({
      where: { chatId: chat.id, AND: [
        { OR: [{ createdAt: { lt: covered.createdAt } }, { createdAt: covered.createdAt, id: { lte: covered.id } }] },
        ...(incremental && previousCovered ? [{ OR: [{ createdAt: { gt: previousCovered.createdAt } }, { createdAt: previousCovered.createdAt, id: { gt: previousCovered.id } }] }] : []),
      ] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return { chat, rows: evidence, covered, incremental, hasPrevious: Boolean(previousCovered) };
  });
  if (!snapshot) return null;
  const existing = snapshot.chat;
  if (existing.summary && existing.summaryRevision === existing.historyRevision && existing.summaryUpToMessageId === snapshot.covered.id) {
    return { summary: existing.summary, upToMessageId: snapshot.covered.id, modelId: existing.summaryModelId?.split(":").slice(1).join(":") ?? "" };
  }

  const chosen = params.modelRef ?? await preferredModel("chat").catch(() => null);
  if (!chosen) return null;
  // Existing cached summaries remain readable. When coverage grows, rebuild an
  // older format from original evidence instead of treating it as the new task state.
  const previous = snapshot.hasPrevious ? existing.summary! : "";
  const delta = snapshot.rows;

  try {
    const summary = await summarizeTaskState({ modelRef: chosen, previous, records: delta.map(message => `${message.role}: ${summaryText(message)}`), signal: params.signal });
    if (!summary) return null;
    params.signal?.throwIfAborted();
    const saved = await db.chat.updateMany({
      where: { id: params.chatId, historyRevision: existing.historyRevision,
        summaryUpToMessageId: existing.summaryUpToMessageId, summaryRevision: existing.summaryRevision, summary: existing.summary },
      data: { summary, summaryUpToMessageId: snapshot.covered.id, summaryModelId: `${chosen.providerId}:${chosen.modelId}`, summaryRevision: existing.historyRevision },
    });
    if (!saved.count) return null;
    return { summary, upToMessageId: snapshot.covered.id, modelId: chosen.modelId };
  } catch {
    params.signal?.throwIfAborted();
    // A summary is an optimisation. Failing to produce one leaves the excerpts
    // in place, which is why the excerpts are still built.
    return null;
  }
}

/**
 * What the summary covers, said plainly. The number is the count of turns that
 * were folded in, and the message id is what a reader would look for to find
 * them again.
 */
export function describeSummaryCoverage(params: { upToMessageId: string | null }) {
  return params.upToMessageId ? t("chat.summary.coverage") : t("chat.summary.none");
}

function summaryText(message: { id: string; role: string; content: string }) {
  const user = decodePersistedUserMessage(message.content);
  if (user) return [user.text, ...user.files.map(file => `[attachment: ${file.filename ?? file.mediaType}]`)].join("\n");
  const assistant = decodePersistedAssistantToolMessage(message.content);
  // Every tool call is kept, each in the bounded result-first record form the
  // in-stream compactor uses; the summarizer batches long records itself.
  if (assistant) return historicalText({ id: message.id, role: "assistant", parts: [
    { type: "text", text: assistant.text },
    ...assistant.tools.map(tool => ({ type: `tool-${tool.toolName}`, toolCallId: tool.toolCallId, state: tool.state,
      input: tool.input, output: tool.output, errorText: tool.errorText,
    })),
  ] as UIMessage["parts"] });
  const media = decodeMediaMessage(message.content);
  return media ? media.text : message.content;
}
