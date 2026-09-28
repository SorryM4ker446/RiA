import { MockEmbeddingModelV3, MockLanguageModelV3, MockImageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { LibraryMode, ModelLibraryItem, ModelRef } from "@/lib/models/preferences-schema";

export const providerState = { streamError: false, streamGate: undefined, imageGate: undefined, imageEntered: undefined, imageCalls: [], videoCalls: [] };
export function resetProviderState() {
  providerState.streamError = false;
  providerState.streamGate = undefined;
  providerState.imageGate = undefined;
  providerState.imageEntered = undefined;
  providerState.imageCalls.length = 0;
  providerState.videoCalls.length = 0;
}
export const testPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=", "base64");
export const testVideo = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
/** The prompt rendered as plain text, so an echoed answer is readable. */
function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) return prompt.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
    }
    return JSON.stringify(message);
  }).join(String.fromCharCode(10));
  return JSON.stringify(prompt);
}

export const languageModel = new MockLanguageModelV3({
  // Non-streaming answers too: summarisation and the auxiliary synthesis calls
  // use doGenerate, and a mock that only streams would make every one of them
  // look like a failure.
  // Echoes the prompt. A fixed string would make every synthesis test pass
  // whether or not the real path ran, because the answer would look the same
  // as the fallback; echoing shows what was actually handed to the model.
  doGenerate: async (options): Promise<LanguageModelV3GenerateResult> => ({
    content: [{ type: "text", text: promptText(options.prompt) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
  }),
  doStream: async () => ({
    stream: new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({ type: "text-delta", id: "text-1", delta: "Generated answer" });
        if (providerState.streamGate) await providerState.streamGate;
        if (providerState.streamError) controller.enqueue({ type: "error", error: new Error("Simulated upstream failure") });
        controller.enqueue({ type: "text-end", id: "text-1" });
        controller.enqueue({ type: "finish", finishReason: { unified: providerState.streamError ? "error" : "stop", raw: undefined }, usage: { inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: undefined, reasoning: undefined } } });
        controller.close();
      },
    }),
  }),
});
const embeddingModel = new MockEmbeddingModelV3({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0, 0]), warnings: [] }) });
export const getChatModel = () => languageModel;
export const getEmbeddingModel = () => embeddingModel;
// Provider calls take a lease on the exact model they will reach, so the mock
// holds the same provider-qualified reference the request carried.
const defaultImageModelRef: ModelRef = { providerId: "openrouter", modelId: "google/gemini-2.5-flash-image" };
let imageLeaseRef = defaultImageModelRef;
let imageModelValidator;
async function withProviderModelLease<T>(mode: LibraryMode, ref: ModelRef, operation: (model: ModelLibraryItem) => PromiseLike<T> | T) {
  const { withModelLease } = await import("@/lib/models/preferences");
  return withModelLease(mode, ref, operation);
}
function withProviderVideoLease(ref, operation) {
  return withProviderModelLease("video", ref, operation);
}
const imageModel = new MockImageModelV3({ doGenerate: async (options) => {
  const ref = imageLeaseRef;
  const validate = imageModelValidator;
  return withProviderModelLease("image", ref, async model => {
    validate?.(model);
    providerState.imageEntered?.(); providerState.imageEntered = undefined;
    if (providerState.imageGate) await providerState.imageGate;
    providerState.imageCalls.push(options);
    return { images: [testPng], warnings: [], response: { timestamp: new Date(), modelId: "mock-image", headers: {} } };
  });
} });
const defaultVideoModelRef = { providerId: "openrouter", modelId: "google/veo-3.1-fast" };
let videoLeaseRef = defaultVideoModelRef;
const videoModel = { specificationVersion: "v3", provider: "mock-provider", modelId: "mock-video", maxVideosPerCall: 1, doGenerate: async (options) => {
  const ref = videoLeaseRef;
  return withProviderVideoLease(ref, async () => {
    providerState.videoCalls.push(options);
    return { videos: [{ type: "binary", data: testVideo, mediaType: "video/mp4" }], warnings: [], response: { timestamp: new Date(), modelId: "mock-video", headers: {} } };
  });
} };
export const getImageModel = (ref = defaultImageModelRef, validate = undefined) => { imageLeaseRef = ref; imageModelValidator = validate; return imageModel; };
export const getVideoModel = (ref = defaultVideoModelRef) => { videoLeaseRef = ref; return videoModel; };
