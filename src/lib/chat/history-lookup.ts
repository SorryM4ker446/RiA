import { decodePersistedAssistantToolMessage, decodePersistedUserMessage } from "@/lib/ai/ui-message";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";

const PAGE_CHARACTERS = 20_000, SNIPPET_CHARACTERS = 200, MAX_MATCHES = 10;

type Entry = { messageId: string; role: string; text: string; tools: { toolCallId: string; toolName: string; record: string }[] };

function entryOf(row: { id: string; role: string; content: string }): Entry {
  const assistant = decodePersistedAssistantToolMessage(row.content);
  if (assistant) return { messageId: row.id, role: row.role, text: assistant.text, tools: assistant.tools.map(tool => ({ toolCallId: tool.toolCallId, toolName: tool.toolName,
    record: JSON.stringify({ state: tool.state, input: tool.input, output: tool.output, errorText: tool.errorText }) })) };
  return { messageId: row.id, role: row.role, text: decodePersistedUserMessage(row.content)?.text ?? row.content, tools: [] };
}

const page = (text: string, offset: number) => ({ text: text.slice(offset, offset + PAGE_CHARACTERS), totalCharacters: text.length, nextOffset: offset + PAGE_CHARACTERS < text.length ? offset + PAGE_CHARACTERS : null });

function snippet(text: string, at: number, length: number) {
  const start = Math.max(0, at - SNIPPET_CHARACTERS);
  return `${start ? "..." : ""}${text.slice(start, at + length + SNIPPET_CHARACTERS)}${at + length + SNIPPET_CHARACTERS < text.length ? "..." : ""}`;
}

/** A conversation's own saved messages and tool results; nothing outside it. */
export async function lookupConversationHistory(chatId: string | null | undefined, input: { toolCallId?: string; messageId?: string; query?: string; offset?: number }) {
  if (!chatId) throw new ApiError({ code: "VALIDATION_ERROR", message: "This tool only works inside a conversation." });
  const rows = await db.message.findMany({ where: { chatId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, role: true, content: true } });
  const offset = input.offset ?? 0;
  if (input.messageId) {
    const row = rows.find(item => item.id === input.messageId);
    if (!row) return { found: false as const };
    const entry = entryOf(row);
    return { found: true as const, messageId: entry.messageId, role: entry.role, toolCallIds: entry.tools.map(tool => tool.toolCallId), ...page(entry.text, offset) };
  }
  if (input.toolCallId) {
    for (const row of rows) {
      if (!row.content.includes(input.toolCallId)) continue;
      const tool = entryOf(row).tools.find(item => item.toolCallId === input.toolCallId);
      if (tool) return { found: true as const, messageId: row.id, toolCallId: tool.toolCallId, toolName: tool.toolName, ...page(tool.record, offset) };
    }
    return { found: false as const };
  }
  const query = (input.query ?? "").toLowerCase();
  const matches: { messageId: string; role: string; toolCallId?: string; toolName?: string; snippet: string }[] = [];
  for (const row of rows) {
    if (matches.length >= MAX_MATCHES) break;
    if (!row.content.toLowerCase().includes(query)) continue;
    const entry = entryOf(row);
    const inText = entry.text.toLowerCase().indexOf(query);
    if (inText >= 0) matches.push({ messageId: entry.messageId, role: entry.role, snippet: snippet(entry.text, inText, query.length) });
    for (const tool of entry.tools) {
      if (matches.length >= MAX_MATCHES) break;
      const inRecord = tool.record.toLowerCase().indexOf(query);
      if (inRecord >= 0) matches.push({ messageId: entry.messageId, role: entry.role, toolCallId: tool.toolCallId, toolName: tool.toolName, snippet: snippet(tool.record, inRecord, query.length) });
    }
  }
  return { found: matches.length > 0, matches, newestFirst: true, moreMayExist: matches.length >= MAX_MATCHES };
}
