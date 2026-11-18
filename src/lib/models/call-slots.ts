import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_MAX_CONCURRENT } from "@/lib/models/preferences-schema";

/*
 * Places for model calls in flight, shared by the whole service.
 *
 * How many there are is the "maximum concurrent calls" setting. A place is
 * taken by one model call for as long as that call is in flight and given back
 * when it is recorded as ended. A turn holds no place of its own: while its
 * tools run (a build, a command, a search) it holds none, so a long-running
 * task never keeps the person's next message waiting for more than one call.
 *
 * With every place taken, a call waits its turn instead of being refused. What
 * the user asked for goes before what runs in the background, and each kind in
 * the order it asked. Waiting can be given up (the signal), which leaves the
 * queue at once. A call made inside a turn tells that turn while it waits, so
 * its stream can say it is queued.
 */

export type SlotPriority = "foreground" | "background";
/** What a turn may be told while its calls wait or work: their place in the queue, or a retry under way. */
export type SlotNotice = { state: "queued"; ahead: number } | { state: "running" } | { state: "retrying"; attempt: number; seconds: number }
  // An Auto approval review of a tool call is under way.
  | { state: "reviewing" };

type Waiter = { priority: SlotPriority; grant: () => void; onWait?: (ahead: number) => void };
type Slots = { inUse: number; queue: Waiter[]; capacity: () => Promise<number> };

const slots: Slots = ((globalThis as { __riaCallSlots?: Slots }).__riaCallSlots ??= {
  inUse: 0,
  queue: [],
  capacity: async () => (await import("@/lib/models/preferences")).getModelPreferences().then(settings => settings.callLimits.maxConcurrent),
});
/** Places when the setting cannot be read: the default, rather than none. */
const FALLBACK_CAPACITY = DEFAULT_MAX_CONCURRENT;

/** For tests: how many places there are, read whenever a place is asked for or given back. */
export function setSlotCapacity(capacity: () => Promise<number>) { slots.capacity = capacity; }

/** Places in use and work waiting, for whoever reports on it. */
export function slotUsage() { return { inUse: slots.inUse, waiting: slots.queue.length }; }

const rank = (priority: SlotPriority) => (priority === "foreground" ? 0 : 1);

function tellPositions() {
  slots.queue.forEach((waiter, index) => waiter.onWait?.(index));
}

/** Gives free places to the work waiting longest at the highest priority. */
async function grant() {
  // Nobody waiting: nothing to give, and no need to read the setting.
  if (!slots.queue.length) return;
  const capacity = Math.max(1, await slots.capacity().catch(() => FALLBACK_CAPACITY));
  let moved = false;
  while (slots.inUse < capacity && slots.queue.length) {
    const next = slots.queue.shift()!;
    slots.inUse++;
    moved = true;
    next.grant();
  }
  if (moved) tellPositions();
}

/**
 * Takes a place, waiting for one when all are taken. Resolves to the function
 * that gives it back (calling it twice gives back one place). `onWait` hears how
 * many are ahead, each time that changes; it is never called when a place is
 * free at once.
 */
export async function acquireSlot(options: { priority: SlotPriority; signal?: AbortSignal; onWait?: (ahead: number) => void }): Promise<() => void> {
  options.signal?.throwIfAborted();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slots.inUse = Math.max(0, slots.inUse - 1);
    void grant();
  };
  // With nothing running and nobody waiting a place is free whatever the limit
  // (there is always at least one), so the setting is read only when it can matter.
  if (slots.inUse === 0 && !slots.queue.length) {
    slots.inUse++;
    return release;
  }
  const capacity = Math.max(1, await slots.capacity().catch(() => FALLBACK_CAPACITY));
  options.signal?.throwIfAborted();
  // Free, and nobody of the same or higher priority is waiting for it.
  if (slots.inUse < capacity && !slots.queue.some(waiter => rank(waiter.priority) <= rank(options.priority))) {
    slots.inUse++;
    return release;
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { priority: options.priority, onWait: options.onWait, grant: () => { options.signal?.removeEventListener("abort", abort); resolve(release); } };
    const abort = () => {
      const index = slots.queue.indexOf(waiter);
      if (index < 0) return;
      slots.queue.splice(index, 1);
      tellPositions();
      reject(options.signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    // After every waiter of the same or higher priority, before any lower one.
    const at = slots.queue.findIndex(other => rank(other.priority) > rank(options.priority));
    if (at < 0) slots.queue.push(waiter); else slots.queue.splice(at, 0, waiter);
    options.signal?.addEventListener("abort", abort, { once: true });
    tellPositions();
    // A place may have come free while this was being queued.
    void grant();
  });
}

/** Places taken for single calls, by attempt, until the attempt is recorded as ended. */
const attemptSlots: Map<string, () => void> = ((globalThis as { __riaAttemptSlots?: Map<string, () => void> }).__riaAttemptSlots ??= new Map());

/** Keeps the place a call took until that call is recorded. */
export function holdForAttempt(attemptId: string, release: () => void) { attemptSlots.set(attemptId, release); }

/** Gives back the place an attempt took, if it took one of its own. */
export function releaseForAttempt(attemptId: string | undefined) {
  if (!attemptId) return;
  const release = attemptSlots.get(attemptId);
  attemptSlots.delete(attemptId);
  release?.();
}

/** A turn under way, which the calls it makes tell when they wait for a place or retry. */
export type TurnContext = {
  notify: (notice: SlotNotice) => void;
  ended: boolean;
  /** Calls of this turn waiting for a place now; the turn reads as queued while there are any. */
  waiting?: number;
};
const turns = new AsyncLocalStorage<TurnContext>();

/** Runs `work` as part of a turn, so the calls it makes, now or later in its course, tell that turn. */
export function runInTurn<T>(turn: TurnContext, work: () => T): T { return turns.run(turn, work); }

/** The turn the current work belongs to, while it runs. */
export function currentTurn(): TurnContext | null {
  const turn = turns.getStore();
  return turn && !turn.ended ? turn : null;
}

/**
 * A place for one model call, waited for when all are taken. `release` gives
 * it back; the caller holds it while the call is in flight (see holdForAttempt).
 * Inside a turn, the turn hears while the call waits, and that it runs once
 * none of its calls wait any more.
 */
export async function slotForCall(priority: SlotPriority, signal?: AbortSignal): Promise<{ release: () => void }> {
  const turn = currentTurn();
  let waited = false;
  try {
    return { release: await acquireSlot({ priority, signal, ...(turn ? { onWait: (ahead: number) => {
      if (!waited) { waited = true; turn.waiting = (turn.waiting ?? 0) + 1; }
      turn.notify({ state: "queued", ahead });
    } } : {}) }) };
  } finally {
    if (turn && waited) {
      turn.waiting = Math.max(0, (turn.waiting ?? 1) - 1);
      if (turn.waiting === 0 && !turn.ended) turn.notify({ state: "running" });
    }
  }
}
