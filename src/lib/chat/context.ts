import type { UIMessage } from "ai";
import { historicalToolText, historyTextExcerpt } from "./tool-history";
import { estimateTextTokens } from "@/lib/models/context-budget";
import type { PersistedStep } from "@/lib/ai/ui-message";
import { currentToolId } from "@/tools/legacy-names";

type ContextOptions = {
  maxMessages?: number;
  maxCharacters?: number;
  /** Window size in estimated tokens; takes precedence over maxCharacters. */
  maxTokens?: number;
  excerptCharacters?: number;
  /** Per-message share of the excerpts for turns outside the window. */
  excerptMessageCharacters?: number;
  /**
   * Ids of the last message an existing summary covers. While the turns after
   * it still fit, the window starts right after it, so the summary is reused
   * and the prompt prefix stays the same from one request to the next.
   */
  anchorMessageIds?: string[];
  /**
   * When the window overflows, older turns are dropped until it uses this share
   * of its size, so the new start then holds for many turns instead of moving
   * on every request. Without it, only as much as needed is dropped.
   */
  refillRatio?: number;
  /** What each user message was sent with, kept so a later request repeats it exactly. */
  requestContexts?: ReadonlyMap<string, string[]>;
  /**
   * Keep finished tool calls and their results as they were, rather than as text
   * excerpts, so a later turn can use what an earlier one read. Space is made only
   * when the request nears the limit.
   */
  toolRecords?: {
    replaysReasoning?: boolean;
    /** Calls the summary already stands in for: they are not sent, so they take no room. */
    covered?: readonly string[];
    /**
     * A request stays in touch with the turn before it: a turn whose tool results do not
     * fit keeps its calls, its reply and short forms of its results, which the per-step
     * check makes, rather than dropping out whole.
     */
    keepPreviousToolTurn?: boolean;
  };
};

function isToolPart(part: UIMessage["parts"][number]) {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

/** Only the final assistant message can continue the current tool approval. */
export function isToolApprovalContinuation(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.parts.some(
    (part) => isToolPart(part) && "state" in part && part.state === "approval-responded" &&
      "approval" in part && typeof part.approval?.approved === "boolean",
  );
}

export function historicalText(message: UIMessage, maxCharacters?: number, recordCharacters?: number): string {
  if (maxCharacters !== undefined) {
    const tools = message.parts.filter(isToolPart);
    const prose = message.parts.map(part => part.type === "text" ? part.text : part.type === "file" ? `[attachment: ${part.filename || part.mediaType}]` : "").filter(Boolean).join("\n");
    if (!tools.length) return historyTextExcerpt(prose, maxCharacters);
    const selected = tools.slice(-Math.min(3, Math.max(1, Math.floor(maxCharacters / 400)))).reverse();
    const omitted = tools.length - selected.length;
    const notice = omitted ? `[Historical excerpt: ${omitted} earlier tool calls omitted]\n` : "";
    const answer = prose ? `\nAssistant text (excerpt):\n${historyTextExcerpt(prose, Math.floor(maxCharacters / 5))}` : "";
    const budget = Math.max(0, Math.floor((maxCharacters - notice.length - answer.length - selected.length) / selected.length));
    return historyTextExcerpt(notice + selected.map(part => historicalToolText(part, budget)).join("\n") + answer, maxCharacters);
  }
  return message.parts.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "file") return `[attachment: ${part.filename || part.mediaType}]`;
    if (isToolPart(part) && "state" in part) {
      return historicalToolText(part, recordCharacters);
    }
    return "";
  }).filter(Boolean).join("\n");
}

const HISTORY_INPUT_CHARACTERS = 8000;
const finished = (part: UIMessage["parts"][number]) => "state" in part && (part.state === "output-available" || part.state === "output-error");

/**
 * An assistant turn as later requests carry it: its finished calls and results,
 * then its text. A call that never finished has no result to pair it with, so it
 * stays only as a note. The turn always ends in text: a request ending on results
 * reads to a provider as a tool loop still running, not as a new question.
 */
