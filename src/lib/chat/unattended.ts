import { generateId } from "ai";
import { db } from "@/db";
import { decodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { storedFromSummary } from "@/lib/chat/model-context";
import { parseChatRequest } from "@/lib/chat/request";
import { answerChatRequest } from "@/lib/chat/turn";
import { holdTurn, isTurnLive, waitForTurnEnd } from "@/lib/chat/live-turns";
import { markTurnAnswered } from "@/lib/conversations/mutations";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
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
 * The service holds the turn like any other, so the conversation opened while
 * it runs shows the answer as it is written.
 *
 * A run that falls due while the user is getting an answer in its
 * conversation waits for that answer to end and then goes ahead.
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

export async function runUnattendedTurn(params: {
  chatId: string; text: string; signal: AbortSignal; callSource?: CallSource; requestNote?: string;
  /** A place the run holds among background work: given back while it waits, taken again before it sends. */
  place?: { give(): void; take(signal: AbortSignal): Promise<void> };
}): Promise<UnattendedOutcome> {
  try {
    for (;;) {
      // Someone is getting an answer here: the run waits for that turn to end
      // rather than being refused, and then reads the conversation as it is.
      if (isTurnLive(params.chatId)) {
        params.place?.give();
        await waitForTurnEnd(params.chatId, params.signal);
        await params.place?.take(params.signal);
        // Another turn may have begun while it waited for its place.
        if (isTurnLive(params.chatId)) continue;
      }
      // That turn may have ended asking for an approval, which a new message would pass by.
      if (await awaitsApproval(params.chatId)) return { status: "waiting_approval" };
      const { messages } = await storedFromSummary(params.chatId);
      const input = await parseChatRequest({
        chatId: params.chatId,
        trigger: "submit-message",
        messages: [...messages.slice(-(SENT_MESSAGES - 1)), { id: generateId(), role: "user", parts: [{ type: "text", text: params.text }] }],
      });
      let response: Response;
      try {
        response = await holdTurn(params.chatId, signal => answerChatRequest(input, signal, { callSource: params.callSource, requestNote: params.requestNote }), { source: "task", outer: params.signal, settle: markTurnAnswered });
      } catch (error) {
        // Another turn began between the wait and the start: wait for that one too.
        if (error instanceof ApiError && error.code === "CONFLICT" && isTurnLive(params.chatId)) continue;
        throw error;
      }
      return await readOutcome(response, params.signal);
    }
  } catch (error) {
    if (params.signal.aborted) return { status: "failed", errorCode: "ABORTED" };
    return { status: "failed", errorCode: normalizeApiError(error).code };
  }
}
