import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { acquireSlot, runHolding, type SlotHolder, type SlotNotice } from "@/lib/models/call-slots";

/*
 * Turns the service holds while they run.
 *
 * A turn is no longer tied to the request that started it. The service reads
 * the answer's stream itself and keeps what it has said so far, so whoever
 * started the turn can leave, and anyone can attach to it again, from the
 * start, until it ends: the page that sent the message, the same conversation
 * opened later or in another window, a task reading its run to the end. Only
 * stopping it, or the request it was started for ending on its own terms
 * (`outer`), ends it early.
 *
 * A turn takes one of the service's places for model work before it starts
 * (see call-slots). With all of them taken it waits, and says so on its stream
 * ("queued, n ahead"), instead of being refused; what it does once started
 * works within its place. A turn the user asked for goes before a task's.
 *
 * Whoever listens is told when a turn starts, when it leaves the queue, and
 * when it ends, which is how the sidebar and the desktop's notifications learn
 * of answers they did not ask for.
 *
 * The registry lives as long as the service process. A turn running when the
 * service stops is lost with it, as before; its run record says so on restart.
 */

export type TurnSource = "chat" | "task";
export type TurnOutcome = "succeeded" | "failed" | "waiting_approval" | "stopped";
export type TurnEvent =
  | { type: "turn-started"; chatId: string; source: TurnSource; queued: boolean }
  | { type: "turn-running"; chatId: string; source: TurnSource }
  | { type: "turn-finished"; chatId: string; source: TurnSource; outcome: TurnOutcome; errorCode?: string };

type LiveTurn = {
  chatId: string;
  source: TurnSource;
  controller: AbortController;
  headers: Headers | null;
  /** What the answer has said so far, as sent: server-sent events, in order. */
  chunks: Uint8Array[];
  /** Whether the last chunk ended an event, so a notice can go in between without splitting one. */
  atBoundary: boolean;
  /** Notices waiting for the end of an event. */
  pendingNotices: SlotNotice[];
  queued: boolean;
  done: boolean;
  /** Readers waiting for the next chunk, or for the end. */
  waiting: Set<() => void>;
};

type Registry = { turns: Map<string, LiveTurn>; listeners: Set<(event: TurnEvent) => void> };
// Kept on the process, so a reloaded module in development still finds the turns already running.
const registry: Registry = ((globalThis as { __riaLiveTurns?: Registry }).__riaLiveTurns ??= { turns: new Map(), listeners: new Set() });
const encoder = new TextEncoder();
const sse = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
const endsEvent = (bytes: Uint8Array) => bytes.length >= 2 && bytes[bytes.length - 1] === 10 && bytes[bytes.length - 2] === 10;

/** What a stream that waited in the queue is sent as, before the answer's own response exists. */
const QUEUED_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-store", "x-vercel-ai-ui-message-stream": "v1" };

function emit(event: TurnEvent) {
  for (const listener of registry.listeners) {
    try { listener(event); } catch { /* One listener failing does not keep the others from hearing it. */ }
  }
}

/** Hears every turn start and end until the returned function is called. */
export function onTurnEvent(listener: (event: TurnEvent) => void): () => void {
  registry.listeners.add(listener);
  return () => { registry.listeners.delete(listener); };
}

/** Whether a turn is running in this conversation now, or waiting for a place to run. */
export function isTurnLive(chatId: string): boolean {
  const turn = registry.turns.get(chatId);
  return Boolean(turn && !turn.done);
}

/** Whether this conversation's turn is waiting for a place. */
export function isTurnQueued(chatId: string): boolean {
  const turn = registry.turns.get(chatId);
  return Boolean(turn && !turn.done && turn.queued);
}

/** The conversations answering now, queued ones included. */
export function liveTurnIds(): string[] {
  return [...registry.turns.values()].filter(turn => !turn.done).map(turn => turn.chatId);
}

