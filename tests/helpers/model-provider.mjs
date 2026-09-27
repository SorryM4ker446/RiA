import { MockEmbeddingModelV3, MockLanguageModelV3, MockImageModelV3 } from "ai/test";

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
export const languageModel = new MockLanguageModelV3({
  doStream: async () => ({
    stream: new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({ type: "text-delta", id: "text-1", delta: "Generated answer" });
        if (providerState.streamGate) await providerState.streamGate;
        if (providerState.streamError) controller.enqueue({ type: "error", error: new Error("Simulated upstream failure") });
        controller.enqueue({ type: "text-end", id: "text-1" });
        controller.enqueue({ type: "finish", finishReason: { unified: providerState.streamError ? "error" : "stop", raw: undefined }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } });
        controller.close();
      },
    }),
  }),
});
const embeddingModel = new MockEmbeddingModelV3({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0, 0]), warnings: [] }) });
export const getChatModel = () => languageModel;
export const getEmbeddingModel = () => embeddingModel;
const defaultImageModelId = "google/gemini-2.5-flash-image";
let imageLeaseModelId = defaultImageModelId;
let imageModelValidator;
async function withProviderModelLease(mode, modelId, operation) {
  const { withModelLease } = await import("@/lib/models/preferences");
  return withModelLease(mode, modelId, operation);
}
function withProviderVideoLease(modelId, operation) {
  return withProviderModelLease("video", modelId, operation);
}
const imageModel = new MockImageModelV3({ doGenerate: async (options) => {
  const modelId = imageLeaseModelId;
  const validate = imageModelValidator;
  return withProviderModelLease("image", modelId, async model => {
    validate?.(model);
    providerState.imageEntered?.(); providerState.imageEntered = undefined;
    if (providerState.imageGate) await providerState.imageGate;
    providerState.imageCalls.push(options);
    return { images: [testPng], warnings: [], response: { timestamp: new Date(), modelId: "mock-image", headers: {} } };
  });
} });
const defaultVideoModelId = "google/veo-3.1-fast";
let videoLeaseModelId = defaultVideoModelId;
const videoModel = { specificationVersion: "v3", provider: "mock-provider", modelId: "mock-video", maxVideosPerCall: 1, doGenerate: async (options) => {
  const modelId = videoLeaseModelId;
  return withProviderVideoLease(modelId, async () => {
    providerState.videoCalls.push(options);
    return { videos: [{ type: "binary", data: testVideo, mediaType: "video/mp4" }], warnings: [], response: { timestamp: new Date(), modelId: "mock-video", headers: {} } };
  });
} };
export const getImageModel = (modelId = defaultImageModelId, validate) => { imageLeaseModelId = modelId; imageModelValidator = validate; return imageModel; };
export const getVideoModel = (modelId = defaultVideoModelId) => { videoLeaseModelId = modelId; return videoModel; };
