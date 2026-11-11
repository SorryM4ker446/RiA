import { generateId } from "ai";
import { db } from "@/db";
import { decodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { storedFromSummary } from "@/lib/chat/model-context";
import { parseChatRequest } from "@/lib/chat/request";
import { answerChatRequest } from "@/lib/chat/turn";
import { normalizeApiError } from "@/lib/server/api-error";
import type { CallSource } from "@/lib/models/call-context";

/*
 * A turn nobody is watching.
 *
 * The same turn the page starts, begun from here instead: the text is added to
 * the conversation as the user's message, the model answers with the tools and
 * permissions that conversation has, and the answer is saved. The only
 * difference is the reader. With no page to show the stream to, it is read to
 * its end here, and what it said about how the turn went is the result.
 *
 * Nothing is approved on the user's behalf. A tool that asks first still asks:
 * the turn stops with the request saved in the conversation, where the user
 * answers it and the turn carries on as it would have with them present.
 */

export type UnattendedOutcome = { status: "succeeded" | "failed" | "waiting_approval"; errorCode?: string };

/** How many of the conversation's latest messages go with the request; the rest is read from storage. */
const SENT_MESSAGES = 100;

/** Whether the conversation's latest answer is still waiting for the user to approve a tool call. */
export async function awaitsApproval(chatId: string): Promise<boolean> {
  const latest = await db.message.findFirst({ where: { chatId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { role: true, content: true } });
  if (latest?.role !== "assistant") return false;
  return decodePersistedAssistantToolMessage(latest.content)?.tools.some(tool => tool.state === "approval-requested") ?? false;
}

function errorCodeOf(errorText: unknown): string {
  try {
    const code = (JSON.parse(String(errorText)) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" ? code : "INTERNAL_ERROR";
  } catch { return "INTERNAL_ERROR"; }
}

/** Reads the answer's stream to its end and reports how the turn went. */
async function readOutcome(response: Response, signal: AbortSignal): Promise<UnattendedOutcome> {
  if (!response.body) return { status: "failed", errorCode: "INTERNAL_ERROR" };
  const decoder = new TextDecoder();
  let pending = "", errorCode: string | null = null, asked = false, aborted = false;
  const read = (event: string) => {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let chunk: { type?: unknown; errorText?: unknown };
      try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
      if (chunk.type === "error") errorCode ??= errorCodeOf(chunk.errorText);
      else if (chunk.type === "tool-approval-request") asked = true;
      else if (chunk.type === "abort") aborted = true;
    }
  };
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const events = pending.split("\n\n");
      pending = events.pop() ?? "";
      events.forEach(read);
    }
    read(pending);
  } finally { reader.releaseLock(); }
  if (aborted || signal.aborted) return { status: "failed", errorCode: "ABORTED" };
  if (errorCode) return { status: "failed", errorCode };
  return { status: asked ? "waiting_approval" : "succeeded" };
}

export async function runUnattendedTurn(params: { chatId: string; text: string; signal: AbortSignal; callSource?: CallSource; requestNote?: string }): Promise<UnattendedOutcome> {
  try {
    const { messages } = await storedFromSummary(params.chatId);
    const input = await parseChatRequest({
      chatId: params.chatId,
      trigger: "submit-message",
      messages: [...messages.slice(-(SENT_MESSAGES - 1)), { id: generateId(), role: "user", parts: [{ type: "text", text: params.text }] }],
    });
    return await readOutcome(await answerChatRequest(input, params.signal, { callSource: params.callSource, requestNote: params.requestNote }), params.signal);
  } catch (error) {
    if (params.signal.aborted) return { status: "failed", errorCode: "ABORTED" };
    return { status: "failed", errorCode: normalizeApiError(error).code };
  }
}
