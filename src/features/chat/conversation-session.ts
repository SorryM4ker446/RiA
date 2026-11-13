import { Chat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type ChatTransport, type UIMessage } from "ai";
import { chatApi } from "@/features/chat/api-client";
import { clearChatDraft, readChatDraft, writeChatDraft } from "@/features/chat/draft";
import { mapStoredMessagesToUI, type TurnNotice, type UploadableFilePart } from "@/features/chat/page-utils";

/*
 * One conversation as this window holds it.
 *
 * Everything that belongs to a conversation rather than to the page lives
 * here: its chat client (the messages and the answer being read), what is
 * being written in its message box, the messages queued behind its answer, the
 * notice its turn last gave, how far its history has been read, and the images
 * and videos its messages show. The page shows one session at a time and
 * switching conversations is switching sessions: nothing has to be parked when
 * leaving one or brought back when returning, and what happens in a
 * conversation while another is open (its answer streaming, a send failing)
 * lands in its own session.
 *
 * A session is plain state with listeners, read by the page through
 * `useSyncExternalStore`, so it can be tested without React.
 */

/** The new conversation before it has an id: never kept, it starts empty each time. */
export const DRAFT_CHAT = "draft";

/** A message written while its conversation was answering, waiting to be sent. */
export type QueuedMessage = { id: string; text: string; attachments: UploadableFilePart[] };
/** What the message box holds. */
export type ComposerDraft = { text: string; attachments: UploadableFilePart[] };
/** idle: not read yet; loading: the first read is under way; ready: read; error: could not be read. */
export type HistoryState = "idle" | "loading" | "ready" | "error";

export type SessionState = {
  history: HistoryState;
  olderCursor: string | null;
  loadingOlder: boolean;
  /** Waiting for a place, or the provider being retried: said until the turn moves on. */
  notice: TurnNotice | null;
  /** The service is folding older turns before it can answer. */
  organizing: boolean;
  draft: ComposerDraft;
  queue: QueuedMessage[];
  images: Record<string, string>;
  videos: Record<string, string>;
};

const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };
const QUEUE_STORAGE_KEY = "ria.chat.queue";
/** Enough to keep writing; the queue is not a place to park a backlog. */
export const MAX_QUEUED = 10;

function readQueues(): Record<string, QueuedMessage[]> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(QUEUE_STORAGE_KEY) ?? "{}") as Record<string, QueuedMessage[]>;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function writeQueue(chatId: string, queue: QueuedMessage[]) {
  if (typeof window === "undefined") return;
  const queues = readQueues();
  if (queue.length) queues[chatId] = queue; else delete queues[chatId];
  try { window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queues)); } catch { /* Kept for this visit only. */ }
}

/** A send that could not go because the conversation's history could not be read. */
export class HistoryUnavailableError extends Error {
  constructor() { super("The conversation's history could not be read"); this.name = "HistoryUnavailableError"; }
}

export const isAnswering = (chat: Chat<UIMessage>) => chat.status === "submitted" || chat.status === "streaming";

/**
 * The saved history, with every message that says the same as the one shown
 * kept as that object; the shown list itself when nothing differs.
 */
