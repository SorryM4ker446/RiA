import { db } from "@/db";
import { isTurnLive, onTurnEvent, stopTurn } from "@/lib/chat/live-turns";
import { awaitsApproval, runUnattendedTurn, type UnattendedOutcome } from "@/lib/chat/unattended";
import { hasReportToContinue, hasRunningBackgroundSubagents, onSubagentFinished, pendingSubagentReports, stopChatSubagents, undeliveredSubagentReports } from "@/lib/agents/subagents";

/*
 * What happens to a background sub-agent's report once the turn that started it
 * has ended: the conversation is woken for a turn of its own, whose message is
 * an automatic notice carrying the reports. A turn still going takes them before
 * its next step instead (stream.ts), so this only acts on an idle conversation:
 * when a report arrives with no turn running, or when a turn ends with one waiting.
 *
 * It does not act while the conversation waits for the user to approve
 * something, since a new turn would pass that request by; the reports stay
 * until the approval is answered (the turn that resumes takes them) or
 * declined (wakeForSubagentReports). Nor after a turn the user stopped, which
 * stops the sub-agents too, or one that failed.
 *
 * A report is given to the model once: it is marked delivered in the same
 * write that saves the message or answer carrying it, so a turn that fails
 * before that leaves it for the next chance, and two wakes never both send it.
 */

type State = {
  watching: boolean;
  /** Conversations a woken turn is being started or run for. */
  waking: Set<string>;
  /** Events that arrived while a wake was checking persisted state. */
  recheck: Set<string>;
  /** Woken whenever a conversation's sub-agent work may have settled. */
  waiters: Map<string, Set<() => void>>;
  /** How the last woken turn of a conversation went, for a task waiting on it. */
  lastOutcome: Map<string, UnattendedOutcome>;
};
const state: State = ((globalThis as { __riaSubagentWake?: State }).__riaSubagentWake ??= { watching: false, waking: new Set(), recheck: new Set(), waiters: new Map(), lastOutcome: new Map() });

function wakeWaiters(chatId: string) {
  const waiting = state.waiters.get(chatId);
  if (!waiting) return;
  state.waiters.delete(chatId);
  for (const resume of waiting) resume();
}

/** Starts listening for ended sub-agents and turns. Safe to call more than once. */
export function watchSubagentReports() {
  if (state.watching) return;
  state.watching = true;
  onSubagentFinished((chatId, outcome, background) => {
    if (background && (outcome.status === "done" || outcome.status === "failed")) void wakeIfDue(chatId);
    else wakeWaiters(chatId);
  });
  onTurnEvent(event => {
    if (event.type !== "turn-finished") return;
    if (event.outcome === "succeeded") void wakeIfDue(event.chatId);
    else wakeWaiters(event.chatId);
  });
}

/**
 * Wakes the conversation for reports left waiting, if it is idle and nothing
 * asks the user first: for a state change that lets it go on without a turn of
 * its own, such as the user declining a pending approval.
 */
export function wakeForSubagentReports(chatId: string) {
  watchSubagentReports();
  void wakeIfDue(chatId);
}

/** The service starting a turn of the conversation with the reports waiting for it, if it is idle and there are any. */
async function wakeIfDue(chatId: string): Promise<void> {
  if (state.waking.has(chatId)) {
    state.recheck.add(chatId);
    return;
  }
  // The live turn takes the reports at its next step or wakes them when it ends.
  if (isTurnLive(chatId)) return;
  state.waking.add(chatId);
  let delivered = false;
  try {
    if (await awaitsApproval(chatId) || !(await hasReportToContinue(chatId))) return;
    const reports = await pendingSubagentReports(chatId);
    if (!reports.text) return;
    // A task's conversation is one nobody is watching: its woken turn runs as the task's would.
    const task = await db.scheduledJob.findFirst({ where: { chatId }, select: { id: true } });
    // The reports count as given only once the notice carrying them is saved, in the same write.
    const outcome = await runUnattendedTurn({
      chatId, text: reports.text, signal: new AbortController().signal, source: task ? "task" : "chat", callSource: task ? "scheduled" : "chat",
      notice: { kind: "subagents", titles: reports.titles.slice(0, 50).map(title => title.slice(0, 80)) },
      deliverSubagents: reports.ids,
    });
    state.lastOutcome.set(chatId, outcome);
    // None of them saved (the turn could not start, its message could not be written, or an approval
    // came first): they wait for the next request or the next change that lets the conversation go
    // on, rather than being tried again at once. Some given by another reader first: the rest go now.
    delivered = outcome.status === "succeeded" && await undeliveredSubagentReports(reports.ids) < reports.ids.length;
  } catch {
    console.error("subagent.wake.failed");
  } finally {
    const recheck = state.recheck.delete(chatId);
    state.waking.delete(chatId);
    // Wait for a fresh event when approval blocks the wake or the write failed.
    if (recheck || delivered) void wakeIfDue(chatId);
    else wakeWaiters(chatId);
  }
}

/**
 * Waits until a conversation's background sub-agents have all ended and the
 * turns woken for their reports have run, for a task that counts as done only
 * then. Gives back how the last of those turns went, or null when none ran.
 * Stopping the task stops them.
 */
export async function settleSubagentWork(chatId: string, signal: AbortSignal): Promise<UnattendedOutcome | null> {
  watchSubagentReports();
  state.lastOutcome.delete(chatId);
  // A report left waiting is woken for once here; one a wake could not take stays for the next request.
  let woke = false;
  for (;;) {
    if (signal.aborted) { stopChatSubagents(chatId); stopTurn(chatId); return { status: "failed", errorCode: "ABORTED" }; }
    const working = hasRunningBackgroundSubagents(chatId) || state.waking.has(chatId) || isTurnLive(chatId);
    const due = !working && await hasReportToContinue(chatId) && !(await awaitsApproval(chatId));
    if (!working && (!due || woke)) break;
    await new Promise<void>(resolve => {
      const waiting = state.waiters.get(chatId) ?? new Set();
      const done = () => { waiting.delete(done); signal.removeEventListener("abort", done); resolve(); };
      waiting.add(done);
      state.waiters.set(chatId, waiting);
      signal.addEventListener("abort", done, { once: true });
      // A report due but not yet woken for (the turn that would take it had just ended) is woken now.
      if (due) { woke = true; void wakeIfDue(chatId); }
    });
  }
  const outcome = state.lastOutcome.get(chatId) ?? null;
  state.lastOutcome.delete(chatId);
  return outcome;
}
