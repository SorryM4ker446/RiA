import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_MAX_CONCURRENT } from "@/lib/models/preferences-schema";

/*
 * Places for work that talks to a model, shared by the whole service.
 *
 * How many there are is the "maximum concurrent calls" setting. A turn of a
 * conversation takes one place for as long as it runs, and everything that
 * turn does (its model steps, the summaries it writes, a search it makes) works
 * within that place instead of competing with it: a turn that has started is
 * never refused half way. Work outside any turn (an image, indexing a document)
 * takes a place for each call.
 *
 * With every place taken, work waits its turn instead of being refused. What
 * the user asked for goes before what runs in the background, and each kind in
 * the order it asked. Waiting can be given up (the signal), which leaves the
 * queue at once.
 */

export type SlotPriority = "foreground" | "background";
/** What a slot holder may be told while it waits or works: its place in the queue, or a retry under way. */
export type SlotNotice = { state: "queued"; ahead: number } | { state: "running" } | { state: "retrying"; attempt: number; seconds: number };

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

/** Work under way inside a held place: a turn, and the calls it makes. */
export type SlotHolder = { notify: (notice: SlotNotice) => void; ended: boolean };
const holders = new AsyncLocalStorage<SlotHolder>();

/** Runs `work` as the holder of a place, so the calls it makes, now or later in its course, use that place. */
export function runHolding<T>(holder: SlotHolder, work: () => T): T { return holders.run(holder, work); }

/** The place the current work holds, while it holds it. */
export function heldSlot(): SlotHolder | null {
  const holder = holders.getStore();
  return holder && !holder.ended ? holder : null;
}

/**
 * Runs one model call in a place: the current turn's when it is inside one,
 * otherwise a place of its own for as long as `call` takes. `release` in the
 * result gives back a place taken for a call whose work outlives `call` (a
 * stream); it does nothing for a turn's own place.
 */
export async function slotForCall(priority: SlotPriority, signal?: AbortSignal): Promise<{ release: () => void; own: boolean }> {
  if (heldSlot()) return { release: () => {}, own: false };
  return { release: await acquireSlot({ priority, signal }), own: true };
}
