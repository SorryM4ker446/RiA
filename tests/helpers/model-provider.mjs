import { MockEmbeddingModelV3, MockLanguageModelV3 } from "ai/test";

export const providerState = { streamError: false, streamGate: undefined };
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
const embeddingModel = new MockEmbeddingModelV3({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0, 0]) }) });
export const getChatModel = () => languageModel;
export const getEmbeddingModel = () => embeddingModel;