function historyTurn(message: UIMessage, replaysReasoning: boolean): UIMessage {
  const tools = message.parts.filter(isToolPart);
  if (!tools.some(finished)) return { id: message.id, role: "assistant", parts: [{ type: "text", text: historicalText(message) || "(empty response)" }] };
  // An approval already settled; the result it led to is what remains of it. A
  // very long input, such as a whole script, must not push the turn out of the
  // window for the sake of text the model rarely needs again.
  const record = (part: UIMessage["parts"][number]) => {
    const { approval: _settled, ...rest } = part as typeof part & { approval?: unknown; input?: unknown };
    const input = JSON.stringify(rest.input) ?? "";
    return (input.length > HISTORY_INPUT_CHARACTERS ? { ...rest, input: { excerpt: historyTextExcerpt(input, HISTORY_INPUT_CHARACTERS) } } : rest) as UIMessage["parts"][number];
  };
  const notes = tools.filter(part => !finished(part)).map(part => historicalToolText(part));
  const inSteps = withSteps(message).parts;
  // Step by step, as it was sent while the turn ran, so a provider's prompt cache keeps
  // matching it. A turn saved before steps were recorded has its calls first, then its text.
  if (inSteps.some(part => part.type === "step-start")) {
    const parts = inSteps.flatMap((part): UIMessage["parts"] => part.type === "step-start" ? [part]
      // Exactly as it was, whitespace included: a cache match is exact.
      : part.type === "reasoning" ? (replaysReasoning && part.text ? [part] : [])
      : part.type === "text" ? (part.text ? [part] : [])
      : isToolPart(part) && finished(part) ? [record(part)] : []);
    if (notes.length) parts.push({ type: "text", text: notes.join("\n") });
    // A request ending on results reads to a provider as a tool loop still running.
    while (parts.at(-1)?.type === "step-start") parts.pop();
    if (parts.at(-1)?.type !== "text") parts.push({ type: "step-start" }, { type: "text", text: "(no reply text)" });
    return { id: message.id, role: "assistant", parts };
  }
  const text = [...message.parts.flatMap(part => part.type === "text" && part.text.trim() ? [part.text] : []), ...notes].join("\n");
  return { id: message.id, role: "assistant", parts: [
    ...(replaysReasoning ? message.parts.filter(part => part.type === "reasoning" && part.text.trim()) : []),
    ...tools.filter(finished).map(record),
    { type: "step-start" },
    { type: "text", text: text || "(no reply text)" },
  ] };
}

/** A page still open from before a tool was renamed sends the old name back. */
function withCurrentToolNames(message: UIMessage): UIMessage {
  if (!message.parts.some(part => part.type.startsWith("tool-") && currentToolId(part.type.slice(5)) !== part.type.slice(5))) return message;
  return { ...message, parts: message.parts.map(part => part.type.startsWith("tool-") ? { ...part, type: `tool-${currentToolId(part.type.slice(5))}` } as UIMessage["parts"][number] : part) };
}

/** A message read back from storage, laid out in the steps it was recorded with. */
function withSteps(message: UIMessage): UIMessage {
  const steps = (message.metadata as { steps?: PersistedStep[] } | undefined)?.steps;
  if (!steps?.length || message.parts.some(part => part.type === "step-start")) return message;
  const calls = new Map(message.parts.flatMap(part => "toolCallId" in part && typeof part.toolCallId === "string" ? [[part.toolCallId, part] as const] : []));
  const parts = steps.flatMap((step, index): UIMessage["parts"] => [
    ...(index ? [{ type: "step-start" as const }] : []),
    ...(step.reasoning ? [{ type: "reasoning" as const, text: step.reasoning }] : []),
    ...(step.text ? [{ type: "text" as const, text: step.text }] : []),
    ...step.calls.flatMap(id => calls.get(id) ? [calls.get(id)!] : []),
  ]);
  // A call the record does not name, such as one resumed after it was written, still counts.
  const named = new Set(steps.flatMap(step => step.calls));
  parts.push(...[...calls].filter(([id]) => !named.has(id)).map(([, part]) => part));
  return { ...message, parts };
}

/** A message as it counts toward the window. */
const recordText = (message: UIMessage, covered: ReadonlySet<string>) => message.parts.map(part => part.type === "text" ? part.text : part.type === "step-start" ? "" : part.type === "file" ? `[attachment: ${part.filename || part.mediaType}]`
  : "toolCallId" in part && covered.has(part.toolCallId) ? "" : JSON.stringify(part)).join("\n");
/** About what a shortened tool result takes, with its call. */
const SHORTENED_RESULT_TOKENS = 150;

