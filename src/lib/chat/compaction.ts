import type { UIMessage } from "ai";
import { getTextFromUIMessage as readText } from "@/lib/ai/ui-message";
import { readAssistantSnapshot } from "@/lib/assistants/schema";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { COMPACTED_TAIL, contextBudget, estimateContextTokens, estimateTextTokens } from "@/lib/models/context-budget";
import { conversationCalibration } from "@/lib/models/context-calibration";
import { getModelPreferences, modelInLibrary, preferredModel } from "@/lib/models/preferences";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { runBackgroundDataOperation } from "@/lib/server/data-operations";
import { buildChatContext } from "./context";
import { latestContextReport } from "./context-report";
import { conversationWindow, storedFromSummary, storedSummary } from "./model-context";
import { summarizeOlderTurns, type SummaryResult } from "./summary";
import { createCompactionAllowance, type CompactionAllowance, type ConversationForSummary } from "./task-summary";

/**
 * Folding a conversation's older turns into its one summary, for whoever asks:
 * a finished turn nearing the limit, a request that cannot start without it, or
 * a person. At most one job runs per conversation. A job owns no conversation
 * state: its write is refused when the history moved on, and a process that exits
 * mid-job loses nothing, since the next finished turn starts over from storage.
 */

/**
 * Share of the window at which a finished turn folds, so the summary is usually
 * ready before a request reaches the limit and has to wait or fold mid-answer.
 */
const PRECOMPACT_SHARE = 0.85;
/** However large the latest turn was, folding does not start below this share. */
const PRECOMPACT_FLOOR = 0.5;
/** How near the trigger the next request may look before a finished turn folds; the look ahead is an estimate. */
const LOOKAHEAD_MARGIN = 0.95;

/** Consecutive failures before a conversation stops trying, and how far it must grow to try again. */
const FAILURES_BEFORE_PAUSE = 3, MESSAGES_BEFORE_RETRY = 10;
const MAX_TRACKED_FAILURES = 200;

type Failures = { count: number; atMessages: number };
const state = globalThis as typeof globalThis & { chatCompactions?: Map<string, Promise<SummaryResult>>; chatCompactionFailures?: Map<string, Failures> };
const jobs = state.chatCompactions ??= new Map<string, Promise<SummaryResult>>();
const failures = state.chatCompactionFailures ??= new Map<string, Failures>();

function startJob(chatId: string, work: () => Promise<SummaryResult>) {
  const job = (async () => {
    try { return await work(); }
    catch (error) {
      // Nothing awaits a job after a turn, so a failed log line must not become an unhandled rejection.
      try { console.error("chat.compaction.failed", normalizeApiError(error).code); } catch { /* the job's failure is already harmless */ }
      return null;
    }
    finally { jobs.delete(chatId); }
  })();
  jobs.set(chatId, job);
  return job;
}

/** A provider that keeps failing, or a summary that never fits, must not cost a call on every turn. */
const paused = (chatId: string, messages: number) => {
  const record = failures.get(chatId);
  return Boolean(record && record.count >= FAILURES_BEFORE_PAUSE && messages < record.atMessages + MESSAGES_BEFORE_RETRY);
};
function recordOutcome(chatId: string, messages: number, succeeded: boolean) {
  if (succeeded) { failures.delete(chatId); return; }
  const count = Math.min(FAILURES_BEFORE_PAUSE, (failures.get(chatId)?.count ?? 0) + 1);
  failures.delete(chatId);
  failures.set(chatId, { count, atMessages: messages });
  if (failures.size > MAX_TRACKED_FAILURES) failures.delete(failures.keys().next().value!);
}

const turnRecords = (messages: UIMessage[]) => messages.map(message => ({ id: message.id, role: message.role, text: readText(message) }));
const turnAllowance = async () => createCompactionAllowance((await getModelPreferences()).callLimits.compactionCallsPerTurn);

/**
 * After a turn: fold what the next request's window would drop. Deciding reads
 * only; a restore is held off from the point there is something to write, since
 * the model call can then take a while and ends in a write.
 */
