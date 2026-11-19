import { generateText } from "ai";
import { getChatModel } from "@/lib/ai/client";
import { withModelCallSource, type CallSource } from "@/lib/models/call-context";
import { getModelPreferences, internalAgentModel } from "@/lib/models/preferences";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";

/*
 * Internal sub-agents: the work RiA does around a turn — the approval review
 * under Auto, context and task summaries, long-term memory, search planning.
 *
 * Their contract: the application starts them, never the model; their
 * instructions are fixed; they get no tools; and what they read is put together
 * by the application, so content in a conversation (a page, a file, a tool
 * result) cannot steer them into doing anything. They run on the internal
 * sub-agent model when one is chosen, and once more on the model the work is
 * for if that fails, within one deadline and the caller's stop. Task sub-agents
 * (task.ts) share this runner's model, deadline and cost machinery under the
 * opposite contract: the model starts them and they use tools.
 */

const TIMEOUT_MS = 120_000;

/** The JSON object in a reply, however the model dressed it. */
export function readJsonReply(text: string): unknown {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON in the reply");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Runs one internal sub-agent call: on the internal sub-agent model, and if that
 * fails, once on `main`. Both attempts share one deadline (null for none) and stop
 * with the caller's signal; `fallback` can refuse the second attempt for an error.
 */
export async function runInternalAgent<T>(main: ModelRef, attempt: (modelRef: ModelRef, signal: AbortSignal | undefined) => Promise<T>,
  options: { timeoutMs?: number | null; signal?: AbortSignal; source?: CallSource; fallback?: (error: unknown) => boolean } = {}): Promise<T> {
  const deadline = options.timeoutMs === null ? null : Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  const run = (modelRef: ModelRef) => {
    options.signal?.throwIfAborted();
    const remaining = deadline === null ? null : deadline - Date.now();
    if (remaining !== null && remaining <= 0) throw new Error("The time for this call ran out");
    const timer = remaining === null ? undefined : AbortSignal.timeout(remaining);
    const signal = timer && options.signal ? AbortSignal.any([options.signal, timer]) : timer ?? options.signal;
    return withModelCallSource(options.source ?? "tool", () => attempt(modelRef, signal));
  };
  const chosen = await internalAgentModel(main);
  try { return await run(chosen); }
  catch (error) {
    options.signal?.throwIfAborted();
    if (modelRefKey(chosen) === modelRefKey(main) || options.fallback?.(error) === false) throw error;
    return run(main);
  }
}

/** An internal sub-agent that answers in text, read by `read`; a reply that did not complete counts as a failure. */
export async function askInternalAgent<T>(main: ModelRef, request: { system: string; prompt: string; read: (text: string) => T }, options: { timeoutMs?: number; source?: CallSource } = {}): Promise<T> {
  return runInternalAgent(main, async (modelRef, signal) => {
    const preferences = await getModelPreferences();
    const result = await generateText({ model: getChatModel(modelRef, { reasoning: preferences.thinking }), system: request.system, prompt: request.prompt, maxRetries: 0, abortSignal: signal });
    if (result.finishReason !== "stop") throw new Error("The reply did not complete");
    return request.read(result.text);
  }, { timeoutMs: options.timeoutMs ?? TIMEOUT_MS, source: options.source });
}