export function keepUnchanged(shown: UIMessage[], saved: UIMessage[]): UIMessage[] {
  const byId = new Map(shown.map(message => [message.id, message]));
  let changed = shown.length !== saved.length;
  const merged = saved.map((message, index) => {
    const old = byId.get(message.id);
    if (old && JSON.stringify(old) === JSON.stringify(message)) {
      if (shown[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return message;
  });
  return changed ? merged : shown;
}

/** Where the history is read from; the service's, unless a test gives another. */
export type HistorySource = (chatId: string, cursor?: string) => Promise<{ data?: unknown[]; pageInfo?: { nextCursor?: string | null } }>;

export class ConversationSession {
  readonly id: string;
  readonly chat: Chat<UIMessage>;
  private state: SessionState;
  private readonly listeners = new Set<() => void>();
  private readonly readHistory: HistorySource;
  private historyRequest = 0;
  private olderInFlight = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private hydrated = false;
  /** Typed in this visit (not only read back from storage): it moves with the user when the conversation is created. */
  private typedHere = false;
  /** Sends whose request failed, by the user message they carried. */
  private readonly failedSends = new Set<string>();
  /**
   * Sends the service answered, by the user message they carried. The service
   * keeps a message before it answers, so a send it answered is in the
   * conversation even if its answer is cut short later (stopped, or the page
   * reloaded): that is not a send to write again.
   */
  private readonly acceptedSends = new Set<string>();
  private readonly historyWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  /** This window reads the turn under way: its own, or one it attached to. */
  private following = false;
  /** Its history has been read from the service at least once (one made here, new, has none to read). */
  private readOnce = false;

  constructor(id: string, transport: ChatTransport<UIMessage>, options: { history?: HistoryState; readHistory?: HistorySource } = {}) {
    this.id = id;
    this.readHistory = options.readHistory ?? ((chatId, cursor) => chatApi.listMessages(chatId, cursor));
    this.state = {
      history: options.history ?? (id === DRAFT_CHAT ? "ready" : "idle"),
      olderCursor: null, loadingOlder: false, notice: null, organizing: false,
      draft: EMPTY_DRAFT, queue: [], images: {}, videos: {},
    };
    const accepted = this.acceptedSends;
    this.chat = new Chat<UIMessage>({
      id,
      transport: {
        async sendMessages(request) {
          const stream = await transport.sendMessages(request);
          const sent = request.messages.at(-1);
          if (request.trigger === "submit-message" && sent?.role === "user") accepted.add(sent.id);
          return stream;
        },
        reconnectToStream: request => transport.reconnectToStream(request),
      },
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onData: part => {
        if (part.type === "data-turn-status") this.noteNotice(part.data as TurnNotice | { state: "running" });
        if (part.type === "data-context-status") this.set({ organizing: (part.data as { organizing: boolean }).organizing });
      },
      onFinish: ({ messages, isError }) => {
        this.noteNotice({ state: "running" });
        this.set({ organizing: false });
        if (!isError) return;
        const latestUser = [...messages].reverse().find(message => message.role === "user");
        if (latestUser) this.failedSends.add(latestUser.id);
      },
    });
  }

  // --- listening ---------------------------------------------------------------------------

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.state;

  private set(patch: Partial<SessionState>) {
    const next = { ...this.state, ...patch };
    if (Object.keys(patch).every(key => next[key as keyof SessionState] === this.state[key as keyof SessionState])) return;
    const historyChanged = next.history !== this.state.history;
    this.state = next;
    if (historyChanged) this.settleHistoryWaiters();
    for (const listener of [...this.listeners]) listener();
  }

  /** Reads what this browser kept for it (draft, queue), once, after the page has mounted. */
  hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    const stored = readChatDraft(this.storageId);
    const queue = this.id === DRAFT_CHAT ? [] : readQueues()[this.id] ?? [];
    // Something written before this ran (a draft moved in) is newer than what was stored.
    const draft = this.hasDraft ? this.state.draft : stored ? { text: stored.text, attachments: stored.attachments } : EMPTY_DRAFT;
    this.set({ draft, queue });
  }

  private get storageId() { return this.id === DRAFT_CHAT ? null : this.id; }

  // --- the message box ------------------------------------------------------------------------

  /** Whether its history was ever read from the service: one made here, new, has nothing there to check against. */
  get historyRead() { return this.readOnce; }

  get hasDraft() { return this.state.draft.text.length > 0 || this.state.draft.attachments.length > 0; }
  get draftTypedHere() { return this.typedHere; }

  /** What the user writes (or attaches); kept in this browser like any draft. */
  setDraft(change: ComposerDraft | ((current: ComposerDraft) => ComposerDraft), options: { typed?: boolean } = {}) {
    const draft = typeof change === "function" ? change(this.state.draft) : change;
    if (draft.text === this.state.draft.text && draft.attachments === this.state.draft.attachments) return;
    if (options.typed !== false) this.typedHere = true;
    this.set({ draft });
    if (draft.text || draft.attachments.length) writeChatDraft(this.storageId, draft);
    else clearChatDraft(this.storageId);
  }

  /** Empties the message box for a send, returning what it held. */
  takeDraft(): ComposerDraft {
    const taken = this.state.draft;
    this.typedHere = false;
    this.setDraft(EMPTY_DRAFT, { typed: false });
    return taken;
  }

  /** A send that did not reach the service: what it said goes back, unless something new was written meanwhile. */
  restoreDraft(draft: ComposerDraft) {
    if (this.hasDraft) return false;
    this.setDraft(draft, { typed: false });
    return true;
  }

  // --- queued messages ------------------------------------------------------------------------

  setQueue(change: (current: QueuedMessage[]) => QueuedMessage[]) {
    const queue = change(this.state.queue);
    if (queue === this.state.queue) return;
    this.set({ queue });
    if (this.id !== DRAFT_CHAT) writeQueue(this.id, queue);
  }

  // --- notices --------------------------------------------------------------------------------

  private noteNotice(notice: TurnNotice | { state: "running" }) {
    clearTimeout(this.noticeTimer);
    if (notice.state === "running") { this.set({ notice: null }); return; }
    this.set({ notice });
    // A retry says how long it waits; after that the call is under way again.
    if (notice.state === "retrying") this.noticeTimer = setTimeout(() => this.set({ notice: null }), notice.seconds * 1000);
  }

  // --- history --------------------------------------------------------------------------------

  /**
   * Reads the conversation's saved history. `quiet` is for a conversation shown
   * at once from what this window kept: it stays shown and usable while the
   * history is read, which then replaces it only if nothing happened in it
   * meanwhile and it is not answering (an answer being read is newer than
   * anything saved), and only where it differs. Resolves to the error, if the
   * read failed.
   */
  async loadHistory(options: { quiet?: boolean } = {}): Promise<{ error?: unknown }> {
    if (this.id === DRAFT_CHAT) return {};
    const request = ++this.historyRequest;
    const before = this.chat.messages;
    this.olderInFlight = false;
    this.set({ olderCursor: null, loadingOlder: false, ...(options.quiet ? {} : { history: "loading" as const }) });
    try {
      const payload = await this.readHistory(this.id);
      if (request !== this.historyRequest) return {};
      const mapped = mapStoredMessagesToUI((payload.data ?? []) as Parameters<typeof mapStoredMessagesToUI>[0]);
      if (!options.quiet) this.chat.messages = mapped.uiMessages;
      else if (this.chat.messages === before && !isAnswering(this.chat)) {
        const merged = keepUnchanged(before, mapped.uiMessages);
        if (merged !== before) this.chat.messages = merged;
      }
      this.readOnce = true;
      this.set({ images: mapped.imageMap, videos: mapped.videoMap, olderCursor: payload.pageInfo?.nextCursor ?? null, history: "ready" });
      return {};
    } catch (error) {
      if (request !== this.historyRequest) return {};
      if (!options.quiet) this.set({ history: "error" });
      return { error };
    }
  }

  /** The page of history before what is shown. */
  async loadOlder(): Promise<{ error?: unknown }> {
    const cursor = this.state.olderCursor;
    if (!cursor || this.olderInFlight || this.state.history !== "ready") return {};
    const request = this.historyRequest;
    this.olderInFlight = true;
    this.set({ loadingOlder: true });
    try {
      const page = await this.readHistory(this.id, cursor);
      if (request !== this.historyRequest) return {};
      const mapped = mapStoredMessagesToUI((page.data ?? []) as Parameters<typeof mapStoredMessagesToUI>[0]);
      const current = this.chat.messages;
      this.chat.messages = [...mapped.uiMessages.filter(message => !current.some(item => item.id === message.id)), ...current];
      this.set({ images: { ...mapped.imageMap, ...this.state.images }, videos: { ...mapped.videoMap, ...this.state.videos }, olderCursor: page.pageInfo?.nextCursor ?? null });
      return {};
    } catch (error) {
      return request === this.historyRequest ? { error } : {};
    } finally {
      if (request === this.historyRequest) { this.olderInFlight = false; this.set({ loadingOlder: false }); }
    }
  }

  /**
   * Adds what was written since it was read (a task's run, another window):
   * only turns after the last one shown, and nothing while a turn is being read here.
   */
  async addNewTurns() {
    if (this.state.history !== "ready" || isAnswering(this.chat)) return;
    const payload = await this.readHistory(this.id).catch(() => null);
    if (!payload || isAnswering(this.chat)) return;
    const mapped = mapStoredMessagesToUI((payload.data ?? []) as Parameters<typeof mapStoredMessagesToUI>[0]);
    const current = this.chat.messages;
    const known = new Set(current.map(message => message.id));
    let lastShared = -1;
    mapped.uiMessages.forEach((message, index) => { if (known.has(message.id)) lastShared = index; });
    // Without a turn in common the page and the store disagree on more than new turns; leave it as it is.
    if (lastShared >= 0) {
      const added = mapped.uiMessages.slice(lastShared + 1).filter(message => !known.has(message.id));
      if (added.length) this.chat.messages = [...current, ...added];
    }
    this.set({ images: { ...mapped.imageMap, ...this.state.images }, videos: { ...mapped.videoMap, ...this.state.videos } });
  }

  private settleHistoryWaiters() {
    if (this.state.history !== "ready" && this.state.history !== "error") return;
    const failed = this.state.history === "error";
    for (const waiter of this.historyWaiters.splice(0)) {
      if (failed) waiter.reject(new HistoryUnavailableError()); else waiter.resolve();
    }
  }

  /** Until the history shown is the saved one: a send before that would be replaced by it. */
  private historyReady(): Promise<void> {
    if (this.state.history === "ready") return Promise.resolve();
    if (this.state.history === "error") return Promise.reject(new HistoryUnavailableError());
    if (this.state.history === "idle") void this.loadHistory();
    return new Promise((resolve, reject) => this.historyWaiters.push({ resolve, reject }));
  }

  // --- media ----------------------------------------------------------------------------------

  setAsset(kind: "image" | "video", messageId: string, url: string) {
    if (kind === "image") this.set({ images: { ...this.state.images, [messageId]: url } });
    else this.set({ videos: { ...this.state.videos, [messageId]: url } });
  }

  // --- sending and following ------------------------------------------------------------------

  /**
   * Sends a message once the history shown is the saved one. Resolves to whether
   * the send failed: the service refused it, or it never got there. A send the
   * service answered has not failed, however its answer ended (stopped, cut off
   * by a reload, an error part way): the message is in the conversation. Rejects
   * when the history cannot be read.
   */
  async send(message: UIMessage, options: Parameters<Chat<UIMessage>["sendMessage"]>[1], hooks: { onStarted?: () => void } = {}): Promise<boolean> {
    await this.historyReady();
    this.following = true;
    hooks.onStarted?.();
    await this.chat.sendMessage(message, options);
    const failed = this.failedSends.delete(message.id) && !this.acceptedSends.has(message.id);
    this.acceptedSends.delete(message.id);
    return failed;
  }

  /**
   * Keeps this window reading the turn the service runs here. `answering` is the
   * service's word for it. A turn this window is already reading (its own, or
   * one it attached to) is not attached to again, also not in the moment after
   * it ended while the service is still said to be answering.
   */
  follow(answering: boolean) {
    if (isAnswering(this.chat)) { this.following = true; return; }
    if (!answering) { this.following = false; return; }
    if (this.state.history !== "ready" || this.following) return;
    this.following = true;
    void this.chat.resumeStream().catch(() => { /* Nothing to attach to: the turn ended; its answer is read from what was saved. */ });
  }

  /** A turn someone else started here, heard while this window was not reading one: it is new, so it can be followed. */
  othersTurnStarted() {
    if (!isAnswering(this.chat)) this.following = false;
  }

  /** Stops reading here (the service goes on with the answer) and lets go of timers. */
  dispose() {
    clearTimeout(this.noticeTimer);
    if (isAnswering(this.chat)) void this.chat.stop();
    for (const waiter of this.historyWaiters.splice(0)) waiter.reject(new HistoryUnavailableError());
  }
}

// --- the sessions this window keeps ------------------------------------------------------------

/*
 * Switching away from a conversation that is answering does not stop reading
 * its answer: its session goes on taking the stream in the background, so
 * coming back shows the answer exactly where it has got to, still moving, with
 * nothing to load or replay. A conversation that is not answering is kept as
 * it was last seen, so going back to it is instant too; the page then checks
 * it against what is saved.
 *
 * Both are bounded. Each answer read in the background holds a connection to
 * the service, and a browser allows only a few per host (six, one of which the
 * conversation events already use), so at most BACKGROUND_READERS are read
 * while another conversation is open; past that the one looked at least
 * recently stops being read here and is read again from the service, merged,
 * when it is opened. The service holds every answer either way: leaving one
 * never stops it. Drafts and queues are kept in the browser, so letting a
 * session go loses neither.
 */

/** Answers read in the background while another conversation is open. */
const BACKGROUND_READERS = 2;
/** Conversations kept as last seen, not answering, for going back to them at once. */
const KEPT_IDLE = 6;

type Entry = { session: ConversationSession; seenAt: number };
const kept = new Map<string, Entry>();
let active: string | null = null;
let clock = 0;

/**
 * The session for a conversation, made with `make` when none is kept.
 * `reused` says it was already here: what it shows is what it showed before.
 * Only the browser keeps sessions; a server render makes one for the moment.
 */
export function sessionFor(id: string, make: () => ConversationSession): { session: ConversationSession; reused: boolean } {
  if (id === DRAFT_CHAT || typeof window === "undefined") return { session: make(), reused: false };
  const entry = kept.get(id);
  if (entry) { entry.seenAt = ++clock; return { session: entry.session, reused: true }; }
  const session = make();
  kept.set(id, { session, seenAt: ++clock });
  return { session, reused: false };
}

/** The session kept for a conversation, if this window keeps one. */
export function keptSession(id: string): ConversationSession | undefined {
  return kept.get(id)?.session;
}

/** The conversation open now (null: none), and whatever the others are kept to. */
export function openSession(id: string | null) {
  active = id === DRAFT_CHAT ? null : id;
  if (active) { const entry = kept.get(active); if (entry) entry.seenAt = ++clock; }
  const others = [...kept.entries()].filter(([key]) => key !== active).sort((a, b) => b[1].seenAt - a[1].seenAt);
  let readers = 0, idle = 0;
  for (const [key, entry] of others) {
    if (isAnswering(entry.session.chat)) {
      if (++readers <= BACKGROUND_READERS) continue;
      entry.session.dispose();
      kept.delete(key);
    } else if (++idle > KEPT_IDLE) {
      entry.session.dispose();
      kept.delete(key);
    }
  }
}

/** A conversation that is gone (deleted, archived): nothing of it is kept. */
export function forgetSession(id: string) {
  const entry = kept.get(id);
  if (!entry) return;
  kept.delete(id);
  entry.session.dispose();
}

/** For tests and diagnostics: which conversations are kept, and which of them are being read. */
export function keptSessions() {
  return [...kept.entries()].map(([id, entry]) => ({ id, answering: isAnswering(entry.session.chat) }));
}