export function compactAfterTurn(params: { chatId: string; modelRef: ModelRef; conversation?: () => ConversationForSummary | null }) {
  const { chatId, modelRef } = params;
  return jobs.get(chatId) ?? startJob(chatId, async () => {
    const model = await modelInLibrary("chat", modelRef);
    if (!model) return null;
    const { messages, anchor } = await storedFromSummary(chatId);
    if (paused(chatId, messages.length)) return null;
    const window = await conversationWindow(model, modelRef, messages);
    const stored = await storedSummary(chatId);
    const covered = new Set(stored?.state.calls);
    // The next turn is likely the size of this one. If that would not fit, fold now, so
    // that request finds the summary ready instead of waiting for it.
    let latestUser = 0;
    messages.forEach((message, index) => { if (message.role === "user") latestUser = index; });
    const latestTurn = estimateContextTokens(messages.slice(latestUser).map(message => message.parts.filter(part => !("toolCallId" in part && covered.has(part.toolCallId)))));
    const threshold = Math.max(window.maxTokens * PRECOMPACT_FLOOR, Math.min(window.maxTokens * PRECOMPACT_SHARE, window.maxTokens - latestTurn));
    // The window counts only the conversation. What the provider counted for the latest
    // request also includes the instructions and tool definitions, so it can see the
    // limit coming when the window cannot.
    const budget = contextBudget(model, (await getModelPreferences()).contextLimits[modelRefKey(modelRef)]);
    const report = latestContextReport(messages);
    const measured = report?.measuredInputTokens ?? report?.estimatedInputTokens;
    const reachesTrigger = measured !== undefined && measured + latestTurn * await conversationCalibration(modelRef, messages) >= budget.triggerTokens * LOOKAHEAD_MARGIN;
    const context = buildChatContext(messages, { ...window, maxMessages: messages.length, anchorMessageIds: anchor, toolRecords: { covered: stored?.state.calls },
      ...(reachesTrigger ? { maxTokens: Math.floor(window.maxTokens * COMPACTED_TAIL), refillRatio: 1 } : { maxTokens: Math.floor(threshold) }) });
    if (!context.omittedMessages) return null;
    const lastOlder = context.allMessages[context.omittedMessages - 1];
    if (stored?.coveredIds.includes(lastOlder.id)) return null;
    const allowance = await turnAllowance();
    const result = await runBackgroundDataOperation(() => summarizeOlderTurns({ chatId, messages: turnRecords(context.allMessages), keepRecent: context.messages.length, force: true, modelRef, allowance, conversation: params.conversation?.() ?? undefined }));
    recordOutcome(chatId, messages.length, Boolean(result));
    return result;
  });
}

/**
 * For a request whose older turns no summary covers at all: the one a job already
 * running will write, or a new one. It keeps going if the request is cancelled,
 * because the next request needs the same summary.
 */
export function compactForRequest(params: { chatId: string; messages: UIMessage[]; keepRecent: number; modelRef: ModelRef; allowance: CompactionAllowance }) {
  const { chatId, messages, keepRecent, modelRef, allowance } = params;
  const running = jobs.get(chatId);
  if (running) return running;
  if (paused(chatId, messages.length)) return Promise.resolve(null);
  return startJob(chatId, async () => {
    const result = await runBackgroundDataOperation(() => summarizeOlderTurns({ chatId, messages: turnRecords(messages), keepRecent, force: true, modelRef, allowance }));
    recordOutcome(chatId, messages.length, Boolean(result));
    return result;
  });
}

/**
 * A person asked: fold everything before the latest exchange, keeping what they
 * named. It tries even after failures, and says when it could not.
 */
export async function compactOnRequest(params: { chatId?: string | null; focus?: string }): Promise<{ status: "compacted" | "nothing"; freedTokens: number }> {
  const { chatId, focus } = params;
  if (!chatId) return { status: "nothing", freedTokens: 0 };
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: { assistantConfig: true } });
  if (!chat) throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
  // Waits out a running job, so what it wrote is what this one builds on.
  for (let running = jobs.get(chatId); running; running = jobs.get(chatId)) await running;
  const { messages } = await storedFromSummary(chatId);
  let latestUser = -1;
  messages.forEach((message, index) => { if (message.role === "user") latestUser = index; });
  const older = messages.slice(0, Math.max(0, latestUser));
  const lastOlder = older.at(-1);
  const before = await storedSummary(chatId);
  if (!lastOlder || before?.coveredIds.includes(lastOlder.id)) return { status: "nothing", freedTokens: 0 };
  const modelRef = await preferredModel("chat", readAssistantSnapshot(chat.assistantConfig)?.model);
  const allowance = await turnAllowance();
  const result = await startJob(chatId, () => runBackgroundDataOperation(() => summarizeOlderTurns({ chatId, messages: turnRecords(messages), keepRecent: messages.length - latestUser, force: true, modelRef, allowance, focus })));
  if (!result) throw new ApiError({ code: "UPSTREAM_FAILED", message: t("chat.compact.failed") });
  recordOutcome(chatId, messages.length, true);
  const freed = estimateContextTokens(older.map(message => message.parts)) + estimateTextTokens(before?.summary ?? "") - estimateTextTokens(result.summary);
  return { status: "compacted", freedTokens: Math.max(0, freed) };
}

/** Settles once no job is running; lets a caller that shuts down, or a test, wait them out. */
export async function compactionsSettled() {
  while (jobs.size) await Promise.all(jobs.values());
}
