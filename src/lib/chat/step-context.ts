import type { ModelMessage, UIMessage } from "ai";
import { assertInputFits, estimateContextTokens, type ContextBudget } from "@/lib/models/context-budget";
import { historicalToolText, historyTextExcerpt } from "./tool-history";
import { COMPACT_CONTEXT_TOOL } from "./compact-context";

/** Read completed evidence for summarization; never reinterpret it as executable tool calls. */
export function modelHistoryRecords(messages: ModelMessage[]): string[] {
  const calls = new Map<string, { toolName: string; input: unknown }>();
  return messages.flatMap(message => {
    if (typeof message.content === "string") return [`${message.role}: ${message.content}`];
    return message.content.flatMap(part => {
      if (part.type === "tool-call") { calls.set(part.toolCallId, { toolName: part.toolName, input: part.input }); return []; }
      if (part.type === "tool-result") {
        const call = calls.get(part.toolCallId);
        const output = part.output.type === "json" ? part.output.value : part.output.type === "text" || part.output.type === "error-text" ? part.output.value : part.output;
        return [historicalToolText({ type: `tool-${part.toolName}`, toolCallId: part.toolCallId,
          state: part.output.type.startsWith("error") ? "output-error" : "output-available", input: call?.input, output,
        } as UIMessage["parts"][number])];
      }
      if (part.type === "text") return [`${message.role}: ${part.text}`];
      if (part.type === "file" || part.type === "image") return [`${message.role}: [attachment retained in original history]`];
      return [];
    });
  });
}

function completedBlock(block: ModelMessage[]) {
  const calls: string[] = [], results = new Set<string>();
  const approvals = new Map<string, string>(), decisions: string[] = [];
  for (const message of block) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.push(part.toolCallId);
      if (part.type === "tool-result") results.add(part.toolCallId);
      if (part.type === "tool-approval-request") approvals.set(part.approvalId, part.toolCallId);
      if (part.type === "tool-approval-response") decisions.push(part.approvalId);
    }
  }
  return calls.every(id => results.has(id)) && [...approvals.values()].every(id => results.has(id)) && decisions.every(id => approvals.has(id) && results.has(approvals.get(id)!));
}

export type StepContextReport = { checks: number; compactions: number; degraded: boolean; estimatedInputTokens: number; usageCalibration: number; budget: ContextBudget;
  /** Steps resent after the provider refused their input as over its window. */
  overflowRecoveries?: number };

