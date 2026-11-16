import { t, tf } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { getModelProvider } from "@/lib/models/providers";

/*
 * What a model provider's refusal means for the person, wherever the call was
 * made: a conversation, indexing documents, generating an image. Only a status
 * that waiting cannot change gets its own message: telling someone whose key
 * was revoked to "try again later" sends them back to the same failure.
 * Statuses follow DeepSeek's and OpenRouter's documented error codes.
 */

/** Where the person fixes a failure, carried in an error's `details.fix` for the page to offer. */
export type ProviderFix = "apiKeys" | "models";

/** The HTTP status a provider answered with, looking through the wrappers the SDK puts around it. */
export function providerStatusOf(error: unknown): number | undefined {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 4; depth++) {
    const status = (cause as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
    cause = (cause as { lastError?: unknown; cause?: unknown }).lastError ?? (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A provider's display name for a call's provider id, when it is one RiA knows. */
export function providerNameOf(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  try { return getModelProvider(providerId).displayName; } catch { return undefined; }
}

export function describeProviderStatus(status: unknown, providerName?: string): ApiError {
  const provider = providerName ?? t("lib.chat.providerGeneric");
  // Payment required is what DeepSeek and OpenRouter both answer when an account has run out.
  if (status === 402) return new ApiError({ code: "UPSTREAM_FAILED", message: providerName ? tf("lib.chat.providerOutOfBalanceNamed", { provider: providerName }) : t("lib.chat.providerOutOfBalance") });
  // A missing or revoked key. The page offers the way to the key from `fix`.
  if (status === 401) return new ApiError({ code: "CONFIGURATION_ERROR", message: tf("lib.chat.providerKeyRejected", { provider }), details: { fix: "apiKeys" satisfies ProviderFix } });
  // OpenRouter answers 403 for moderation as well as for access, so it names both.
  if (status === 403) return new ApiError({ code: "UPSTREAM_FAILED", message: tf("lib.chat.providerRefused", { provider }) });
  // The model id is unknown to the provider: delisted, or not offered to this account.
  if (status === 404) return new ApiError({ code: "CONFIGURATION_ERROR", message: tf("lib.chat.providerModelMissing", { provider }), details: { fix: "models" satisfies ProviderFix } });
  // Still limited after the retries the call already made.
  if (status === 429) return new ApiError({ code: "UPSTREAM_FAILED", message: tf("lib.chat.providerRateLimited", { provider }) });
  return new ApiError({ code: "UPSTREAM_FAILED", message: t("lib.chat.providerUnavailable") });
}

/**
 * A failure from a model call as the person should read it. One that already
 * says what it is (an ApiError, a timeout) is kept; a provider's refusal is
 * read by its status; anything else is the service being unavailable.
 */
export function describeProviderFailure(error: unknown, providerName?: string): Error {
  if (error instanceof ApiError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) return error;
  return describeProviderStatus(providerStatusOf(error), providerName);
}
