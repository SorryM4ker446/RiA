import { buildChatContext } from "@/lib/chat/context";
import { materializeChatAttachments } from "@/lib/media/messages";
import {
  ASSISTANT_BASE_PROMPT,
  TOOL_DISABLED_INSTRUCTIONS,
  TOOL_ENABLED_INSTRUCTIONS,
  unavailableToolLines,
  TERMINAL_INSTRUCTIONS,
  type UnavailableTool,
} from "@/lib/prompts";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import type { ChatRequest } from "@/lib/chat/request";
import { getModelPreferences } from "@/lib/models/preferences";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { COMPACTED_TAIL, contextBudget } from "@/lib/models/context-budget";
import { db } from "@/db";
import { conversationCalibration } from "@/lib/models/context-calibration";
import { readSummaryState } from "./compaction-state";
import { REQUEST_CONTEXT_HEADER } from "./context-report";
import { mapStoredMessagesToUI } from "@/features/chat/page-utils";
function stripFilePartsForTextOnlyModel(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const withoutFiles = parts.filter((part) => part.type !== "file" || !part.mediaType.startsWith("image/"));
    const hadFiles = withoutFiles.length !== parts.length;

    if (!hadFiles) return message;
    if (withoutFiles.length > 0) {
      return {
        ...message,
        parts: withoutFiles,
      } satisfies UIMessage;
    }

    return {
      ...message,
      parts: [{ type: "text", text: "(The previous message was an image, which this model cannot read.)" }],
    } satisfies UIMessage;
  });
}
type StoredPosition = { id: string; createdAt: Date };
const before = (row: StoredPosition) => ({ OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }] });
const fromOn = (row: StoredPosition) => ({ OR: [{ createdAt: { gt: row.createdAt } }, { createdAt: row.createdAt, id: { gte: row.id } }] });

/**
 * The conversation as the model should see it, and the summary boundary to
 * anchor the window on.
 *
 * The browser sends only the messages it has loaded, which after a reload is
 * the latest page. Stored turns before them would otherwise be neither in the
 * window nor in the summary, so they are read from storage: from the last
 * message the current summary covers, since the summary stands for everything
 * before it, or from the start when there is no summary. The browser's own
 * messages stay authoritative; only what precedes them is filled in.
 *
 * A summary written for an earlier revision of the history is not an anchor.
 */
async function storedConversation(chatId: string | undefined, messages: UIMessage[]): Promise<{ messages: UIMessage[]; anchor: string[] }> {
  if (!chatId) return { messages, anchor: [] };
  const covered = await coveredMessage(chatId);
  const anchor = idsOf(covered);
  const first = messages[0];
  const firstStored = first
    ? await db.message.findFirst({ where: { chatId, OR: [{ id: first.id }, { clientMessageId: first.id }] }, select: { id: true, createdAt: true } })
    : null;
  if (!firstStored) return { messages, anchor };
  const older = await db.message.findMany({
    where: { chatId, AND: [before(firstStored), ...(covered ? [fromOn(covered)] : [])] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, clientMessageId: true, role: true, content: true },
  });
  if (!older.length) return { messages, anchor };
  const sent = new Set(messages.map(message => message.id));
  const filled = mapStoredMessagesToUI(older).uiMessages.filter(message => !sent.has(message.id));
  return { messages: [...filled, ...messages], anchor };
}

/** The last message the current summary covers; a summary of an earlier history covers nothing. */
async function coveredMessage(chatId: string) {
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: { summary: true, summaryUpToMessageId: true, summaryRevision: true, historyRevision: true } });
  const message = chat?.summary && chat.summaryUpToMessageId && chat.summaryRevision === chat.historyRevision
    ? await db.message.findFirst({ where: { id: chat.summaryUpToMessageId, chatId }, select: { id: true, clientMessageId: true, createdAt: true } })
    : null;
  return message ?? null;
}
const idsOf = (message: { id: string; clientMessageId: string | null } | null) => message ? [message.id, ...(message.clientMessageId ? [message.clientMessageId] : [])] : [];

/**
 * The conversation's one summary and what goes with it. It may cover no whole
 * message yet, when all it holds is tool work folded during a turn.
 */
export async function storedSummary(chatId: string) {
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: { summary: true, summaryUpToMessageId: true, summaryRevision: true, historyRevision: true, summaryState: true, summaryModelId: true } });
  if (!chat?.summary || chat.summaryRevision !== chat.historyRevision) return null;
  const covered = await coveredMessage(chatId);
  if (chat.summaryUpToMessageId && !covered) return null;
  return { summary: chat.summary, coveredIds: idsOf(covered), state: readSummaryState(chat.summaryState), modelId: chat.summaryModelId };
}

