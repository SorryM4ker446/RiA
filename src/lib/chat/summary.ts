import type { UIMessage } from "ai";
import { historicalText } from "@/lib/chat/context";
import { decodePersistedUserMessage, decodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { decodeMediaMessage } from "@/lib/media/message-codec";
import { db } from "@/db";
import { getModelPreferences, modelInLibrary, preferredModel } from "@/lib/models/preferences";
import { contextBudget } from "@/lib/models/context-budget";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";
import { summaryRecordCharacters } from "./tool-history";
import { IncompleteTaskSummary, summarizeWithInternalAgent, TASK_STATE_VERSION, type CompactionAllowance } from "./task-summary";
import { foldIntoState, readSummaryState, type RestoredContextSnapshot, type SummaryState } from "./compaction-state";
import { conversationWorkspace } from "@/lib/local-files/workspace";
import { t } from "@/lib/locale";
import { messageImages } from "@/lib/media/conversation-images";

type MessagePosition = { id: string; createdAt: Date };
const throughMessage = ({ id, createdAt }: MessagePosition) => ({ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lte: id } }] });
const afterMessage = ({ id, createdAt }: MessagePosition) => ({ OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }] });
const compareMessages = (a: MessagePosition, b: MessagePosition) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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
export type IncompleteSummary = {
  draft: string; historyRevision: number; previousSummary: string | null; previousBoundary: string | null;
  files: SummaryState["files"];
};
export type SummaryAttempt = SummaryResult | IncompleteSummary;

/** Turns are summarized once there are more of them than a window keeps. */
export const SUMMARY_TRIGGER_MESSAGES = 40;