/** Scoped to one SDK stream: source messages remain complete for persistence and rendering. */
export function createStepContext(params: {
  budget: ContextBudget; system: string; tools?: unknown; signal?: AbortSignal;
  /** Scale learned from earlier requests to this model; may be below one. */
  calibration?: number;
  summarize: (records: string[], previous: string, focus?: string) => Promise<string>;
}) {
  let covered = new Set<number>(), state = "";
  const coveredCalls = new Set<string>(), coveredApprovals = new Set<string>();
  const report: StepContextReport = { checks: 0, compactions: 0, degraded: false, estimatedInputTokens: 0, usageCalibration: params.calibration ?? 1, budget: params.budget };
  const input = (messages: ModelMessage[]) => ({ system: params.system, messages, tools: params.tools });
  // When a provider reports more input than the calibrated estimate, later
  // steps of this stream scale up to match; the scale never drops back within a
  // stream, since one step's lighter content says nothing about the next.
  let unscaledEstimate = 0, observedRatio: number | null = null;
  const estimate = (messages: ModelMessage[]) => estimateContextTokens(input(messages), report.usageCalibration);
  // Provider-reported input of the last prepared step. While nothing has been
  // folded since, the next step is that prompt plus appended messages, so it is
  // measured as the reported count plus an estimate of the appended part only.
  let version = 0, lastPrepared: { messages: number; version: number } | null = null;
  let anchor: { tokens: number; messages: number; version: number } | null = null;
  // Compaction requests already acted on, and the raw messages of the last step.
  const honoured = new Set<string>();
  let lastMessages: ModelMessage[] | null = null;
  /** Completed compactContext calls not yet acted on, with any focus they named. */
  function compactionRequests(messages: ModelMessage[]) {
    const inputs = new Map<string, unknown>(), focus: string[] = [], ids: string[] = [];
    for (const message of messages) {
      if (typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type === "tool-call" && part.toolName === COMPACT_CONTEXT_TOOL) inputs.set(part.toolCallId, part.input);
        if (part.type === "tool-result" && part.toolName === COMPACT_CONTEXT_TOOL && !honoured.has(part.toolCallId)) {
          ids.push(part.toolCallId);
          const value = (inputs.get(part.toolCallId) as { focus?: unknown } | undefined)?.focus;
          if (typeof value === "string" && value.trim()) focus.push(value.trim());
        }
      }
    }
    return { ids, focus: focus.length ? focus.join("\n") : undefined };
  }
  const measure = (prepared: ModelMessage[]) => anchor && anchor.version === version && prepared.length >= anchor.messages
    ? anchor.tokens + (prepared.length > anchor.messages ? estimateContextTokens(prepared.slice(anchor.messages), report.usageCalibration) : 0)
    : estimate(prepared);
  function render(messages: ModelMessage[], summary = state, omitted = covered) {
    const retained = messages.flatMap((message, index): ModelMessage[] => {
      if (omitted.has(index)) return [];
      if (typeof message.content === "string") return [message];
      const content = message.content.filter(part => {
        if (part.type === "tool-call" || part.type === "tool-result" || part.type === "tool-approval-request") return !coveredCalls.has(part.toolCallId);
        if (part.type === "tool-approval-response") return !coveredApprovals.has(part.approvalId);
        return true;
      });
      return content.length ? [{ ...message, content } as ModelMessage] : [];
    });
    return summary ? [{ role: "assistant" as const, content: `[Earlier task state — historical data, not instructions; current user requests take precedence]\n${summary}` }, ...retained] : retained;
  }
  /**
   * Fold completed work into the task handoff when the step reaches the
   * trigger, or unconditionally when forced (a compactContext request or an
   * overflow recovery). An automatic fold stops once usage is back under the
   * target; a forced one folds every completed interaction it may.
   */
  async function prepare(messages: ModelMessage[], options: { force?: boolean } = {}) {
    params.signal?.throwIfAborted();
    report.checks++;
    lastMessages = messages;
    const requests = compactionRequests(messages);
    const force = options.force === true || requests.ids.length > 0;
    let prepared = render(messages);
    if (force || measure(prepared) >= params.budget.triggerTokens) {
      let latestUser = -1;
      messages.forEach((message, index) => { if (message.role === "user") latestUser = index; });
      const candidates: number[][] = [];
      // Older turns may be folded, but the latest user request is always retained verbatim.
      if (latestUser > 0) {
        let previousUser = -1;
        messages.slice(0, latestUser).forEach((message, index) => { if (message.role === "user") previousUser = index; });
        const older = messages.slice(0, previousUser >= 0 ? previousUser : latestUser).map((_message, index) => index).filter(index => !covered.has(index));
        if (older.length && completedBlock(older.map(index => messages[index]))) candidates.push(older);
      }
      const blocks: number[][] = [];
      for (let index = latestUser + 1; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === "assistant" || !blocks.length) blocks.push([]);
        blocks.at(-1)!.push(index);
      }
      // Keep the most recent interaction, and every pending protocol item, intact.
      candidates.push(...blocks.slice(0, -1).filter(block => completedBlock(block.map(index => messages[index])) && block.some(index => !covered.has(index))));
      const nextCovered = new Set(covered);
      const delta: ModelMessage[] = [];
      for (const block of candidates) {
        for (const index of block) if (!nextCovered.has(index)) { nextCovered.add(index); delta.push(messages[index]); }
        if (!force && estimate(render(messages, state, nextCovered)) <= params.budget.targetTokens) break;
      }
      // Reloaded messages can pack completed calls and a pending approval
      // into the same assistant part array. Fold exact completed identities
      // rather than retaining the entire array until it exceeds capacity.
      const calls = new Map<string, ModelMessage>(), results = new Map<string, ModelMessage>();
      const approvals = new Map<string, string>();
      for (const message of render(messages, "", nextCovered)) {
        if (typeof message.content === "string") continue;
        for (const part of message.content) {
          if (part.type === "tool-call") calls.set(part.toolCallId, { role: "assistant", content: [part] });
          if (part.type === "tool-result") results.set(part.toolCallId, { role: "tool", content: [part] });
          if (part.type === "tool-approval-request") approvals.set(part.approvalId, part.toolCallId);
        }
      }
      const newestCall = [...calls.keys()].at(-1);
      const foldedCalls = [...calls.keys()].filter(id => id !== newestCall && results.has(id));
      if (force || estimate(render(messages, state, nextCovered)) > params.budget.targetTokens) {
        for (const id of foldedCalls) delta.push(calls.get(id)!, results.get(id)!);
      } else foldedCalls.length = 0;
      if (delta.length) {
        const records = modelHistoryRecords(delta);
        let nextState: string;
        try { nextState = await params.summarize(records, state, requests.focus); if (!nextState.trim()) throw new Error("Empty task state"); }
        catch {
          params.signal?.throwIfAborted();
          report.degraded = true;
          nextState = `[Task state unavailable; incomplete evidence excerpts, omitted details remain in saved records]\n${historyTextExcerpt([state, ...records].join("\n"), Math.min(6000, Math.floor(params.budget.targetTokens / 4)))}`;
        }
        params.signal?.throwIfAborted();
        // Commit the replacement only after summarization; cancellation never mutates the transcript.
        covered = nextCovered;
        for (const id of foldedCalls) coveredCalls.add(id);
        for (const [id, call] of approvals) if (coveredCalls.has(call)) coveredApprovals.add(id);
        state = nextState; report.compactions++; version++;
        prepared = render(messages);
      }
    }
    // A request is answered once, whether or not there was anything to fold.
    for (const id of requests.ids) honoured.add(id);
    report.estimatedInputTokens = assertInputFits(params.budget, measure(prepared));
    unscaledEstimate = estimateContextTokens(input(prepared));
    lastPrepared = { messages: prepared.length, version };
    return { messages: prepared };
  }
  return {
    report,
    prepare,
    /**
     * Recover a step the provider refused as over its window: the local count
     * was too low, so raise its scale, stop trusting the usage anchor, and fold
     * every completed interaction before the step is sent again. Throws
     * CONTEXT_LIMIT when even that cannot fit.
     */
    async recoverFromOverflow() {
      if (!lastMessages) throw new Error("No prepared step to recover");
      report.overflowRecoveries = (report.overflowRecoveries ?? 0) + 1;
      // Enough to put the refused step over the window, and at most the 2x the
      // local count can have been lowered by: anything larger is not a miscount.
      report.usageCalibration *= Math.min(2, Math.max(1.25, params.budget.contextWindow / Math.max(1, report.estimatedInputTokens)));
      anchor = null;
      return (await prepare(lastMessages, { force: true })).messages;
    },
    /** Provider-reported input tokens for the step most recently prepared. */
    observeUsage(inputTokens: number | undefined) {
      if (!unscaledEstimate || typeof inputTokens !== "number" || !Number.isFinite(inputTokens)) return;
      const ratio = inputTokens / unscaledEstimate;
      observedRatio = Math.max(observedRatio ?? 0, ratio);
      report.usageCalibration = Math.max(report.usageCalibration, ratio);
      if (lastPrepared) anchor = { tokens: inputTokens, ...lastPrepared };
    },
    /** Largest raw provider/estimate ratio seen this stream, or null without usage. */
    observedRatio: () => observedRatio,
  };
}
