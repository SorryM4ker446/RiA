import { db } from "@/db";
import { isTurnLive, onTurnEvent, stopTurn } from "@/lib/chat/live-turns";
import { awaitsApproval, runUnattendedTurn, type UnattendedOutcome } from "@/lib/chat/unattended";
import { hasReportToContinue, hasRunningBackgroundSubagents, onSubagentFinished, stopChatSubagents, takeSubagentReports } from "@/lib/agents/subagents";

/*
 * What happens to a background sub-agent's report once the turn that started it
 * has ended: the conversation is woken for a turn of its own, whose message is
 * an automatic notice carrying the reports. A turn still going takes them before
 * its next step instead (stream.ts), so this only acts on an idle conversation:
 * when a report arrives with no turn running, or when a turn ends with one waiting.
 *
 * It does not act while the conversation waits for the user to approve
 * something, since a new turn would pass that request by; the reports go with
 * the next request instead. Nor after a turn the user stopped, which stops the
 * sub-agents too, or one that failed.
 */

type State = {
  watching: boolean;
  /** Conversations a woken turn is being started or run for. */
  waking: Set<string>;
  /** Woken whenever a conversation's sub-agent work may have settled. */
  waiters: Map<string, Set<() => void>>;
  /** How the last woken turn of a conversation went, for a task waiting on it. */
  lastOutcome: Map<string, UnattendedOutcome>;
};
const state: State = ((globalThis as { __riaSubagentWake?: State }).__riaSubagentWake ??= { watching: false, waking: new Set(), waiters: new Map(), lastOutcome: new Map() });

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

/** The service starting a turn of the conversation with the reports waiting for it, if it is idle and there are any. */
async function wakeIfDue(chatId: string): Promise<void> {
  // The turn running now, or the one being woken, ends by looking again.
  if (state.waking.has(chatId) || isTurnLive(chatId)) return;
  state.waking.add(chatId);
  let failed = false;
  try {
    if (await awaitsApproval(chatId) || !(await hasReportToContinue(chatId))) return;
    const reports = await takeSubagentReports(chatId);
    if (!reports.text) return;
    // A task's conversation is one nobody is watching: its woken turn runs as the task's would.
    const task = await db.scheduledJob.findFirst({ where: { chatId }, select: { id: true } });
    const outcome = await runUnattendedTurn({
      chatId, text: reports.text, signal: new AbortController().signal, source: task ? "task" : "chat", callSource: task ? "scheduled" : "chat",
      notice: { kind: "subagents", titles: reports.titles.slice(0, 50).map(title => title.slice(0, 80)) },
    });
    state.lastOutcome.set(chatId, outcome);
  } catch {
    failed = true;
    console.error("subagent.wake.failed");
  } finally {
    state.waking.delete(chatId);
    // A report that came in while that turn was ending would otherwise wait for the next one. One that
    // could not be woken for stays for the next request rather than being tried again at once.
    if (!failed && await hasReportToContinue(chatId).catch(() => false) && !isTurnLive(chatId)) void wakeIfDue(chatId);
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