export async function attemptOlderTurnSummary(params: {
  chatId: string;
  messages: readonly { id: string }[];
  keepRecent: number;
  signal?: AbortSignal;
  force?: boolean;
  modelRef?: ModelRef;
  allowPreviousModel?: boolean;
  allowance?: CompactionAllowance;
  /** What the handoff must keep, when someone said so. */
  focus?: string;
}): Promise<SummaryAttempt> {
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
    const summaryValid = Boolean(chat.summary && chat.summaryRevision === chat.historyRevision);
    const previousCovered = summaryValid && chat.summaryUpToMessageId
      ? await tx.message.findFirst({ where: { id: chat.summaryUpToMessageId, chatId: chat.id } }) : null;
    // A summary of tool work alone ends at no message; any other must still find its own.
    const hasPrevious = summaryValid && (Boolean(previousCovered) || !chat.summaryUpToMessageId);
    if (previousCovered && compareMessages(previousCovered, covered) > 0) return null;
    const incremental = hasPrevious && Boolean(chat.summary?.startsWith(TASK_STATE_VERSION));
    // The browser may only have a recent page. Cover every intervening stored
    // message, rather than silently skipping the gap after the last summary.
    const evidence = await tx.message.findMany({
      where: { chatId: chat.id, AND: [
        throughMessage(covered),
        ...(incremental && previousCovered ? [afterMessage(previousCovered)] : []),
      ] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const lastAnswer = params.allowPreviousModel ? await tx.message.findFirst({
      where: { chatId: chat.id, role: "assistant" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { content: true, status: true },
    }) : null;
    const previousModel = lastAnswer?.status === "success" ? decodePersistedAssistantToolMessage(lastAnswer.content)?.answeredBy : undefined;
    return { chat, rows: evidence, covered, incremental, hasPrevious, previousModel };
  });
  if (!snapshot) return null;
  const existing = snapshot.chat;
  if (existing.summary && existing.summaryRevision === existing.historyRevision && existing.summaryUpToMessageId === snapshot.covered.id) {
    return { summary: existing.summary, upToMessageId: snapshot.covered.id, modelId: existing.summaryModelId?.split(":").slice(1).join(":") ?? "" };
  }

  const main = params.modelRef ?? await preferredModel("chat").catch(() => null);
  if (!main) return null;
  // Existing cached summaries remain readable. When coverage grows, rebuild an
  // older format from original evidence instead of treating it as the new task state.
  const previous = snapshot.hasPrevious ? existing.summary! : "";
  const delta = snapshot.rows;

  const state = readSummaryState(snapshot.hasPrevious ? existing.summaryState : null);
  try {
    const folded = new Set(state.calls);
    const preferences = await getModelPreferences();
    const recordCharacters = summaryRecordCharacters(contextBudget(await modelInLibrary("chat", main), preferences.contextLimits[modelRefKey(main)]).inputTokens);
    // A request may show only excerpts or skip intervening turns. Summarize the
    // stored interval whose end this write will mark as covered.
    const { state: summary, modelRef: chosen } = await summarizeWithInternalAgent({ main, previous, previousModel: snapshot.previousModel,
      records: delta.map(message => `${message.role}: ${summaryText(message, folded, recordCharacters)}`), signal: params.signal, allowance: params.allowance, focus: params.focus });
    if (!summary) return null;
    params.signal?.throwIfAborted();
    const saved = await db.chat.updateMany({
      where: { id: params.chatId, historyRevision: existing.historyRevision,
        summaryUpToMessageId: existing.summaryUpToMessageId, summaryRevision: existing.summaryRevision, summary: existing.summary },
      data: { summary, summaryUpToMessageId: snapshot.covered.id, summaryModelId: `${chosen.providerId}:${chosen.modelId}`, summaryRevision: existing.historyRevision,
        summaryState: JSON.stringify(foldIntoState(state, { toolCalls: delta.flatMap(storedToolCalls) })) },
    });
    if (!saved.count) return null;
    return { summary, upToMessageId: snapshot.covered.id, modelId: chosen.modelId };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof IncompleteTaskSummary && error.draft) return {
      draft: error.draft, historyRevision: existing.historyRevision,
      previousSummary: snapshot.hasPrevious ? existing.summary : null,
      previousBoundary: snapshot.hasPrevious ? existing.summaryUpToMessageId : null,
      files: foldIntoState(state, { toolCalls: delta.flatMap(storedToolCalls).filter(tool => tool.output !== undefined) }).files,
    };
    // A summary is an optimisation. Failing to produce one leaves the excerpts
    // in place, which is why the excerpts are still built.
    return null;
  }
}

export async function summarizeOlderTurns(params: Parameters<typeof attemptOlderTurnSummary>[0]): Promise<SummaryResult> {
  const result = await attemptOlderTurnSummary(params);
  return result && "summary" in result ? result : null;
}

/**
 * A fold made during a turn. Its evidence is the live step, not yet stored, so it
 * goes straight to the one summary. It is refused if that summary changed since the
 * turn read it. A list of folded messages can move the summary's end only when
 * it includes the entire saved interval since the previous boundary.
 */
export async function commitTurnFold(params: { chatId: string; historyRevision: number; expected: string | null; summary: string; change: Parameters<typeof foldIntoState>[1]; coveredMessageIds?: string[]; modelId: string }) {
  return db.$transaction(async tx => {
    const chat = await tx.chat.findUnique({ where: { id: params.chatId } });
    if (!chat || chat.historyRevision !== params.historyRevision) return false;
    const current = chat.summary && chat.summaryRevision === chat.historyRevision ? chat.summary : null;
    if (current !== params.expected) return false;
    let upToMessageId = current ? chat.summaryUpToMessageId : null;
    const lastId = params.coveredMessageIds?.at(-1);
    if (lastId) {
      const end = await tx.message.findFirst({ where: { chatId: chat.id, OR: [{ id: lastId }, { clientMessageId: lastId }] }, select: { id: true, createdAt: true } });
      if (!end) return false;
      const previous = upToMessageId ? await tx.message.findFirst({ where: { id: upToMessageId, chatId: chat.id }, select: { id: true, createdAt: true } }) : null;
      if (upToMessageId && (!previous || compareMessages(previous, end) > 0)) return false;
      const interval = await tx.message.findMany({ where: { chatId: chat.id, AND: [throughMessage(end), ...(previous ? [afterMessage(previous)] : [])] }, select: { id: true, clientMessageId: true } });
      const folded = new Set(params.coveredMessageIds);
      if (interval.some(message => !folded.has(message.id) && !(message.clientMessageId && folded.has(message.clientMessageId)))) return false;
      upToMessageId = end.id;
    }
    const state: SummaryState = foldIntoState(current ? readSummaryState(chat.summaryState) : readSummaryState(null), params.change);
    await tx.chat.update({ where: { id: chat.id }, data: {
      summary: params.summary, summaryModelId: params.modelId, summaryRevision: chat.historyRevision, summaryState: JSON.stringify(state),
      summaryUpToMessageId: upToMessageId,
    } });
    return true;
  });
}

const storedToolCalls = (message: { content: string }) => decodePersistedAssistantToolMessage(message.content)?.tools.map(tool => ({ toolName: tool.toolName, input: tool.input, output: tool.output })) ?? [];

/**
 * Keeps the restored content while it still belongs to this summary and workspace.
 */
export async function keepRestoredContext(params: { chatId: string; expected: string; restored: RestoredContextSnapshot; seen: SummaryState["files"] }) {
  return db.$transaction(async tx => {
    const chat = await tx.chat.findUnique({ where: { id: params.chatId } });
    if (!chat || chat.summary !== params.expected || chat.summaryRevision !== chat.historyRevision) return false;
    if (params.restored.workspaceId !== null && (await conversationWorkspace(chat.id, tx))?.id !== params.restored.workspaceId) return false;
    const state = readSummaryState(chat.summaryState);
    const seen = new Map(params.seen.map(file => [`${file.grantId}\n${file.path}`, file.hash]));
    await tx.chat.update({ where: { id: chat.id }, data: { summaryState: JSON.stringify({ ...state, restored: params.restored,
      files: state.files.map(file => seen.get(`${file.grantId}\n${file.path}`) ? { ...file, hash: seen.get(`${file.grantId}\n${file.path}`) } : file) } satisfies SummaryState) } });
    return true;
  });
}

/**
 * What the summary covers, said plainly. The number is the count of turns that
 * were folded in, and the message id is what a reader would look for to find
 * them again.
 */
export function describeSummaryCoverage(params: { upToMessageId: string | null }) {
  return params.upToMessageId ? t("chat.summary.coverage") : t("chat.summary.none");
}

function summaryText(message: { id: string; role: string; content: string }, folded: Set<string>, recordCharacters: number) {
  const pictures = messageImages(message.id, message.content).map(image => `[Saved picture: ${image.name ?? image.source}, media id: ${image.mediaId}]`);
  const user = decodePersistedUserMessage(message.content);
  if (user) return [user.text, ...user.files.filter(file => !file.mediaType.startsWith("image/") || !file.url.startsWith("/api/media/")).map(file => `[attachment: ${file.filename ?? file.mediaType}]`), ...pictures].join("\n");
  const assistant = decodePersistedAssistantToolMessage(message.content);
  // Every tool call is kept, each in the bounded result-first record form the
  // in-stream compactor uses; the summarizer batches long records itself.
  if (assistant) return historicalText({ id: message.id, role: "assistant", parts: [
    { type: "text", text: assistant.text },
    ...assistant.tools.filter(tool => !folded.has(tool.toolCallId)).map(tool => ({ type: `tool-${tool.toolName}`, toolCallId: tool.toolCallId, state: tool.state,
      input: tool.input, output: tool.output, errorText: tool.errorText,
    })),
  ] as UIMessage["parts"] }, undefined, recordCharacters);
  const media = decodeMediaMessage(message.content);
  return media ? [media.text, ...pictures].join("\n") : message.content;
}
