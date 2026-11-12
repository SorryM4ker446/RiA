import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { liveTurnIds, onTurnEvent, type TurnEvent } from "@/lib/chat/live-turns";
import { onConversationsChanged } from "@/lib/conversations/events";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { db } from "@/db";

/** A comment line every so often, so a connection nothing is said on is not taken for dead along the way. */
const KEEPALIVE_MS = 25_000;

/**
 * What happens to the conversations, as server-sent events, for as long as the
 * connection stays open:
 *
 *   ready    — once, on connecting: the conversations answering now.
 *   turn     — a turn started or finished somewhere ({ type, chatId, source,
 *              outcome?, title? }); a finished one names its conversation, for
 *              a notification about it.
 *   changed  — something about the conversations changed; read them again.
 *
 * A listener that reconnects reads the list again on `ready`, so nothing said
 * while it was away is missed.
 */
export async function GET(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
  } catch (error) {
    console.error("/api/conversations/events GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to follow conversations");
  }
  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { close(); }
      };
      const onTurn = async (event: TurnEvent) => {
        if (event.type !== "turn-finished") return send("turn", event);
        // Named for a notification; a conversation deleted meanwhile has no name to give.
        const chat = await db.chat.findUnique({ where: { id: event.chatId }, select: { title: true } }).catch(() => null);
        send("turn", { ...event, title: chat?.title ?? null });
      };
      const offTurn = onTurnEvent(event => { void onTurn(event); });
      const offChanged = onConversationsChanged(() => send("changed", {}));
      const keepalive = setInterval(() => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { close(); }
      }, KEEPALIVE_MS);
      close = () => {
        if (!open) return;
        open = false;
        offTurn(); offChanged(); clearInterval(keepalive);
        try { controller.close(); } catch { /* Already closed by the reader. */ }
      };
      req.signal.addEventListener("abort", () => close(), { once: true });
      send("ready", { answering: liveTurnIds() });
    },
    cancel() { close(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive" } });
}
