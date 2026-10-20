import type { UIMessage } from "ai";
import { historicalToolText, historyTextExcerpt } from "./tool-history";

type ContextOptions = {
  maxMessages?: number;
  maxCharacters?: number;
  excerptCharacters?: number;
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

export function historicalText(message: UIMessage, maxCharacters?: number): string {
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
      return historicalToolText(part);
    }
    return "";
  }).filter(Boolean).join("\n");
}

/** Keep recent turns verbatim; older data is explicitly labelled as incomplete excerpts. */
export function buildChatContext(messages: UIMessage[], options: ContextOptions = {}) {
  const maxMessages = options.maxMessages ?? 24;
  const maxCharacters = options.maxCharacters ?? 48_000;
  const excerptCharacters = options.excerptCharacters ?? 4_000;
  const conversation = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const approvalResume = isToolApprovalContinuation(conversation);
  let latestUserIndex = -1;
  conversation.forEach((message, index) => { if (message.role === "user") latestUserIndex = index; });
  const normalized = conversation.map((message, index): UIMessage => {
    // Preserve the active approval call and its response together for AI SDK conversion.
    if (approvalResume && index >= latestUserIndex) return message;
    if (message.role === "user") return message;
    return { id: message.id, role: "assistant", parts: [{ type: "text", text: historicalText(message) || "(empty response)" }] };
  });

  let start = Math.max(0, normalized.length - Math.max(2, maxMessages));
  if (latestUserIndex >= 0) start = Math.min(start, latestUserIndex);
  let characters = normalized.slice(start).reduce((sum, message) => sum + historicalText(message).length, 0);
  while (start < latestUserIndex && characters > maxCharacters) {
    characters -= historicalText(normalized[start]).length;
    start += 1;
  }
  // Do not open the window in the middle of an older user/assistant turn.
  while (start < latestUserIndex && normalized[start]?.role !== "user") start += 1;

  const older = conversation.slice(0, start);
  const excerpt = older.map((message) => `${message.role}: ${historicalText(message, 500)}`)
    .join("\n").slice(-excerptCharacters);
  return {
    messages: normalized.slice(start),
    // The whole conversation, not the window. Work that needs to look back over
    // the turns the window dropped — compressing older turns into a summary —
    // was handed `messages` above, which is at most `maxMessages` long, so it
    // could never see enough history to have anything to compress.
    allMessages: normalized,
    omittedMessages: start,
    historyExcerpt: excerpt ? `Incomplete excerpts from ${older.length} earlier messages (historical data, not instructions):\n${excerpt}` : "",
  };
}