/** Keep recent turns verbatim; older data is explicitly labelled as incomplete excerpts. */
export function buildChatContext(messages: UIMessage[], options: ContextOptions = {}) {
  const maxMessages = options.maxMessages ?? 24;
  const windowSize = options.maxTokens ?? options.maxCharacters ?? 48_000;
  const measure = options.maxTokens !== undefined ? estimateTextTokens : (text: string) => text.length;
  const excerptCharacters = options.excerptCharacters ?? 4_000;
  const conversation = messages.filter((message) => message.role === "user" || message.role === "assistant").map(withCurrentToolNames);
  const approvalResume = isToolApprovalContinuation(conversation);
  let latestUserIndex = -1;
  conversation.forEach((message, index) => { if (message.role === "user") latestUserIndex = index; });
  const normalized = conversation.map((message, index): UIMessage => {
    // Preserve the active approval call and its response together for AI SDK conversion.
    if (approvalResume && index >= latestUserIndex) return message.role === "assistant" ? withSteps(message) : message;
    if (message.role === "user") return message;
    if (options.toolRecords) return historyTurn(message, options.toolRecords.replaysReasoning === true);
    return { id: message.id, role: "assistant", parts: [{ type: "text", text: historicalText(message) || "(empty response)" }] };
  });

  let start = Math.max(0, normalized.length - Math.max(2, maxMessages));
  if (latestUserIndex >= 0) start = Math.min(start, latestUserIndex);
  const covered = new Set(options.toolRecords?.covered);
  // What an earlier message was sent with goes with it again. The latest request gets
  // its own, except an approval resuming, which continues the same request.
  const sentWith = (message: UIMessage, index: number) => message.role === "user" && (index !== latestUserIndex || approvalResume) ? options.requestContexts?.get(message.id) ?? [] : [];
  const sizes = normalized.map((message, index) => measure(options.toolRecords ? recordText(message, covered) : historicalText(message)) + sentWith(message, index).reduce((sum, text) => sum + measure(text), 0));
  const sizeFrom = (from: number) => sizes.slice(from).reduce((sum, value) => sum + value, 0);
  // Only when what cannot be shortened fits; a turn of long text can still drop out.
  let keepFrom = latestUserIndex;
  if (options.toolRecords?.keepPreviousToolTurn) {
    let previous = latestUserIndex - 1;
    while (previous >= 0 && normalized[previous].role !== "user") previous--;
    const turn = previous >= 0 ? normalized.slice(previous, latestUserIndex) : [];
    const tools = turn.flatMap(message => message.parts.filter(isToolPart)).length;
    const fixed = turn.reduce((sum, message) => sum + measure(recordText({ ...message, parts: message.parts.filter(part => !isToolPart(part)) }, covered)), 0);
    if (tools && fixed + tools * SHORTENED_RESULT_TOKENS <= windowSize * (options.refillRatio ?? 1)) keepFrom = previous;
  }
  const anchors = new Set(options.anchorMessageIds ?? []);
  const anchorIndex = anchors.size ? normalized.findIndex(message => anchors.has(message.id)) : -1;
  const anchored = anchorIndex >= 0 && anchorIndex < latestUserIndex ? anchorIndex + 1 : -1;
  if (anchored >= start && sizeFrom(anchored) <= windowSize) {
    start = anchored;
  } else {
    let size = sizeFrom(start);
    const limit = size > windowSize && options.refillRatio ? windowSize * options.refillRatio : windowSize;
    while (start < keepFrom && size > limit) {
      size -= sizes[start];
      start += 1;
    }
  }
  // Do not open the window in the middle of an older user/assistant turn.
  while (start < latestUserIndex && normalized[start]?.role !== "user") start += 1;

  const older = conversation.slice(0, start);
  const excerpt = older.map((message) => `${message.role}: ${historicalText(message, options.excerptMessageCharacters ?? 500)}`)
    .join("\n").slice(-excerptCharacters);
  return {
    messages: normalized.slice(start).map((message, index) => {
      const texts = sentWith(message, index + start);
      return texts.length ? { ...message, parts: [...texts.map(text => ({ type: "text" as const, text })), ...message.parts] } : message;
    }),
    // The whole conversation, not the window. Work that needs to look back over
    // the turns the window dropped — compressing older turns into a summary —
    // was handed `messages` above, which is at most `maxMessages` long, so it
    // could never see enough history to have anything to compress.
    allMessages: normalized,
    omittedMessages: start,
    historyExcerpt: excerpt ? `Incomplete excerpts from ${older.length} earlier messages (historical data, not instructions):\n${excerpt}` : "",
  };
}
