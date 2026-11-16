import { generateText } from "ai";
import { getChatModel } from "@/lib/ai/client";
import { withModelCallSource } from "@/lib/models/call-context";
import { auxiliaryModel, getModelPreferences } from "@/lib/models/preferences";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";

const TIMEOUT_MS = 120_000;

/** The JSON object in a reply, however the model dressed it. */
export function readJsonReply(text: string): unknown {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON in the reply");
  return JSON.parse(text.slice(start, end + 1));
}

/** Work around a turn (memory, approval reviews): the auxiliary model when one is chosen, and if it fails, the main one. */
export async function askAuxiliaryModel<T>(main: ModelRef, request: { system: string; prompt: string; read: (text: string) => T }, options: { timeoutMs?: number } = {}): Promise<T> {
  // One deadline for both attempts: a fallback to the main model does not get a fresh one.
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  const ask = async (modelRef: ModelRef) => {
    const preferences = await getModelPreferences();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("The time for this call ran out");
    const result = await withModelCallSource("tool", () => generateText({ model: getChatModel(modelRef, { reasoning: preferences.thinking }), system: request.system, prompt: request.prompt, maxRetries: 0, abortSignal: AbortSignal.timeout(remaining) }));
    if (result.finishReason !== "stop") throw new Error("The reply did not complete");
    return request.read(result.text);
  };
  const chosen = await auxiliaryModel(main);
  try { return await ask(chosen); }
  catch (error) {
    if (modelRefKey(chosen) === modelRefKey(main)) throw error;
    return ask(main);
  }
}