/** Resolves once no turn is running in this conversation. */
export function waitForTurnEnd(chatId: string, signal?: AbortSignal): Promise<void> {
  if (!isTurnLive(chatId)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const off = onTurnEvent(event => {
      if (event.type !== "turn-finished" || event.chatId !== chatId || isTurnLive(chatId)) return;
      off(); signal?.removeEventListener("abort", abort); resolve();
    });
    const abort = () => { off(); reject(signal!.reason); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Reads what a turn's stream says about how it went, one server-sent event at a time. */
function outcomeReader() {
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
  return {
    push(bytes: Uint8Array) {
      pending += decoder.decode(bytes, { stream: true });
      const events = pending.split("\n\n");
      pending = events.pop() ?? "";
      events.forEach(read);
    },
    finish(stopped: boolean): { outcome: TurnOutcome; errorCode?: string } {
      read(pending + decoder.decode());
      pending = "";
      if (aborted || stopped) return { outcome: "stopped" };
      if (errorCode) return { outcome: "failed", errorCode };
      return { outcome: asked ? "waiting_approval" : "succeeded" };
    },
  };
}

function errorCodeOf(errorText: unknown): string {
  try {
    const code = (JSON.parse(String(errorText)) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" ? code : "INTERNAL_ERROR";
  } catch { return "INTERNAL_ERROR"; }
}

/** A reader of the turn from its first chunk, following it to its end. Leaving early leaves the turn running. */
function follow(turn: LiveTurn): ReadableStream<Uint8Array> {
  let index = 0;
  let cancelled = false;
  let wake: (() => void) | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (index >= turn.chunks.length && !turn.done && !cancelled) {
        await new Promise<void>(resolve => { wake = resolve; turn.waiting.add(resolve); });
        if (wake) turn.waiting.delete(wake);
        wake = null;
      }
      if (cancelled) return;
      if (index < turn.chunks.length) controller.enqueue(turn.chunks[index++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
      if (wake) { turn.waiting.delete(wake); wake(); }
    },
  });
}

function wakeAll(turn: LiveTurn) {
  const waiting = [...turn.waiting];
  turn.waiting.clear();
  for (const resume of waiting) resume();
}

/** Adds what the answer said, then any notice that was waiting for the end of an event. */
function append(turn: LiveTurn, bytes: Uint8Array) {
  turn.chunks.push(bytes);
  turn.atBoundary = endsEvent(bytes);
  if (turn.atBoundary) for (const notice of turn.pendingNotices.splice(0)) turn.chunks.push(noticeChunk(notice));
  wakeAll(turn);
}

/** A notice is transient: the page shows it while it is true, and nothing keeps it. */
const noticeChunk = (notice: SlotNotice) => sse({ type: "data-turn-status", data: notice, transient: true });

function notify(turn: LiveTurn, notice: SlotNotice) {
  if (turn.done) return;
  if (!turn.atBoundary) { turn.pendingNotices.push(notice); return; }
  turn.chunks.push(noticeChunk(notice));
  wakeAll(turn);
}

/**
 * Starts a turn the service holds. `start` begins the answer with the signal
 * that stops it and returns its streaming response; the response given back
 * reads the same stream from the service's copy, so the caller may stop reading
 * without stopping the turn. A conversation answers one turn at a time: asking
 * for a second while one runs is refused before anything is saved.
 *
 * With a place free the turn starts at once and its response is the answer's.
 * Otherwise the response comes back at once and says the turn is queued;
 * `beforeQueue` runs first (to save the user's message, so it is there to see
 * while the turn waits), and the answer follows on the same stream once a place
 * frees up. A failure to start then arrives on the stream as its error.
 */
export async function holdTurn(chatId: string, start: (signal: AbortSignal) => Promise<Response>, options: {
  source: TurnSource;
  outer?: AbortSignal;
  /** Runs when the turn has ended and before anyone is told, so what they read then includes it. */
  settle?: (chatId: string, outcome: TurnOutcome) => Promise<void>;
  /** Runs once the turn is known to wait for a place, before its response is returned. */
  beforeQueue?: () => Promise<void>;
}): Promise<Response> {
  if (isTurnLive(chatId)) throw new ApiError({ code: "CONFLICT", message: "This conversation is still answering. Wait for it to finish or stop it first." });
  const controller = new AbortController();
  const turn: LiveTurn = { chatId, source: options.source, controller, headers: null, chunks: [], atBoundary: true, pendingNotices: [], queued: false, done: false, waiting: new Set() };
  registry.turns.set(chatId, turn);
  const stopWithOuter = () => controller.abort(options.outer?.reason);
  if (options.outer?.aborted) stopWithOuter();
  options.outer?.addEventListener("abort", stopWithOuter, { once: true });
  const holder: SlotHolder = { notify: notice => notify(turn, notice), ended: false };

  const outcome = outcomeReader();
  let release: (() => void) | null = null;
  /** Ends the turn: gives its place back, records how it went and tells everyone. */
  const finish = async (result: { outcome: TurnOutcome; errorCode?: string }) => {
    options.outer?.removeEventListener("abort", stopWithOuter);
    holder.ended = true;
    turn.done = true;
    wakeAll(turn);
    release?.();
    if (registry.turns.get(turn.chatId) === turn) registry.turns.delete(turn.chatId);
    await options.settle?.(turn.chatId, result.outcome).catch(() => console.error("chat.turn.settle_failed"));
    emit({ type: "turn-finished", chatId: turn.chatId, source: options.source, ...result });
  };
  /** Reads the answer's response to its end, keeping all it says. */
  const pump = async (response: Response) => {
    const body = response.body;
    try {
      if (!body) return;
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          append(turn, value);
          outcome.push(value);
        }
      } finally { reader.releaseLock(); }
    } catch {
      // The stream ended badly; what it said up to here is all there is. Its own
      // error handling has already recorded the turn's failure.
    } finally {
      await finish(body ? outcome.finish(controller.signal.aborted) : { outcome: "failed", errorCode: "INTERNAL_ERROR" });
    }
  };
  const begin = () => runHolding(holder, () => start(controller.signal));

  // A place free now, or the turn waits for one.
  let queuedNow!: () => void;
  const waits = new Promise<"queued">(resolve => { queuedNow = () => resolve("queued"); });
  const acquiring = acquireSlot({
    priority: options.source === "chat" ? "foreground" : "background",
    signal: controller.signal,
    onWait: ahead => { turn.queued = true; queuedNow(); notify(turn, { state: "queued", ahead }); },
  });
  let first: (() => void) | "queued";
  try { first = await Promise.race([acquiring, waits]); }
  catch (error) {
    // Given up before it began (stopped at once): it leaves as a turn that could not start does.
    options.outer?.removeEventListener("abort", stopWithOuter);
    holder.ended = true;
    turn.done = true;
    if (registry.turns.get(chatId) === turn) registry.turns.delete(chatId);
    throw error;
  }

  if (first !== "queued") {
    release = first;
    let response: Response;
    try {
      response = await begin();
    } catch (error) {
      options.outer?.removeEventListener("abort", stopWithOuter);
      holder.ended = true;
      turn.done = true;
      release();
      if (registry.turns.get(chatId) === turn) registry.turns.delete(chatId);
      throw error;
    }
    turn.headers = new Headers(response.headers);
    // A conversation made for this turn is known by the id the service gave it.
    const madeId = turn.headers.get("x-chat-id");
    if (madeId && madeId !== chatId) {
      if (registry.turns.get(chatId) === turn) registry.turns.delete(chatId);
      turn.chatId = madeId;
      registry.turns.set(madeId, turn);
    }
    emit({ type: "turn-started", chatId: turn.chatId, source: options.source, queued: false });
    runHolding(holder, () => { void pump(response); });
    return new Response(follow(turn), { status: response.status, headers: turn.headers });
  }

  // Queued: the user's message is kept, and the response says the turn waits.
  try { await options.beforeQueue?.(); }
  catch (error) {
    controller.abort(error);
    await acquiring.catch(() => null).then(given => { if (typeof given === "function") given(); });
    holder.ended = true;
    turn.done = true;
    if (registry.turns.get(chatId) === turn) registry.turns.delete(chatId);
    throw error;
  }
  turn.headers = new Headers({ ...QUEUED_HEADERS, "x-chat-id": chatId });
  emit({ type: "turn-started", chatId, source: options.source, queued: true });
  void (async () => {
    try { release = await acquiring; }
    catch {
      // Given up while it waited: nothing ran, so nothing was written.
      append(turn, sse({ type: "abort" }));
      await finish({ outcome: "stopped" });
      return;
    }
    turn.queued = false;
    notify(turn, { state: "running" });
    emit({ type: "turn-running", chatId, source: options.source });
    let response: Response;
    try { response = await begin(); }
    catch (error) {
      const { code, message } = normalizeApiError(error);
      append(turn, sse({ type: "error", errorText: JSON.stringify({ error: { code, message } }) }));
      outcome.push(sse({ type: "error", errorText: JSON.stringify({ error: { code } }) }));
      await finish(outcome.finish(controller.signal.aborted));
      return;
    }
    const madeId = response.headers.get("x-chat-id");
    if (madeId && madeId !== turn.chatId) {
      if (registry.turns.get(turn.chatId) === turn) registry.turns.delete(turn.chatId);
      turn.chatId = madeId;
      registry.turns.set(madeId, turn);
    }
    runHolding(holder, () => { void pump(response); });
  })();
  return new Response(follow(turn), { status: 200, headers: turn.headers });
}

/** Attaches to the turn running in a conversation, from its start; null when none is. */
export function attachTurn(chatId: string): Response | null {
  const turn = registry.turns.get(chatId);
  if (!turn || turn.done || !turn.headers) return null;
  return new Response(follow(turn), { status: 200, headers: turn.headers });
}

/** Stops the turn running in a conversation, or takes it out of the queue. Whether one was there. */
export function stopTurn(chatId: string): boolean {
  const turn = registry.turns.get(chatId);
  if (!turn || turn.done) return false;
  turn.controller.abort(new DOMException("Stopped", "AbortError"));
  return true;
}
