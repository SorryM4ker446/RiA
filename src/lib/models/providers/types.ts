import type { EmbeddingModel, ImageModel, LanguageModel } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { Experimental_VideoModelV3 } from "@ai-sdk/provider";
import type { LibraryMode, ProviderId } from "@/lib/models/preferences-schema";

// The AI SDK names these by version rather than a stable alias. Deriving the
// versioned shape keeps a provider adapter typed without pinning the
// application to one provider's idea of a model object.
export type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
export type ImageModelV3 = Extract<ImageModel, { specificationVersion: "v3" }>;
export type EmbeddingModelV3 = Extract<EmbeddingModel, { specificationVersion: "v3" }>;

/** Whether the model should reason before answering, and how hard. */
export type ReasoningPreference = { enabled: boolean; effort: "low" | "high" | "max" | null };

/** A model as the provider's own catalog describes it, before the user adds it. */
export type CatalogModel = {
  providerId: ProviderId;
  modelId: string;
  name: string;
  description: string;
  modes: LibraryMode[];
  /**
   * What this application can actually do with the model. It is deliberately
   * not the same question as what the provider offers: a model can accept
   * images upstream while the adapter here has no verified encoding for them,
   * and claiming otherwise would surface the gap as a failed request.
   */
  supportsImageInput: boolean;
  /** What the provider's own catalog claims, kept for comparison. */
  providerSupportsImageInput?: boolean;
  endpointImageInput: boolean | null;
  supportsTools: boolean;
  /** The provider runs its own web search for this model, at extra cost. */
  providerSearch: boolean;
  contextLength: number | null;
  pricing: Record<string, string>;
};

/**
 * Why a catalog could not be read. Carried as a reason rather than a message so
 * the interface can tell "the provider is briefly unreachable" apart from "the
 * stored credential was rejected" — they look identical in a raw fetch and call
 * for different user action. Messages are built once, in the interface
 * language, where the provider and mode names are known.
 */
export type CatalogFailureReason =
  | "http"
  | "unauthorized"
  | "timeout"
  | "tooLarge"
  | "empty"
  | "notJson"
  | "invalidShape"
  | "emptyCatalog"
  | "network";

export class CatalogFetchError extends Error {
  constructor(readonly reason: CatalogFailureReason, readonly detail?: string) {
    super(detail ?? reason);
  }
}

/**
 * The one seam a provider has to satisfy.
 *
 * Everything above this file identifies a model by `{ providerId, modelId }` and
 * never reads a provider's own conventions: the library, the defaults, the
 * leases and the usage log all key on that pair. Everything below it is a
 * single provider's protocol. Adding a provider means writing one adapter and
 * adding its id to `providerIds`; no call path changes.
 *
 * Authorization is deliberately not part of this interface. The lease that
 * checks library membership is applied in `ai/client.ts` around whichever
 * provider model comes back, so a new adapter cannot forget it.
 *
 * Not a plugin platform: providers are registered from static code at import
 * time, and an unregistered id cannot be stored in the library at all.
 */
export type ModelProvider = {
  id: ProviderId;
  displayName: string;
  /** Shape a catalog row id must have before it can be trusted for this provider. */
  isTrustedModelId: (value: unknown) => boolean;
  /**
   * The library modes this provider can serve at all. A provider with no image
   * endpoint declares that here, so the page and the selectors never offer a
   * mode that would fail at call time.
   */
  offeredModes: LibraryMode[];
  /** Whether this instance holds the credentials the provider needs. */
  isConfigured: () => boolean;
  /**
   * Translates the workspace's reasoning preference into this provider's own
   * request options. Absent when the provider has no notion of it, which is
   * what keeps the preference from being guessed at by the call sites.
   */
  reasoningOptions?: (preference: ReasoningPreference) => SharedV3ProviderOptions | undefined;
  /** Reads one mode's catalog. Throws `CatalogFetchError`, never a raw fetch error. */
  fetchCatalog: (mode: LibraryMode, signal: AbortSignal) => Promise<{ models: CatalogModel[]; invalidRows: number }>;
  createChatModel: (modelId: string) => LanguageModelV3;
  /** A mode the provider does not offer must refuse loudly rather than pretend. */
  createImageModel?: (modelId: string) => ImageModelV3;
  createVideoModel?: (modelId: string) => Experimental_VideoModelV3;
  createEmbeddingModel?: (modelId: string) => EmbeddingModelV3;
  /** Capability a single endpoint has that the catalog row cannot express. */
  probeImageInput?: (modelId: string) => Promise<boolean | null>;
};
