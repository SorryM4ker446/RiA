import { MockEmbeddingModelV3, MockLanguageModelV3, MockImageModelV3 } from "ai/test";

export const providerState = { streamError: false, streamGate: undefined, imageCalls: [], videoCalls: [] };
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
const imageModel = new MockImageModelV3({ doGenerate: async (options) => {
  providerState.imageCalls.push(options);
  return { images: [testPng], warnings: [], response: { timestamp: new Date(), modelId: "mock-image", headers: {} } };
} });
const videoModel = { specificationVersion: "v3", provider: "mock-provider", modelId: "mock-video", maxVideosPerCall: 1, doGenerate: async (options) => {
  providerState.videoCalls.push(options);
  return { videos: [{ type: "binary", data: testVideo, mediaType: "video/mp4" }], warnings: [], response: { timestamp: new Date(), modelId: "mock-video", headers: {} } };
} };
export const getImageModel = () => imageModel;
export const getVideoModel = () => videoModel;