/** Stored turns the current summary does not stand in for, from its last covered message on. */
export async function storedFromSummary(chatId: string) {
  const covered = await coveredMessage(chatId);
  const rows = await db.message.findMany({
    where: { chatId, ...(covered ? fromOn(covered) : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, clientMessageId: true, role: true, content: true },
  });
  return { messages: mapStoredMessagesToUI(rows).uiMessages, anchor: idsOf(covered) };
}

/**
 * How much of a conversation one request carries: as much as fits under the
 * compaction trigger, in the same estimated tokens the per-step check uses. Once it
 * does not, older turns go to the summary, leaving a short tail, so the new start
 * holds for a long while instead of moving on every request.
 */
export async function conversationWindow(model: ChatRequest["model"], modelRef: ChatRequest["modelRef"], messages: UIMessage[] = []) {
  const preferences = await getModelPreferences();
  const budget = contextBudget(model, preferences.contextLimits[modelRefKey(modelRef)]);
  const calibration = modelRef ? await conversationCalibration(modelRef, messages) : 1;
  const windowTokens = Math.floor(budget.triggerTokens / calibration);
  // Excerpts stand in for older turns only when no summary covers them; they
  // grow with the window instead of staying at a size chosen for small models.
  const excerptCharacters = Math.max(4_000, Math.floor(windowTokens / 8));
  return {
    maxTokens: windowTokens,
    refillRatio: COMPACTED_TAIL,
    excerptCharacters,
    excerptMessageCharacters: Math.max(500, Math.floor(excerptCharacters / 12)),
  };
}

/**
 * The files the model has seen in this conversation and the hash of what it saw, oldest
 * first: those behind the summary, then the calls still in the conversation in order.
 */
export function filesSeen(state: { files: { grantId: string; path: string; hash?: string }[] } | undefined, messages: UIMessage[], grantId: string) {
  const seen = new Map<string, string>();
  const note = (path: unknown, hash: unknown) => {
    if (typeof path !== "string" || typeof hash !== "string") return;
    seen.delete(path); seen.set(path, hash);
  };
  for (const file of state?.files ?? []) if (file.grantId === grantId) note(file.path, file.hash);
  for (const message of messages) for (const part of message.parts) {
    if (part.type !== "tool-readProjectFile" && part.type !== "tool-editProjectFile") continue;
    const { input, output } = part as { input?: { grantId?: unknown; path?: unknown }; output?: { hash?: unknown } };
    if (input?.grantId === grantId) note(input.path, output?.hash);
  }
  return seen;
}

/** Most of a request's reference data kept to send again; a larger block is sent once. */
const MAX_KEPT_REQUEST_CONTEXT = 32_000;

/** What the user messages of a conversation were sent with, by every id the browser may use. */
async function sentRequestContexts(chatId: string) {
  const rows = await db.message.findMany({ where: { chatId, requestContext: { not: null } }, select: { id: true, clientMessageId: true, requestContext: true } });
  const contexts = new Map<string, string[]>();
  for (const row of rows) {
    let texts: unknown;
    try { texts = JSON.parse(row.requestContext!); } catch { continue; }
    if (!Array.isArray(texts) || !texts.every(text => typeof text === "string")) continue;
    contexts.set(row.id, texts as string[]);
    if (row.clientMessageId) contexts.set(row.clientMessageId, texts as string[]);
  }
  return contexts;
}

/**
 * Keeps what a user message was sent with, so the next request repeats it. A provider's
 * prompt cache matches a prefix exactly: without this, everything after the previous
 * user message would miss it on every turn. Only a failure to reuse it is at stake.
 */
export async function keepRequestContext(chatId: string, messageId: string | undefined, texts: string[]) {
  if (!messageId) return;
  const kept = texts.join("").length <= MAX_KEPT_REQUEST_CONTEXT ? JSON.stringify(texts) : null;
  await db.message.updateMany({ where: { chatId, OR: [{ id: messageId }, { clientMessageId: messageId }] }, data: { requestContext: kept } }).catch(() => console.error("chat.request-context.save.failed"));
}

export async function prepareModelContext(input: ChatRequest, signal?: AbortSignal) {
  const { model } = input;
  const { messages, anchor } = await storedConversation(input.requestedChatId, input.messages);
  const effectiveMessages = model?.supportsImageInput
    ? messages
    : stripFilePartsForTextOnlyModel(messages);
  const stored = input.requestedChatId ? await storedSummary(input.requestedChatId) : null;
  const context = buildChatContext(effectiveMessages, {
    ...await conversationWindow(model, input.modelRef, messages),
    maxMessages: effectiveMessages.length,
    anchorMessageIds: anchor,
    requestContexts: input.requestedChatId ? await sentRequestContexts(input.requestedChatId) : undefined,
    // A model that cannot take tools cannot take a record of them either.
    ...((input.body.mode ?? "chat") === "chat" && input.model?.supportsTools === true && (!input.assistant || input.assistant.tools.length > 0) ? { toolRecords: { replaysReasoning: input.modelRef.providerId === "deepseek", covered: stored?.state.calls, keepPreviousToolTurn: true } } : {}),
  });
  const modelMessages = await convertToModelMessages(await materializeChatAttachments(context.messages, signal));

  return { context, modelMessages };
}
export function formatLongTermContext(
  memories: Array<{ key: string; value: string; score: number | null }>,
): string {
  if (memories.length === 0) return "";
  return memories
    .map((memory, index) => `${index + 1}. ${memory.key}: ${memory.value}`)
    .join("\n");
}
/**
 * The user's stated preferences, rendered as instructions.
 *
 * Kept apart from the rest of the prompt and stated as the user's own words,
 * so a preference cannot be mistaken for something the assistant decided. Only
 * the fields that were filled in appear: an empty section would invite the model
 * to invent one.
 */
export function formatPersona(persona?: { name?: string; language?: string; answerStyle?: string; notes?: string } | null) {
  const lines = [
    persona?.name ? `Address the user as: ${persona.name}.` : "",
    persona?.language ? `Reply in: ${persona.language}.` : "",
    persona?.answerStyle ? `Answer style: ${persona.answerStyle}.` : "",
    persona?.notes ? `Additional user instructions: ${persona.notes}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? lines.join(String.fromCharCode(10)) : "";
}

/**
 * Rules that stay the same across a conversation's turns. Nothing derived from
 * this turn's message — summaries, memories, evidence — is placed here.
 */
export function buildSystemPrompt(
  toolsEnabled: boolean,
  unavailableTools: (string | UnavailableTool)[] = [],
  persona?: { name?: string; language?: string; answerStyle?: string; notes?: string } | null,
): string {
  // The terminal paragraph only when the terminal is actually offered this turn.
  const terminalOffered = toolsEnabled && !unavailableTools.some(tool => (typeof tool === "string" ? tool : tool.id) === "runTerminalCommand");
  const toolInstruction = toolsEnabled ? [...TOOL_ENABLED_INSTRUCTIONS, ...(terminalOffered ? TERMINAL_INSTRUCTIONS : [])] : TOOL_DISABLED_INSTRUCTIONS;
  const personaText = formatPersona(persona);

  return [
    ASSISTANT_BASE_PROMPT,
    ...toolInstruction,
    // One line per optional tool that is configured away this turn. Without it
    // the model has no way to tell that a lookup it would normally make is not
    // available, and would answer from memory as if it had checked.
    ...unavailableToolLines(unavailableTools).flatMap(line => ["", line]),
    ...(personaText ? ["", "[User Preferences]", personaText] : []),
  ].join("\n");
}

export { REQUEST_CONTEXT_HEADER };
export const REQUEST_CONTEXT_FOOTER = "[End of context; the user's message follows]";

/**
 * The moment of this request, where the user is. The service runs on the user's
 * own machine, so its time zone is theirs. The model has no clock, so without this
 * it cannot turn "tomorrow" into a date.
 */
export function formatCurrentTime(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const part = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(now).map(item => [item.type, item.value]));
  return `Current date and time: ${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}, ${part.weekday} (${timeZone}, ${part.timeZoneName})`;
}

/** This turn's reference data, as one labelled block; empty when there is none. */
export function buildRequestContext(parts: { currentTime?: string; workspace?: string; historyExcerpt?: string; fileChanges?: string; memories?: string; evidence?: string }): string {
  const sections = [
    parts.currentTime?.trim() ?? "",
    parts.workspace?.trim() ?? "",
    parts.historyExcerpt?.trim() ?? "",
    parts.fileChanges?.trim() ?? "",
    parts.memories?.trim() ? `Long-term memories that may be relevant:\n${parts.memories.trim()}` : "",
    parts.evidence?.trim() ?? "",
  ].filter(Boolean);
  return sections.length ? [REQUEST_CONTEXT_HEADER, ...sections, REQUEST_CONTEXT_FOOTER].join("\n\n") : "";
}

/**
 * Attach the context block to the latest user message, ahead of its text.
 * Earlier turns are left byte-for-byte unchanged, so the prompt prefix up to the
 * previous turn stays cacheable; the block is rebuilt per request, never saved.
 * A directive is what the user chose for this message: unlike the reference data
 * it is meant to be followed, so it stands apart from the block.
 */
export function withRequestContext(messages: ModelMessage[], context: string, directive = ""): ModelMessage[] {
  return withRequestTexts(messages, [context, directive].filter(Boolean));
}

export function withRequestTexts(messages: ModelMessage[], texts: string[]): ModelMessage[] {
  if (!texts.length) return messages;
  let latest = -1;
  messages.forEach((message, index) => { if (message.role === "user") latest = index; });
  if (latest < 0) return messages;
  const message = messages[latest] as Extract<ModelMessage, { role: "user" }>;
  const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  return messages.map((item, index) => index === latest ? { ...message, content: [...texts.map(text => ({ type: "text" as const, text })), ...content] } : item);
}
