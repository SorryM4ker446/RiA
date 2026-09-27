import { t } from "@/lib/locale";

/** Accept both JSON responses and the serialized error text used by AI SDK streams. */
export function getApiErrorMessage(payload: unknown, fallback = t("lib.error.fallback")): string {
  if (typeof payload === "string") {
    try { return getApiErrorMessage(JSON.parse(payload), fallback); }
    catch { return payload || fallback; }
  }
  if (!payload || typeof payload !== "object" || !("error" in payload)) return fallback;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return fallback;
  if ("code" in error && error.code === "RATE_LIMITED" && "details" in error && error.details && typeof error.details === "object" && "retryAfterSeconds" in error.details && typeof error.details.retryAfterSeconds === "number") {
    return `${error.message}${t("lib.error.retryAfterOpen")}${Math.max(1, Math.ceil(error.details.retryAfterSeconds))}${t("lib.error.retryAfterClose")}`;
  }
  if ("code" in error && error.code === "CONFLICT") return `${error.message}${t("lib.error.conflictHint")}`;
  return error.message;
}
